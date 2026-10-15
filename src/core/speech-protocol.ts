import {asrSession,isStreaming,speechUrl,type SpeechSettings,type SpeechUsage} from './speech';
export type SpeechEvent={kind:'ready'|'failed'|'warning'|'finished'}|{kind:'usage';usage:SpeechUsage}|{kind:'transcript';itemId:string;text:string;preview:string;final:boolean;beginMs?:number;endMs?:number};
export interface SpeechProtocol {url:string;start:unknown;finish:unknown;audio:(pcm:Uint8Array)=>Uint8Array|Record<string,unknown>;parse:(data:any)=>SpeechEvent[]}
const nonnegative=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=1e12;
function usage(value:any):SpeechEvent[]{if(!value||!nonnegative(value.input_tokens)||!nonnegative(value.output_tokens))return [];return [{kind:'usage',usage:{inputTokens:value.input_tokens,outputTokens:value.output_tokens,totalTokens:value.input_tokens+value.output_tokens}}];}
export function speechProtocol(s:SpeechSettings,taskId=crypto.randomUUID()):SpeechProtocol{
  if(!isStreaming(s.model))return {url:speechUrl(s.endpoint,s.model),start:asrSession(s),finish:{type:'session.finish',event_id:crypto.randomUUID()},audio:pcm=>{
    let binary='';for(const v of pcm)binary+=String.fromCharCode(v);return {type:'input_audio_buffer.append',event_id:crypto.randomUUID(),audio:btoa(binary)};
  },parse:data=>{
    if(data?.type==='session.updated')return [{kind:'ready'}];if(data?.type==='error')return [{kind:'failed'}];if(data?.type==='session.finished')return [{kind:'finished'}];if(data?.type==='conversation.item.input_audio_transcription.failed')return [{kind:'warning'}];
    const final=data?.type==='conversation.item.input_audio_transcription.completed';if(!final&&data?.type!=='conversation.item.input_audio_transcription.text')return [];
    const text=final?data.transcript:data.text;if(typeof text!=='string')return [];return [{kind:'transcript',itemId:String(data.item_id??'').slice(0,100),text:text.slice(-2000),preview:final?'':String(data.stash??'').slice(0,2000),final}];
  }};
  const header={task_id:taskId,streaming:'duplex'};
  return {url:speechUrl(s.endpoint,s.model),start:{header:{...header,action:'run-task'},payload:{task_group:'audio',task:'asr',function:'recognition',model:s.model,parameters:{format:'pcm',sample_rate:16000,heartbeat:true,max_sentence_silence:600,...(s.language==='auto'?{}:{language_hints:[s.language]})},input:s.context?{context:[{role:'user',content:[{type:'input_text',text:s.context}]}]}:{}}},finish:{header:{...header,action:'finish-task'},payload:{input:{}}},audio:pcm=>pcm,parse:data=>{
    if(data?.header?.task_id!==taskId)return [];
    const type=data.header.event;if(type==='task-started')return [{kind:'ready'}];if(type==='task-failed')return [{kind:'failed'}];
    const events=usage(data.payload?.usage);if(type==='task-finished')return [...events,{kind:'finished'}];if(type!=='result-generated')return [];
    const sentence=data.payload?.output?.sentence;if(!sentence||sentence.heartbeat===true||!nonnegative(sentence.sentence_id)||sentence.sentence_id<1||typeof sentence.text!=='string')return events;
    const final=sentence.sentence_end===true,full=sentence.text.slice(0,2000);
    // Intermediate snapshots can be revised. Only an explicitly fixed word prefix is safe to translate early.
    let fixed='';if(!final&&Array.isArray(sentence.words)){for(const word of sentence.words.slice(0,500)){if(word?.fixed!==true||typeof word.text!=='string')break;fixed+=word.text+(typeof word.punctuation==='string'?word.punctuation:'');if(fixed.length>2000)break;}}
    if(!full.startsWith(fixed))fixed='';const text=final?full:fixed,preview=final?'':full.slice(fixed.length);
    events.push({kind:'transcript',itemId:`${taskId}:${sentence.sentence_id}`,text,preview,final,...(nonnegative(sentence.begin_time)?{beginMs:sentence.begin_time}:{}),...(nonnegative(sentence.end_time)&&sentence.end_time>=sentence.begin_time?{endMs:sentence.end_time}:{})});return events;
  }};
}
