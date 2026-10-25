import {test} from 'node:test';import assert from 'node:assert/strict';
import {DEFAULT_SPEECH,STREAMING_MODEL,normalizeSpeech,validateSpeech,speechAuthRule,speechUrl} from '../src/core/speech.ts';
import {speechProtocol} from '../src/core/speech-protocol.ts';
import {AudioClock} from '../src/core/audio-clock.ts';
const streaming={...DEFAULT_SPEECH,model:STREAMING_MODEL,endpoint:'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',context:'番組のゲストは山田太郎です。'};
const result=(sentence:any,usage?:any)=>({header:{task_id:'task',event:'result-generated'},payload:{output:{sentence},usage}});
test('Both ASR families normalize paths without changing region, workspace, key or model selection',()=>{
  const old=normalizeSpeech({...streaming,model:DEFAULT_SPEECH.model});assert.ok(old.endpoint.endsWith('/realtime'));assert.equal(old.context,streaming.context);assert.equal(old.model,DEFAULT_SPEECH.model);
  assert.equal(normalizeSpeech({...old,model:STREAMING_MODEL}).endpoint,streaming.endpoint);assert.equal(normalizeSpeech(DEFAULT_SPEECH).endpoint,DEFAULT_SPEECH.endpoint);
  assert.throws(()=>normalizeSpeech({...DEFAULT_SPEECH,model:STREAMING_MODEL}),/Workspace ID/);assert.throws(()=>validateSpeech({...streaming,context:'あ'.repeat(401)}),/400/);
  for(const endpoint of ['wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference?api_key=secret','wss://workspace.cn-beijing.maas.aliyuncs.com/other','wss://workspace.cn-beijing.maas.aliyuncs.com.evil.example/api-ws/v1/inference'])assert.throws(()=>normalizeSpeech({...streaming,endpoint}));
});
test('Streaming URL and exact initiator-scoped auth have no model or key query string',()=>{
  const rule=speechAuthRule(streaming.endpoint,streaming.model,'test-key','self');assert.equal(rule.condition.urlFilter,`|${streaming.endpoint}|`);assert.deepEqual(rule.condition.initiatorDomains,['self']);
  assert.equal(speechUrl(streaming.endpoint,streaming.model),streaming.endpoint);assert.match(speechUrl(DEFAULT_SPEECH.endpoint,DEFAULT_SPEECH.model),/\?model=qwen3-asr-flash-realtime$/);
});
test('Streaming uses run-task, Japanese hints, bounded context, binary PCM and finish-task',()=>{
  const p=speechProtocol(streaming,'task'),start=p.start as any;assert.equal(start.header.action,'run-task');assert.equal(start.payload.model,STREAMING_MODEL);assert.deepEqual(start.payload.parameters.language_hints,['ja']);assert.equal(start.payload.parameters.sample_rate,16000);assert.equal(start.payload.parameters.heartbeat,true);assert.equal(start.payload.input.context[0].content[0].text,streaming.context);
  const pcm=new Uint8Array([0,127]);assert.equal(p.audio(pcm),pcm);assert.equal((p.finish as any).header.task_id,'task');assert.equal((p.finish as any).header.action,'finish-task');assert.ok(!('language_hints' in (speechProtocol({...streaming,language:'auto'}).start as any).payload.parameters));
});
test('Streaming snapshots translate only fixed word prefixes or final results and retain timestamps',()=>{
  const p=speechProtocol(streaming,'task');const a=p.parse(result({sentence_id:3,text:'今日は晴れです。',sentence_end:false,begin_time:100,end_time:null,words:[{text:'今日は',fixed:true},{text:'晴れです。',fixed:false}]}))[0];
  assert.equal(a.kind,'transcript');if(a.kind==='transcript'){assert.equal(a.text,'今日は');assert.equal(a.preview,'晴れです。');assert.equal(a.beginMs,100);assert.equal(a.endMs,undefined);}
  const b=p.parse(result({sentence_id:3,text:'今日は雨です。',sentence_end:true,begin_time:100,end_time:1800}))[0];assert.equal(b.kind,'transcript');if(b.kind==='transcript'){assert.equal(b.text,'今日は雨です。');assert.equal(b.itemId,'task:3');assert.equal(b.endMs,1800);}
  const draft=p.parse(result({sentence_id:4,text:'未確認の長い途中結果です。',sentence_end:false}))[0];assert.equal(draft.kind==='transcript'&&draft.text,'');
});
test('Task IDs, heartbeats, missing IDs and malformed usage never create accidental captions',()=>{
  const p=speechProtocol(streaming,'task');assert.deepEqual(p.parse({header:{task_id:'old-task',event:'task-failed'}}),[]);assert.deepEqual(p.parse(result({sentence_id:0,heartbeat:true,text:'ignore'})),[]);assert.deepEqual(p.parse(result({text:'missing ID'})),[]);
  assert.deepEqual(p.parse(result({heartbeat:true},{input_tokens:85,output_tokens:6})),[{kind:'usage',usage:{inputTokens:85,outputTokens:6,totalTokens:91}}]);assert.deepEqual(p.parse(result({heartbeat:true},{input_tokens:-1,output_tokens:6})),[]);
  assert.deepEqual(p.parse({header:{task_id:'task',event:'task-failed',error_message:'secret'}}),[{kind:'failed'}]);
});
test('Legacy protocol preserves base64 PCM and confirmed text / draft semantics',()=>{
  const p=speechProtocol(DEFAULT_SPEECH),frame=p.audio(new Uint8Array([1,2])) as any;assert.equal(frame.type,'input_audio_buffer.append');assert.equal(frame.audio,'AQI=');assert.equal((p.start as any).type,'session.update');
  assert.deepEqual(p.parse({type:'conversation.item.input_audio_transcription.text',item_id:'one',text:'確認済',stash:'草稿'}),[{kind:'transcript',itemId:'one',text:'確認済',preview:'草稿',final:false}]);
});
test('Legacy speech_stopped audio_end_ms is kept for that item and can map to an uploaded frame',()=>{
  const p=speechProtocol(DEFAULT_SPEECH);
  assert.deepEqual(p.parse({type:'input_audio_buffer.speech_stopped',audio_end_ms:150,item_id:'one'}),[]);
  assert.deepEqual(p.parse({type:'input_audio_buffer.speech_stopped',audio_end_ms:-1,item_id:'bad'}),[]);
  assert.deepEqual(p.parse({type:'input_audio_buffer.speech_stopped',audio_end_ms:150}),[]);
  const partial=p.parse({type:'conversation.item.input_audio_transcription.text',item_id:'one',text:'確認済',stash:'草稿'})[0];
  assert.equal(partial.kind,'transcript');if(partial.kind==='transcript')assert.equal(partial.audioEndMs,150);
  const done=p.parse({type:'conversation.item.input_audio_transcription.completed',item_id:'one',transcript:'確認済です。'})[0];
  assert.equal(done.kind,'transcript');if(done.kind==='transcript')assert.equal(done.audioEndMs,150);
  const other=p.parse({type:'conversation.item.input_audio_transcription.completed',item_id:'two',transcript:'別件'})[0];
  assert.equal(other.kind,'transcript');if(other.kind==='transcript')assert.equal(other.audioEndMs,undefined);
  const direct=p.parse({type:'conversation.item.input_audio_transcription.completed',item_id:'three',transcript:'直接',audio_end_ms:1800})[0];
  assert.equal(direct.kind,'transcript');if(direct.kind==='transcript')assert.equal(direct.audioEndMs,1800);
  const clock=new AudioClock();clock.upload(1600,1100);clock.upload(1600,1200);
  if(done.kind==='transcript')assert.equal(clock.endAt(done.audioEndMs??-1),1150);
  assert.deepEqual(speechProtocol(DEFAULT_SPEECH).parse({type:'conversation.item.input_audio_transcription.completed',item_id:'one',transcript:'無関係'}),[{kind:'transcript',itemId:'one',text:'無関係',preview:'',final:true}]);
});
