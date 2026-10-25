import {test} from 'node:test';import assert from 'node:assert/strict';
import {DEFAULT_SPEECH,validateSpeech,speechEndpoint,speechAuthRule,asrSession,pcm16} from '../src/core/speech.ts';
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
test('Qwen ASR configuration uses PCM 16k, Japanese, vocabulary and bounded VAD latency',()=>{const s=asrSession({...DEFAULT_SPEECH,context:'番組名'});assert.equal(s.session.sample_rate,16000);assert.equal(s.session.input_audio_transcription.language,'ja');assert.equal(s.session.input_audio_transcription.corpus?.text,'番組名');assert.equal(s.session.turn_detection.silence_duration_ms,600);assert.ok(!('language' in asrSession({...DEFAULT_SPEECH,language:'auto'}).session.input_audio_transcription));});
