export interface SpeechSettings {endpoint:string;apiKey:string;model:string;language:'ja'|'en'|'zh'|'auto';context:string}
export interface SpeechUsage {inputTokens:number;outputTokens:number;totalTokens:number}
export interface SpeechStatus {state:'idle'|'connecting'|'active'|'stopped'|'error';sessionId:string;tabId:number;message:string;seconds:number;sentBytes:number;hasAudio:boolean;completed:number;lastSource:string;lastTranslation:string;asrUsage?:SpeechUsage;sourceTime?:{beginMs:number;endMs?:number};timing?:{queueMs:number;translationMs:number;textToCaptionMs:number}}
export const STREAMING_MODEL='qwen-audio-3.1-asr-flash-streaming';
export const isStreaming=(model:string)=>model===STREAMING_MODEL;
export const DEFAULT_SPEECH:SpeechSettings={endpoint:'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',apiKey:'',model:'qwen3-asr-flash-realtime',language:'ja',context:''};
export const IDLE_SPEECH:SpeechStatus={state:'idle',sessionId:'',tabId:-1,message:'无需网站字幕，直接识别当前标签页声音。',seconds:0,sentBytes:0,hasAudio:false,completed:0,lastSource:'',lastTranslation:''};
const SPEECH_STATES=['idle','connecting','active','stopped','error'] as const;
export function isSpeechStatus(value:unknown):value is SpeechStatus{
  if(!value||typeof value!=='object')return false;
  const s=value as SpeechStatus;
  return (SPEECH_STATES as readonly string[]).includes(s.state)&&typeof s.sessionId==='string'&&typeof s.tabId==='number'&&Number.isFinite(s.tabId)&&typeof s.message==='string'&&typeof s.seconds==='number'&&Number.isFinite(s.seconds)&&s.seconds>=0&&typeof s.sentBytes==='number'&&Number.isFinite(s.sentBytes)&&s.sentBytes>=0&&typeof s.hasAudio==='boolean'&&typeof s.completed==='number'&&Number.isFinite(s.completed)&&s.completed>=0&&typeof s.lastSource==='string'&&typeof s.lastTranslation==='string';
}
export function speechStatusOrIdle(value:unknown):SpeechStatus{return isSpeechStatus(value)?{...value}:{...IDLE_SPEECH};}
export function speechEndpoint(value:string){
  const u=new URL(value);const local=u.protocol==='ws:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  const allowed=['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com'].includes(u.hostname)||/^[a-zA-Z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(u.hostname);
  if((!local&&(u.protocol!=='wss:'||!allowed))||u.username||u.password||u.search||u.hash||!['/api-ws/v1/realtime','/api-ws/v1/inference'].includes(u.pathname))throw new Error('请使用百炼北京、新加坡或业务空间的语音接口地址。');return u.href;
}
export function speechUrl(endpoint:string,model:string){const u=new URL(speechEndpoint(endpoint));u.pathname=isStreaming(model)?'/api-ws/v1/inference':'/api-ws/v1/realtime';if(!isStreaming(model))u.searchParams.set('model',model);return u.href;}
export function normalizeSpeech(s:SpeechSettings):SpeechSettings{if(!s||typeof s.endpoint!=='string')throw new Error('语音识别配置无效。');const url=new URL(speechUrl(s.endpoint,s.model));url.search='';const next={...s,endpoint:url.href};validateSpeech(next);return next;}
export function validateSpeech(s:SpeechSettings){
  if(!s||typeof s.endpoint!=='string'||s.endpoint.length>512||typeof s.apiKey!=='string'||s.apiKey.length>512||/[\r\n]/.test(s.apiKey)||(!isStreaming(s.model)&&!/^qwen3-asr-flash-realtime(?:-\d{4}-\d{2}-\d{2})?$/.test(s.model))||!['ja','en','zh','auto'].includes(s.language)||typeof s.context!=='string'||s.context.length>2000)throw new Error('语音识别配置无效。');const url=new URL(speechEndpoint(s.endpoint));
  if(url.pathname!==(isStreaming(s.model)?'/api-ws/v1/inference':'/api-ws/v1/realtime'))throw new Error('语音服务地址与识别模型不匹配。');
  if(isStreaming(s.model)){
    if(['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com'].includes(url.hostname))throw new Error('3.1 Streaming 需要业务空间专属地址。请填写对应地域的 Workspace ID，或粘贴完整业务空间地址。');
    if(s.context.length>400)throw new Error('3.1 Streaming 的术语上下文最多 400 字，请缩短后保存。');
  }
}
export function asrSession(s:SpeechSettings){return {type:'session.update',event_id:crypto.randomUUID(),session:{input_audio_format:'pcm',sample_rate:16000,input_audio_transcription:{...(s.language==='auto'?{}:{language:s.language}),...(s.context?{corpus:{text:s.context}}:{})},turn_detection:{type:'server_vad',threshold:0.2,silence_duration_ms:600}}};}
export function speechAuthRule(endpoint:string,model:string,key:string,extensionId:string):chrome.declarativeNetRequest.Rule {
  const url=new URL(speechUrl(endpoint,model));
  return {id:891,priority:1,condition:{urlFilter:`|${url.href}|`,isUrlFilterCaseSensitive:true,initiatorDomains:[extensionId],resourceTypes:['websocket' as chrome.declarativeNetRequest.ResourceType]},action:{type:'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,requestHeaders:[{header:'Authorization',operation:'set' as chrome.declarativeNetRequest.HeaderOperation,value:`Bearer ${key}`}]}};
}
export function pcm16(samples:Float32Array){const bytes=new Uint8Array(samples.length*2),view=new DataView(bytes.buffer);for(let i=0;i<samples.length;i++){const x=Math.max(-1,Math.min(1,samples[i]));view.setInt16(i*2,Math.round(x*(x<0?32768:32767)),true);}return bytes;}
