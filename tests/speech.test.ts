import {test} from 'node:test';import assert from 'node:assert/strict';
import {DEFAULT_SPEECH,DEFAULT_VAD_SILENCE_MS,IDLE_SPEECH,validateSpeech,normalizeSpeech,speechEndpoint,speechAuthRule,asrSession,pcm16,isSpeechStatus,speechStatusOrIdle,type SpeechSettings} from '../src/core/speech.ts';
import {PAUSE_SCROLL_NOTE,PAUSE_SCROLL_POPUP_NOTE,STREAM_OFF_WARNING,liveInterruptHint} from '../src/core/live-hints.ts';
test('speech settings default to Japanese and reject arbitrary or credential-bearing remote endpoints',()=>{validateSpeech(DEFAULT_SPEECH);assert.equal(DEFAULT_SPEECH.language,'ja');for(const endpoint of ['wss://evil.example/api-ws/v1/realtime','wss://dashscope.aliyuncs.com.evil.example/api-ws/v1/realtime','wss://user:pass@dashscope.aliyuncs.com/api-ws/v1/realtime','wss://dashscope.aliyuncs.com/api-ws/v1/realtime?api_key=secret'])assert.throws(()=>speechEndpoint(endpoint));assert.throws(()=>validateSpeech({...DEFAULT_SPEECH,apiKey:'a\r\nb'}));});
test('speech authentication applies only to the exact websocket URL and this extension initiator',()=>{const rule=speechAuthRule(DEFAULT_SPEECH.endpoint,DEFAULT_SPEECH.model,'placeholder','extension-id');assert.deepEqual(rule.condition.initiatorDomains,['extension-id']);assert.deepEqual(rule.condition.resourceTypes,['websocket']);assert.ok(rule.condition.urlFilter?.endsWith('|'));assert.ok(!rule.condition.urlFilter?.includes('placeholder'));});
test('PCM16 is signed little endian, clipped, and exactly two bytes per mono sample',()=>{const data=pcm16(new Float32Array([-2,-1,0,1,2]));const view=new DataView(data.buffer);assert.deepEqual(Array.from({length:5},(_,i)=>view.getInt16(i*2,true)),[-32768,-32768,0,32767,32767]);assert.equal(data.length,10);});
test('live speech safeguards keep restart, pause-billing and stream-off copy short and distinct',()=>{
  const hints=['seek','video','refresh','leave','other'].map(liveInterruptHint);
  for(const hint of hints){assert.match(hint,/开始实时翻译/);assert.ok(hint.length<=40);}
  assert.equal(new Set(hints).size,5);
  assert.match(PAUSE_SCROLL_NOTE,/采集/);assert.match(PAUSE_SCROLL_NOTE,/计费/);assert.ok(PAUSE_SCROLL_NOTE.length<=16);
  assert.match(PAUSE_SCROLL_POPUP_NOTE,/不会停止采集和计费/);
  assert.match(STREAM_OFF_WARNING,/流式响应/);assert.match(STREAM_OFF_WARNING,/延迟/);
});
test('Qwen ASR configuration uses PCM 16k, Japanese, vocabulary and bounded VAD latency',()=>{const s=asrSession({...DEFAULT_SPEECH,context:'番組名'});assert.equal(s.session.sample_rate,16000);assert.equal(s.session.input_audio_transcription.language,'ja');assert.equal(s.session.input_audio_transcription.corpus?.text,'番組名');assert.equal(DEFAULT_SPEECH.silenceDurationMs,DEFAULT_VAD_SILENCE_MS);assert.deepEqual(s.session.turn_detection,{type:'server_vad',threshold:0.2,silence_duration_ms:600});assert.ok(!('language' in asrSession({...DEFAULT_SPEECH,language:'auto'}).session.input_audio_transcription));});
test('VAD silence stays on 600 ms unless the saved tier is 400 or 800',()=>{
  const legacy={...DEFAULT_SPEECH} as SpeechSettings & {silenceDurationMs?:unknown};
  delete legacy.silenceDurationMs;
  assert.equal(normalizeSpeech(legacy).silenceDurationMs,600);
  assert.equal(asrSession(normalizeSpeech(legacy)).session.turn_detection.silence_duration_ms,600);
  assert.equal(normalizeSpeech({...DEFAULT_SPEECH,silenceDurationMs:'800' as unknown as SpeechSettings['silenceDurationMs']}).silenceDurationMs,800);
  for(const ms of [400,600,800] as const){
    const saved=normalizeSpeech({...DEFAULT_SPEECH,silenceDurationMs:ms});
    assert.equal(saved.silenceDurationMs,ms);
    assert.equal(asrSession(saved).session.turn_detection.silence_duration_ms,ms);
    assert.equal(asrSession(saved).session.turn_detection.threshold,0.2);
  }
  for(const bad of [0,200,500,1000,true,'fast','600ms'])assert.throws(()=>normalizeSpeech({...DEFAULT_SPEECH,silenceDurationMs:bad as SpeechSettings['silenceDurationMs']}),/语音识别配置无效/);
  assert.throws(()=>validateSpeech({...DEFAULT_SPEECH,silenceDurationMs:500 as SpeechSettings['silenceDurationMs']}),/语音识别配置无效/);
});
test('empty speech replies become idle and a live session is copied unchanged',()=>{
  const active={...IDLE_SPEECH,state:'active' as const,sessionId:'abc',tabId:3,message:'已连接，等待标签页声音。',seconds:4,completed:2,lastSource:'你好',lastTranslation:'hello',asrUsage:{inputTokens:10,outputTokens:2,totalTokens:12},timing:{queueMs:8,translationMs:40,textToCaptionMs:48}};
  assert.equal(isSpeechStatus(active),true);
  const copy=speechStatusOrIdle(active);
  assert.deepEqual(copy,active);assert.notEqual(copy,active);copy.message='changed';assert.equal(active.message,'已连接，等待标签页声音。');
  for(const empty of [undefined,null,false,true,0,'',{},{state:'active'},{...active,message:1},{...active,seconds:-1}]){
    const status=speechStatusOrIdle(empty);
    assert.equal(status.state,'idle');assert.equal(status.message,IDLE_SPEECH.message);assert.equal(status.tabId,-1);assert.equal(status.completed,0);
  }
});
