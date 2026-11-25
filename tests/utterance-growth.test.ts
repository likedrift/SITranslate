import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Utterances,UTTERANCE_CHUNK_CHARS,UTTERANCE_TAIL_HOLD_MS,type SpeechPiece} from '../src/core/utterances.ts';

const texts=(pieces:SpeechPiece[])=>pieces.map(p=>p.text);
const prefix='今日は新しいゲームについて紹介します';
const suffix='続いて操作方法も説明します。';
function translatedTail(){
  const u=new Utterances();u.update('same',prefix,false,0);const first=u.flush(UTTERANCE_TAIL_HOLD_MS);
  assert.deepEqual(texts(first),[prefix]);u.confirm(first[0].id,first[0].text);return {u,first};
}

test('a timed tail already translated is not included in the later complete snapshot',()=>{
  const {u,first}=translatedTail(),next=u.update('same',prefix+suffix,true,2600);
  assert.deepEqual(texts(next),[suffix]);assert.notEqual(next[0].id,first[0].id);assert.ok(next[0].order>first[0].order);assert.equal(next[0].context,prefix);
  assert.deepEqual(u.update('same',prefix+suffix,true,2800),[]);
});
test('growing snapshots cannot enlarge an emitted tail even while its translation is pending',()=>{
  const u=new Utterances();u.update('pending',prefix,false,0);const first=u.flush(UTTERANCE_TAIL_HOLD_MS);
  const next=u.update('pending',prefix+suffix,true,1800);assert.deepEqual(texts(next),[suffix]);assert.notEqual(next[0].id,first[0].id);
});
test('successive timed tails and later punctuation are emitted exactly once',()=>{
  const u=new Utterances(),a='あいうえおかきくけこさしすせそた',b='ちつてとなにぬねのはひふへほまみ',c='むめもやゆよらりるれろわをんあい';
  u.update('same',a,false,0);const first=u.flush(UTTERANCE_TAIL_HOLD_MS);u.confirm(first[0].id,first[0].text);
  assert.deepEqual(u.update('same',a+b,false,UTTERANCE_TAIL_HOLD_MS+100),[]);assert.equal(u.nextTailFlushAt(),UTTERANCE_TAIL_HOLD_MS*2);
  const second=u.flush(UTTERANCE_TAIL_HOLD_MS*2);assert.deepEqual(texts(second),[b]);u.confirm(second[0].id,second[0].text);
  const third=u.update('same',a+b+c+'。',true,UTTERANCE_TAIL_HOLD_MS*3);assert.deepEqual(texts(third),[c+'。']);
  assert.equal([...first,...second,...third].map(p=>p.text).join(''),a+b+c+'。');
  assert.equal(u.nextTailFlushAt(),undefined);
});
test('late punctuation and resegmentation do not resurrect completed captions',()=>{
  const {u}=translatedTail();assert.deepEqual(u.update('same',prefix+'。',true,1000),[]);
  const comma=translatedTail();assert.deepEqual(texts(comma.u.update('same',prefix+'、'+suffix,true,1000)),[suffix]);
  const v=new Utterances();const old=v.update('punct','最初の説明です。続きの説明です。',false,0);old.forEach(p=>v.confirm(p.id,p.text));
  assert.deepEqual(texts(v.update('punct','最初の説明です、続きの説明です。新しい説明です。',true,1000)),['新しい説明です。']);
});
test('insertions, deletions and Unicode corrections move consumed boundaries without repeating the prefix',()=>{
  for(const [before,corrected] of [['今日は晴れです。','今日はとても晴れです。'],['今日はとても晴れです。','今日は晴れです。'],['猫の話です。','犬の話です。'],['😀猫の話です。','😀小さな猫の話です。'],['最初です。次です。','初めです。次です。']]){
    const u=new Utterances(),first=u.update('edit',before,true,0);first.forEach(p=>u.confirm(p.id,p.text));
    const next=u.update('edit',corrected+suffix,true,1000);assert.deepEqual(texts(next),[suffix],before+' -> '+corrected);assert.equal(next[0].context,corrected);
  }
});
test('a queued correction keeps its ID, but an already displayed correction cannot join new speech',()=>{
  const u=new Utterances(),old=u.update('revision','甲。',true,0),revision=u.update('revision','甲乙。',true,10);
  assert.equal(revision[0].id,old[0].id);assert.deepEqual(texts(revision),['甲乙。']);
  u.confirm(revision[0].id,revision[0].text);
  assert.deepEqual(texts(u.update('revision','甲乙丙。次の話です。',true,20)),['次の話です。']);
  const numbers=new Utterances();numbers.update('number','値は1.2です。',true,0);
  assert.deepEqual(texts(numbers.update('number','値は12です。',true,10)),['値は12です。']);
});
test('long cumulative snapshots cross chunk limits without reflowing the earlier tail',()=>{
  const {u,first}=translatedTail(),rest='新しい操作方法を説明します、'.repeat(8)+'完了です。';
  const next=u.update('same',prefix+rest,true,1800);
  assert.equal(texts(next).join(''),rest);assert.ok(next.every(p=>Array.from(p.text).length<=UTTERANCE_CHUNK_CHARS));assert.ok(next.every(p=>p.id!==first[0].id));
});
test('missing or shorter intermediate stable prefixes cannot replay already translated words',()=>{
  const {u}=translatedTail();assert.deepEqual(u.update('same','',false,900),[]);assert.deepEqual(u.update('same',prefix.slice(0,5),false,1000),[]);
  assert.deepEqual(texts(u.update('same',prefix+suffix,true,1600)),[suffix]);
  for(let i=0;i<80;i++)u.update(`draft-${i}`,'',false,2000+i);assert.equal(u.size,32);
});
test('identical words spoken in a new utterance remain translatable; reset clears consumed boundaries',()=>{
  const {u}=translatedTail();assert.deepEqual(texts(u.update('other',prefix,true,900)),[prefix]);u.reset();assert.deepEqual(texts(u.update('same',prefix,true,1000)),[prefix]);
});
