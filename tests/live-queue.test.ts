import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LIVE_MERGE_CHARS,LIVE_MERGE_SPAN_MS,LIVE_MERGED_CHARS,LIVE_QUEUE_LIMIT,enqueuePiece,pieceParts,pieceTraceIds,type SpeechPiece} from '../src/core/utterances.ts';

const piece=(id:string,order:number,text:string,at=0,extra:Partial<SpeechPiece>={}):SpeechPiece=>({id,order,text,final:true,at,...extra});
function legacyEnqueue(queue:SpeechPiece[],item:SpeechPiece){
  const next=[...queue];const index=next.findIndex(entry=>entry.id===item.id);
  if(index>=0)next[index]=item;else next.push(item);
  next.sort((a,b)=>a.order-b.order);return next.slice(-LIVE_QUEUE_LIMIT);
}
function push(queue:SpeechPiece[],item:SpeechPiece){return enqueuePiece(queue,item);}
function retained(queue:SpeechPiece[]){return queue.flatMap(item=>pieceParts(item).map(part=>part.text)).join('');}

test('adjacent short fragments merge in order and keep text the old queue would drop',()=>{
  assert.equal(LIVE_MERGE_CHARS,36);assert.equal(LIVE_MERGED_CHARS,72);assert.equal(LIVE_MERGE_SPAN_MS,3000);
  const burst=Array.from({length:8},(_,i)=>piece(`s${i}`,i,`短${i}。`,1000));
  let merged:SpeechPiece[]=[],legacy:SpeechPiece[]=[];
  for(const item of burst){merged=push(merged,item);legacy=legacyEnqueue(legacy,item);}
  assert.equal(merged.length,1);
  assert.equal(retained(merged),burst.map(item=>item.text).join(''));
  assert.ok(retained(merged).length>legacy.map(item=>item.text).join('').length);
  assert.equal(legacy.some(item=>item.text==='短0。'),false);
  assert.equal(merged[0].text.startsWith('短0。'),true);
  assert.equal(merged[0].text.endsWith('短7。'),true);
  assert.ok(merged[0].text.indexOf('短0。')<merged[0].text.indexOf('短7。'));
  assert.equal(merged[0].order,7);
  assert.equal(merged[0].at,1000);
  assert.equal(merged[0].parts?.length,8);
});

test('arrival order does not change subtitle order, and one long line blocks the merge',()=>{
  let queue=push([],piece('b',2,'後。'));
  queue=push(queue,piece('a',1,'先。',0,{context:'前文'}));
  assert.equal(queue.length,1);assert.equal(queue[0].text,'先。後。');assert.equal(queue[0].context,'前文');assert.equal(queue[0].order,2);
  const barrier='あ'.repeat(LIVE_MERGE_CHARS+1);
  queue=[];
  for(const item of [piece('a',1,'はい。'),piece('b',2,barrier),piece('c',3,'ええ。')])queue=push(queue,item);
  assert.deepEqual(queue.map(item=>item.text),['はい。',barrier,'ええ。']);
  assert.equal(queue.every(item=>item.parts===undefined),true);
});

test('a revision replaces one fragment inside a merged group',()=>{
  let queue=push([],piece('a',1,'はい。',10,{traceId:'t1',context:'前',sourceEndAt:1}));
  queue=push(queue,piece('b',2,'ええ。',20,{traceId:'t2',context:'はい。',sourceEndAt:5,final:false}));
  assert.equal(queue.length,1);
  assert.equal(queue[0].text,'はい。ええ。');
  assert.equal(queue[0].at,10);assert.equal(queue[0].order,2);assert.equal(queue[0].final,false);assert.equal(queue[0].sourceEndAt,5);
  assert.deepEqual(pieceTraceIds(queue[0]),['t1','t2']);
  queue=push(queue,piece('a',1,'はいよ。',30,{traceId:'t3',context:'前'}));
  assert.equal(queue.length,1);assert.equal(queue[0].text,'はいよ。ええ。');
  assert.deepEqual(pieceTraceIds(queue[0]),['t3','t2']);
  assert.equal(queue[0].parts?.map(part=>part.id).join(','),'a,b');
});

test('fragments more than 3s apart stay separate, and an exact 3s span still merges',()=>{
  const close=push(push([],piece('a',1,'はい。',0)),piece('b',2,'ええ。',LIVE_MERGE_SPAN_MS));
  assert.equal(close.length,1);assert.equal(close[0].at,0);assert.equal(close[0].text,'はい。ええ。');
  const far=push(push([],piece('a',1,'はい。',0)),piece('b',2,'ええ。',LIVE_MERGE_SPAN_MS+1));
  assert.deepEqual(far.map(item=>item.text),['はい。','ええ。']);
});

test('queue overflow drops the oldest merged groups and keeps the newer text in order',()=>{
  const items=Array.from({length:10},(_,i)=>piece(`p${i}`,i,`${i}${'あ'.repeat(LIVE_MERGE_CHARS-1)}`,i));
  let queue:SpeechPiece[]=[];
  for(const item of items)queue=push(queue,item);
  assert.equal(queue.length,LIVE_QUEUE_LIMIT);
  assert.equal(queue.every(item=>item.parts?.length===2),true);
  assert.equal(retained(queue),items.slice(4).map(item=>item.text).join(''));
  assert.equal(retained(queue).includes(items[0].text),false);assert.equal(retained(queue).includes(items[3].text),false);assert.equal(retained(queue).includes(items[4].text),true);
  assert.deepEqual(queue.map(item=>item.order),[5,7,9]);
  const latin=push(push([],piece('en-a',1,'Hello')),piece('en-b',2,'world'));
  assert.equal(latin[0].text,'Hello world');
});
