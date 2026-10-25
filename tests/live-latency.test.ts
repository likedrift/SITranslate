import {test} from 'node:test';import assert from 'node:assert/strict';
import {streamSegment} from '../src/core/stream-text.ts';
import {LiveReader,readingMs,type LiveCaption} from '../src/core/live-reader.ts';
import {AudioClock} from '../src/core/audio-clock.ts';
import {SpeechDiagnostics,diagnosticSettings} from '../src/core/speech-diagnostics.ts';
const prefix='{"segments":[{"id":"live","text":"';
test('Incremental translation decoding exposes real text before final JSON and handles escapes across chunks',()=>{
  assert.equal(streamSegment(prefix+'你','live'),'你');assert.equal(streamSegment(prefix+'你好\\n世','live'),'你好\n世');assert.equal(streamSegment(prefix+'你\\u4f','live'),'你');assert.equal(streamSegment(prefix+'你\\u4f60\\uD83D','live'),'你你');assert.equal(streamSegment(prefix+'\\uD83D\\uDE00','live'),'😀');
  assert.equal(streamSegment(prefix+'a\\\\','live'),'a\\');assert.equal(streamSegment(prefix+'a\\','live'),'a');assert.equal(streamSegment(prefix+'a\\"b','live'),'a"b');assert.equal(streamSegment('{"segments":[{"text":"译文","id":"live"}]}','live'),'译文');
});
test('Progress never treats reasoning, wrong segment IDs, scaffolding or oversized text as a translation',()=>{
  for(const raw of ['reasoning '+prefix+'bad',prefix.replace('live','other')+'bad','{"segments":[{"id":"live",',prefix+'x'.repeat(501),prefix+'a\\q'])assert.equal(streamSegment(raw,'live',500),undefined);
});
const cue=(id:string,text=id,final=true,at=0):LiveCaption=>({id,version:id,source:'source',text,final,arrivedAt:at,traceId:id});
test('Reading buffer gives the current caption time, then retains its completed predecessor',()=>{
  const r=new LiveReader();r.receive(cue('one','第一句字幕。'),0);r.receive(cue('two','第二句字幕。'),100);assert.equal(r.current?.id,'one');r.tick(1499);assert.equal(r.current?.id,'one');r.tick(readingMs('第一句字幕。'));assert.equal(r.current?.id,'two');assert.equal(r.previous?.id,'one');
});
test('Stream updates extend one caption, final text gets a reading grace, and explicit live mode has no buffer delay',()=>{
  const r=new LiveReader();r.receive(cue('one','半',false,0),0);r.receive(cue('one','半句话',false,100),100);assert.equal(r.items.length,1);assert.equal(r.current?.arrivedAt,0);r.receive(cue('one','完整的一句话',true,700),700);r.receive(cue('two'),800);r.tick(1000);assert.equal(r.current?.id,'one');r.tick(1500);assert.equal(r.current?.id,'two');r.receive(cue('three'),1600,'live');assert.equal(r.current?.id,'three');
});
test('Pause and review never stop incoming translations or allow unbounded history / pending captions',()=>{
  const r=new LiveReader();r.receive(cue('0'),0);r.paused=true;for(let i=1;i<30;i++)r.receive(cue(String(i)),i);assert.equal(r.current?.id,'0');assert.ok(r.items.length<=8);assert.equal(r.pending,3);assert.ok(r.dropped.length>0);r.latest(10000);assert.equal(r.current?.id,'29');r.back(10001);assert.equal(r.current?.id,'28');assert.ok(r.paused);r.forward(10002);assert.equal(r.current?.id,'29');
});
test('Rejected provisional text is withdrawn while the previous completed translation remains available',()=>{
  const r=new LiveReader();r.receive(cue('good'),0);r.receive(cue('bad','partial',false),2000,'live');r.withdraw('bad','bad',2100);assert.ok(!r.items.some(c=>c.id==='bad'));assert.equal(r.current?.id,'good');
  r.receive({...cue('good','failed revision',false),version:'revision'},2200);r.withdraw('good','revision',2300);assert.equal(r.current?.text,'good');assert.equal(r.current?.final,true);
});
test('Reading grace is bounded and stale pending captions cannot turn into a long live backlog',()=>{
  const r=new LiveReader();r.receive(cue('one','长'.repeat(100)),0);r.receive(cue('two','second',true,100),100);r.tick(2599);assert.equal(r.current?.id,'one');r.tick(2600);assert.equal(r.current?.id,'two');
  const delayed=new LiveReader();delayed.receive(cue('current','长'.repeat(100)),0);delayed.paused=true;delayed.receive(cue('old','old',true,100),100);delayed.receive(cue('fresh','fresh',true,5000),5000);delayed.paused=false;delayed.tick(6000);assert.equal(delayed.current?.id,'fresh');assert.ok(delayed.dropped.some(c=>c.id==='old'));
});
test('ASR clock maps server timestamps to uploaded audio metadata and resets at reconnect',()=>{
  const c=new AudioClock();c.upload(1600,1100);c.upload(1600,1200);assert.equal(c.endAt(150),1150);assert.equal(c.endAt(250),undefined);assert.equal(c.endAt(NaN),undefined);c.reset();assert.equal(c.endAt(150),undefined);for(let i=0;i<400;i++)c.upload(1600,10000+i*100);assert.equal(c.endAt(1),undefined);
});
test('Local diagnostics keep at most 100 numeric samples, exclude unknown metrics, and compute measured percentiles',()=>{
  const d=new SpeechDiagnostics();for(let i=0;i<120;i++)d.add({id:String(i),createdAt:i,sourceChars:20,firstTextMs:i*10});const report=d.report();assert.equal(report.samples,100);assert.equal(report.metrics.firstTextMs.samples,100);assert.equal(report.metrics.firstTextMs.p50,690);assert.equal(report.metrics.firstTextMs.p95,1140);assert.ok(!report.metrics.asrMs);assert.equal(report.outcomes.pending,100);assert.ok(!JSON.stringify(report).includes('sourceText'));d.clear();assert.equal(d.report().samples,0);
});
test('Diagnostic reports count outcomes and comparison settings omit secrets and addresses',()=>{
  const d=new SpeechDiagnostics();d.add({id:'a',createdAt:1,sourceChars:4,outcome:'completed',asrMs:120});d.add({id:'b',createdAt:2,sourceChars:4,outcome:'stale'});d.add({id:'c',createdAt:3,sourceChars:4});
  const report=d.report();assert.equal(report.schema,2);assert.deepEqual(report.outcomes,{completed:1,failed:0,stale:1,skipped:0,cancelled:0,pending:1});assert.equal(report.metrics.asrMs.samples,1);
  const settings=diagnosticSettings({asrModel:'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',language:'ja',textModel:'deepseek-flash',textStream:false,readingMode:'live',target:'zh-Hans'});
  assert.equal(settings.asrModel,undefined);assert.equal(settings.language,'ja');assert.equal(settings.textModel,'deepseek-flash');assert.equal(settings.textStream,false);assert.equal(settings.readingMode,'live');assert.equal(settings.target,'zh-Hans');
  assert.equal(diagnosticSettings({asrModel:'qwen3-asr-flash-realtime',language:'ja',textModel:'https://evil.example/model',readingMode:'fast',target:'not a language'}).textModel,undefined);
  assert.ok(!JSON.stringify(settings).includes('dashscope'));
});
