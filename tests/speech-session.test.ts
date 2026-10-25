import {describe,test} from 'node:test';import assert from 'node:assert/strict';
import {createSpeechController} from '../src/speech-background.ts';
import {DEFAULT_SPEECH,IDLE_SPEECH} from '../src/core/speech.ts';
import {LiveReader} from '../src/core/live-reader.ts';
import type {TranslationInput,TranslationObserver,TranslationResult} from '../src/core/types.ts';

const extension='chrome-extension://ext/';
function installChrome(session:Record<string,unknown>,local:Record<string,unknown>,captions:unknown[]){
  (globalThis as {chrome?:unknown}).chrome={
    runtime:{id:'ext',getURL:(path:string)=>extension+path,getManifest:()=>({version:'0.7.0'}),getContexts:async()=>[{contextType:'OFFSCREEN_DOCUMENT'}],ContextType:{OFFSCREEN_DOCUMENT:'OFFSCREEN_DOCUMENT'}},
    storage:{session:{get:async()=>session,set:async(value:object)=>Object.assign(session,value)},local:{get:async(keys:string|string[])=>{const out:Record<string,unknown>={};for(const key of Array.isArray(keys)?keys:[keys])if(key in local)out[key]=local[key];return out;},set:async(value:object)=>Object.assign(local,value)}},
    tabs:{sendMessage:async(_id:number,message:unknown)=>{captions.push(message);},onRemoved:{addListener(){}},onUpdated:{addListener(){}}},
  };
}
const offscreen={id:'ext',url:extension+'offscreen.html'},ui={id:'ext',url:extension+'popup.html',tab:{id:7}};
function activeSession(){
  return {speechState:{...IDLE_SPEECH,state:'active',sessionId:'sess',tabId:7,message:'正在识别并翻译标签页声音。',seconds:3,sentBytes:3200,hasAudio:true},speechConfig:{profileId:'p',profileName:'DeepSeek',target:'zh-Hans',display:'replace',includeContext:false,maxPageChars:100000,dynamic:true,ready:true}};
}

describe('live translation session',{concurrency:1},()=>{
  test('A streamed translation that finishes after the segment is older than 15s withdraws 生成中 so the reader can advance',async()=>{
    const captions:Record<string,unknown>[]=[],session=activeSession();
    const local={speechSettings:{...DEFAULT_SPEECH,apiKey:'secret-speech-key',context:'山田太郎'},settings:{version:1,activeProfileId:'p',target:'zh-Hans',profiles:[{id:'p',model:'deepseek-flash',stream:true,baseUrl:'https://api.deepseek.com',apiKey:'secret-text-key'}]},captionLayout:{readingMode:'balanced'}};
    installChrome(session,local,captions);
    const realNow=Date.now;let now=1_700_000_000_000;Date.now=()=>now;
    const jobs:Promise<TranslationResult>[]=[];
    try{
      const translate=(input:TranslationInput,_tab:number,observer?:TranslationObserver)=>{
        const text=input.blocks[0].segments[0].text;
        const job=(async()=>{
          observer?.start?.(true);observer?.text?.(text.startsWith('迟到')?'暂定译文':'后续译文');
          await Promise.resolve();
          if(text.startsWith('迟到'))now+=16_000;
          return {segments:[{id:'live',text:text.startsWith('迟到')?'过期完整译文':'后续译文'}],cached:false,usage:{input:1,output:1,estimatedCost:0}};
        })();
        jobs.push(job);return job;
      };
      const speech=createSpeechController({ready:Promise.resolve(),config:async()=>session.speechConfig as never,translate,cancel(){}});
      const transcript=(itemId:string,text:string)=>({type:'speech:transcript',sessionId:'sess',itemId,text,preview:'',final:true,receivedAt:now});
      await speech.route(transcript('late-item','迟到一句。'),offscreen);await Promise.all(jobs.splice(0));
      await speech.route(transcript('next-item','后续一句。'),offscreen);await Promise.all(jobs.splice(0));
      const reader=new LiveReader();let t=now;
      for(const message of captions){
        t+=100;
        if(message.failed){reader.withdraw(String(message.pieceId??''),String(message.version??''),t);continue;}
        if(message.preview||typeof message.translation!=='string')continue;
        reader.receive({id:String(message.pieceId??''),version:String(message.version??''),source:String(message.source??''),text:message.translation,final:!message.partial,traceId:typeof message.traceId==='string'?message.traceId:undefined,arrivedAt:t},t);
      }
      reader.tick(t+30_000);
      assert.equal(reader.current?.text,'后续译文');assert.equal(reader.current?.final,true);
      assert.ok(!reader.items.some(item=>!item.final),'过期暂定译文必须撤回或收尾，不能把阅读器留在生成中');
      assert.ok(!captions.some(message=>message.translation==='过期完整译文'&&!message.partial));
      const report=await speech.route({type:'speech:diagnostics'},ui) as {rows:{outcome?:string;sourceChars:number}[];outcomes:Record<string,number>};
      assert.equal(report.rows.find(row=>row.sourceChars==='迟到一句。'.length)?.outcome,'stale');
      assert.ok(report.outcomes.stale>=1);assert.ok(report.outcomes.completed>=1);
    }finally{Date.now=realNow;}
  });
  test('Audio end timestamps survive later transcripts and the diagnostic export keeps outcome counts and settings',async()=>{
    const captions:Record<string,unknown>[]=[],session=activeSession();
    const local={speechSettings:{...DEFAULT_SPEECH,apiKey:'secret-speech-key',context:'山田太郎',endpoint:'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'},settings:{version:1,activeProfileId:'p',target:'zh-Hans',profiles:[{id:'p',model:'deepseek-flash',stream:true,baseUrl:'https://api.deepseek.com',apiKey:'secret-text-key'}]},captionLayout:{readingMode:'live'}};
    installChrome(session,local,captions);
    const jobs:Promise<TranslationResult>[]=[];
    const translate=(input:TranslationInput,_tab:number,observer?:TranslationObserver)=>{
      const job=(async()=>{observer?.start?.(true);observer?.text?.('译文');return {segments:[{id:'live',text:'译文：'+input.blocks[0].segments[0].text}],cached:false,usage:{input:1,output:1,estimatedCost:0}};})();
      jobs.push(job);return job;
    };
    const speech=createSpeechController({ready:Promise.resolve(),config:async()=>session.speechConfig as never,translate,cancel(){}});
    const page={id:'ext',url:extension+'video.html',tab:{id:7}};
    const receivedAt=Date.now(),sourceEndAt=receivedAt-420;
    await speech.route({type:'speech:transcript',sessionId:'sess',itemId:'timed',text:'短句。',preview:'',final:true,receivedAt,sourceEndAt,beginMs:0,endMs:420},offscreen);await Promise.all(jobs.splice(0));
    await speech.route({type:'speech:transcript',sessionId:'sess',itemId:'timed',text:'短句。再来一句。',preview:'',final:true,receivedAt:Date.now()},offscreen);await Promise.all(jobs.splice(0));
    const report=await speech.route({type:'speech:diagnostics'},ui) as {rows:{id:string;sourceChars:number;asrMs?:number;outcome?:string}[];outcomes:Record<string,number>;settings:Record<string,unknown>;policy:Record<string,number>;metrics:Record<string,{samples:number}>};
    assert.equal(report.rows.find(row=>row.sourceChars==='短句。'.length)?.asrMs,420);
    assert.equal(typeof report.rows.find(row=>row.sourceChars==='再来一句。'.length)?.asrMs,'number');
    assert.equal(report.outcomes.completed,2);
    assert.equal(report.settings.asrModel,'qwen3-asr-flash-realtime');assert.equal(report.settings.language,'ja');assert.equal(report.settings.textModel,'deepseek-flash');assert.equal(report.settings.textStream,true);assert.equal(report.settings.readingMode,'live');assert.equal(report.settings.target,'zh-Hans');
    assert.deepEqual(report.policy,{maxQueue:3,skipAfterMs:12000,expireAfterMs:15000,translationTimeoutMs:12000});
    const row=report.rows.find(item=>item.sourceChars==='短句。'.length)!;
    await speech.route({type:'speech:paint',sessionId:'sess',traceId:row.id,at:receivedAt+500,arrivedAt:receivedAt+20,sourceEndAt},page);
    const painted=await speech.route({type:'speech:diagnostics'},ui) as {metrics:{audioToPaintMs?:{samples:number;p50:number};asrMs?:{samples:number}}};
    assert.equal(painted.metrics.asrMs?.samples,2);assert.equal(painted.metrics.audioToPaintMs?.samples,1);assert.equal(painted.metrics.audioToPaintMs?.p50,920);
    const raw=JSON.stringify(report);
    for(const secret of ['secret-speech-key','secret-text-key','山田太郎','dashscope','https://','短句','再来一句','sourceEndAt'])assert.ok(!raw.includes(secret),secret);
  });
});
