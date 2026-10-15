import {test} from 'node:test';import assert from 'node:assert/strict';
import {DEFAULT_CAPTION,validateCaption,captionBounds,captionPages} from '../src/core/caption-layout.ts';
import {Utterances,enqueuePiece,type SpeechPiece} from '../src/core/utterances.ts';
test('Caption settings validate ranges and independent fullscreen positions',()=>{
  validateCaption({...DEFAULT_CAPTION,normal:{x:0,y:1},fullscreen:{x:1,y:0}});
  for(const patch of [{fontSize:NaN},{width:100},{opacity:0},{normal:{x:-1,y:0}},{fullscreen:null}])assert.throws(()=>validateCaption({...DEFAULT_CAPTION,...patch} as any));
});
test('Caption positions remain within anchor and scale with fullscreen and viewport resize',()=>{
  const rect={left:36,top:80,right:756,bottom:485,width:720,height:405},s={...DEFAULT_CAPTION,normal:{x:0,y:1},fullscreen:{x:1,y:0}};
  const b=captionBounds(rect,1280,720,s,100);assert.equal(b.left,44);assert.equal(b.top+100,477);assert.ok(b.left+b.width<=748);
  const full=captionBounds(rect,1280,720,s,100,true);assert.equal(full.top,108);assert.ok(full.left>b.left);
  const screen=captionBounds(rect,500,400,{...s,mode:'screen'},100);assert.equal(screen.left,8);assert.ok(screen.left+screen.width<=492);assert.equal(screen.top+100,392);
  const partial=captionBounds({...rect,top:680,bottom:1085},1280,720,s,140);assert.ok(partial.top+140<=712);
});
test('Long caption pagination preserves all Unicode characters and bounds each page',()=>{
  const text='日本語の説明です。'.repeat(20)+'😀これは最後です。',pages=captionPages(text,36);
  assert.equal(pages.join(''),text);assert.ok(pages.length>1);assert.ok(pages.every(p=>Array.from(p).length<=36));
});
test('Growing utterance translates completed prefixes once and emits only the new sentence',()=>{
  const u=new Utterances();assert.deepEqual(u.update('one','今日は',false,0),[]);
  const a=u.update('one','今日は晴れです。次に',false,100);assert.deepEqual(a.map(p=>p.text),['今日は晴れです。']);
  const b=u.update('one','今日は晴れです。次に番組を紹介します。',true,200);assert.deepEqual(b.map(p=>p.text),['次に番組を紹介します。']);assert.ok(b[0].order>a[0].order);
  assert.deepEqual(u.update('one','今日は晴れです。次に番組を紹介します。',true,300),[]);
  assert.deepEqual(u.update('one','古い途中結果',false,400),[]);
});
test('Long unpunctuated Japanese is bounded and confirmed tails flush after 800 ms',()=>{
  const u=new Utterances(),text='あいうえおかきくけこ'.repeat(13),a=u.update('one',text,false,0);assert.ok(a.length>=2);assert.ok(a.every(p=>Array.from(p.text).length<=48));
  assert.deepEqual(u.flush(799),[]);const b=u.flush(800);assert.equal(a.map(p=>p.text).join('')+b.map(p=>p.text).join(''),text);assert.deepEqual(u.flush(3000),[]);
});
test('Pending corrections replace the same piece, retain newest three, and preserve distinct identical utterances',()=>{
  const p=(id:string,order:number,text=id):SpeechPiece=>({id,order,text,final:true,at:0});let queue:SpeechPiece[]=[];
  queue=enqueuePiece(queue,p('one',0));queue=enqueuePiece(queue,p('one',0,'updated'));assert.equal(queue.length,1);assert.equal(queue[0].text,'updated');
  for(let i=1;i<5;i++)queue=enqueuePiece(queue,p(String(i),i));assert.deepEqual(queue.map(p=>p.order),[2,3,4]);
  const u=new Utterances();assert.notEqual(u.update('one','同じです。',true,0)[0].id,u.update('two','同じです。',true,1)[0].id);
});
test('Final correction does not replay older committed sentences',()=>{
  const u=new Utterances();u.update('one','最初です。次です。',false,0);
  const pieces=u.update('one','初めです。次です。最後です。',true,1);assert.ok(!pieces.some(p=>p.id==='one:0'));assert.ok(pieces.some(p=>p.text==='最後です。'));
});
test('Japanese quote endings stay with the sentence, context preserves previous clauses, and utterance ordering never overlaps',()=>{
  const u=new Utterances(),pieces=u.update('quote','「そうです。」続きです。',true,0);assert.deepEqual(pieces.map(p=>p.text),['「そうです。」','続きです。']);assert.equal(pieces[1].context,'「そうです。」');
  const many=u.update('many','短。'.repeat(200),true,1),next=u.update('next','次の発言です。',true,2);assert.ok(next[0].order>many.at(-1)!.order);
});
