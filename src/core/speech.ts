export interface SpeechSettings {endpoint:string;apiKey:string;model:string;language:'ja'|'en'|'zh'|'auto';context:string}
export interface SpeechStatus {state:'idle'|'connecting'|'active'|'stopped'|'error';sessionId:string;tabId:number;message:string;seconds:number;sentBytes:number;hasAudio:boolean;completed:number;lastSource:string;lastTranslation:string;timing?:{queueMs:number;translationMs:number;textToCaptionMs:number}}
export const DEFAULT_SPEECH:SpeechSettings={endpoint:'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',apiKey:'',model:'qwen3-asr-flash-realtime',language:'ja',context:''};
export const IDLE_SPEECH:SpeechStatus={state:'idle',sessionId:'',tabId:-1,message:'无需网站字幕，直接识别当前标签页声音。',seconds:0,sentBytes:0,hasAudio:false,completed:0,lastSource:'',lastTranslation:''};
export function speechEndpoint(value:string){
  const u=new URL(value);const local=u.protocol==='ws:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  const allowed=['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com'].includes(u.hostname)||/^[a-zA-Z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(u.hostname);
  if((!local&&(u.protocol!=='wss:'||!allowed))||u.username||u.password||u.search||u.hash||u.pathname!=='/api-ws/v1/realtime')throw new Error('请使用百炼北京、新加坡或业务空间的实时接口地址。');return u.href;
}
export function validateSpeech(s:SpeechSettings){
  if(!s||typeof s.endpoint!=='string'||s.endpoint.length>512||typeof s.apiKey!=='string'||s.apiKey.length>512||/[\r\n]/.test(s.apiKey)||!/^qwen3-asr-flash-realtime(?:-\d{4}-\d{2}-\d{2})?$/.test(s.model)||!['ja','en','zh','auto'].includes(s.language)||typeof s.context!=='string'||s.context.length>2000)throw new Error('语音识别配置无效。');speechEndpoint(s.endpoint);
}
export function asrSession(s:SpeechSettings){return {type:'session.update',event_id:crypto.randomUUID(),session:{input_audio_format:'pcm',sample_rate:16000,input_audio_transcription:{...(s.language==='auto'?{}:{language:s.language}),...(s.context?{corpus:{text:s.context}}:{})},turn_detection:{type:'server_vad',threshold:0.2,silence_duration_ms:600}}};}
export function speechAuthRule(endpoint:string,model:string,key:string,extensionId:string):chrome.declarativeNetRequest.Rule {
  const url=new URL(speechEndpoint(endpoint));url.searchParams.set('model',model);
  return {id:891,priority:1,condition:{urlFilter:`|${url.href}|`,isUrlFilterCaseSensitive:true,initiatorDomains:[extensionId],resourceTypes:['websocket' as chrome.declarativeNetRequest.ResourceType]},action:{type:'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,requestHeaders:[{header:'Authorization',operation:'set' as chrome.declarativeNetRequest.HeaderOperation,value:`Bearer ${key}`}]}};
}
export function pcm16(samples:Float32Array){const bytes=new Uint8Array(samples.length*2),view=new DataView(bytes.buffer);for(let i=0;i<samples.length;i++){const x=Math.max(-1,Math.min(1,samples[i]));view.setInt16(i*2,Math.round(x*(x<0?32768:32767)),true);}return bytes;}
