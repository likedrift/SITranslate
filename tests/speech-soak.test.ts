import {describe,test} from 'node:test';import assert from 'node:assert/strict';
import {createSpeechController,SPEECH_PERSIST_INTERVAL_MS} from '../src/speech-background.ts';
import {IDLE_SPEECH} from '../src/core/speech.ts';
import {LIVE_CONTEXT_CHARS} from '../src/core/live-translate.ts';
import type {TranslationInput,TranslationResult} from '../src/core/types.ts';

const extension='chrome-extension://ext/';
const offscreen={id:'ext',url:extension+'offscreen.html'};
const ui={id:'ext',url:extension+'popup.html',tab:{id:7}};
const page={id:'ext',url:extension+'video.html',tab:{id:7}};
const requested=Number(process.env.SITRANSLATE_SOAK_SECONDS);
const SOAK_SECONDS=Math.max(3600,Number.isFinite(requested)?Math.floor(requested):0);

function activeSession(){
  return {speechState:{...IDLE_SPEECH,state:'active',sessionId:'sess',tabId:7,message:'正在识别并翻译标签页声音。',seconds:3,sentBytes:3200,hasAudio:true},speechConfig:{profileId:'p',profileName:'DeepSeek',target:'zh-Hans',display:'replace',includeContext:false,maxPageChars:100000,dynamic:true,ready:true}};
}
function installChrome(session:Record<string,unknown>){
  let writes=0;
  (globalThis as {chrome?:unknown}).chrome={
    runtime:{id:'ext',getURL:(path:string)=>extension+path,getManifest:()=>({version:'0.7.0'}),sendMessage:async()=>({}),getContexts:async()=>[{contextType:'OFFSCREEN_DOCUMENT'}],ContextType:{OFFSCREEN_DOCUMENT:'OFFSCREEN_DOCUMENT'}},
    storage:{session:{get:async()=>session,set:async(value:Record<string,unknown>)=>{writes++;for(const [key,entry] of Object.entries(value))session[key]=structuredClone(entry);}},local:{get:async()=>({}),set:async()=>{}}},
    tabs:{sendMessage:async()=>{},onRemoved:{addListener(){}},onUpdated:{addListener(){}}},
    offscreen:{closeDocument:async()=>{}},
    declarativeNetRequest:{updateSessionRules:async()=>{}},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},
  };
  return {writes:()=>writes};
}
function installClock(start:number){
  const realNow=Date.now,realSetTimeout=globalThis.setTimeout,realClearTimeout=globalThis.clearTimeout;
  let now=start,seq=1;
  const pending=new Map<number,{at:number;fn:()=>void}>();
  Date.now=()=>now;
  globalThis.setTimeout=((fn:TimerHandler,ms?:number)=>{
    const id=seq++;
    pending.set(id,{at:now+Number(ms??0),fn(){if(typeof fn==='function')fn();}});
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout=((id?:ReturnType<typeof setTimeout>)=>{pending.delete(Number(id));}) as typeof clearTimeout;
  return {
    now:()=>now,
    pending:()=>pending.size,
    advance(ms:number){
      now+=ms;
      for(let guard=0;guard<8;guard++){
        const due=[...pending.entries()].filter(([,timer])=>timer.at<=now).sort((a,b)=>a[1].at-b[1].at);
        if(!due.length)return;
        for(const [id,timer] of due){if(!pending.has(id))continue;pending.delete(id);timer.fn();}
      }
    },
    restore(){Date.now=realNow;globalThis.setTimeout=realSetTimeout;globalThis.clearTimeout=realClearTimeout;}
  };
}
function translateOk(){
  const jobs:Promise<TranslationResult>[]=[];
  const translate=(input:TranslationInput)=>{
    const job=(async()=>({segments:[{id:'live',text:'译：'+input.blocks[0].segments[0].text}],cached:false,usage:{input:1,output:1,estimatedCost:0}}))();
    jobs.push(job);return job;
  };
  return {translate,jobs};
}
async function settle(jobs:Promise<unknown>[]){
  await Promise.all(jobs.splice(0));
  for(let i=0;i<20;i++)await Promise.resolve();
}
type Foot={diagnostics:number;sourceMeta:number;latest:number;translatedPieces:number;finalItems:number;utterances:number;utteranceEmitted:number;queue:number;contextChars:number};
function assertWithinCaps(foot:Foot){
  assert.ok(foot.diagnostics<=100);assert.ok(foot.sourceMeta<=32);assert.ok(foot.latest<=128);assert.ok(foot.translatedPieces<=128);
  assert.ok(foot.finalItems<=64);assert.ok(foot.utterances<=32);assert.ok(foot.utteranceEmitted<=32);assert.ok(foot.queue<=3);assert.ok(foot.contextChars<=LIVE_CONTEXT_CHARS);
}

describe('long speech session soak',{concurrency:1},()=>{
  test('health, finals and paint share a 15s snapshot while export stays current',async()=>{
    assert.equal(SPEECH_PERSIST_INTERVAL_MS,15_000);
    const session=activeSession() as Record<string,unknown>,storage=installChrome(session),clock=installClock(1_700_000_000_000);
    const {translate,jobs}=translateOk();
    const speech=createSpeechController({ready:Promise.resolve(),config:async()=>activeSession().speechConfig as never,translate,cancel(){}});
    const health=(seconds:number,total=seconds)=>speech.route({type:'speech:health',sessionId:'sess',seconds,sentBytes:seconds*320,hasAudio:true,asrUsage:{inputTokens:total,outputTokens:0,totalTokens:total}},offscreen);
    try{
      await health(1);
      assert.equal(storage.writes(),1);
      const stored=()=>session.speechState as {seconds:number;state:string;message:string;completed:number;sessionId:string;asrUsage?:{totalTokens:number}};
      const disk=()=>session.speechDiagnostics as {rows:{id:string;firstPaintMs?:number}[];counters:{asrEvents:number}};
      assert.equal(stored().seconds,1);assert.equal(disk().rows.length,0);assert.equal(stored().sessionId,'sess');
      clock.advance(1000);
      await speech.route({type:'speech:transcript',sessionId:'sess',itemId:'one',text:'一句完整的话。',preview:'',final:true,receivedAt:clock.now()},offscreen);
      await settle(jobs);
      const report=await speech.route({type:'speech:diagnostics'},ui) as {samples:number;rows:{id:string;firstPaintMs?:number;outcome?:string}[];counters:{asrEvents:number}};
      assert.equal(report.samples,1);assert.equal(report.rows[0].outcome,'completed');assert.equal(storage.writes(),1);assert.equal(disk().rows.length,0);
      await speech.route({type:'speech:paint',sessionId:'sess',traceId:report.rows[0].id,at:clock.now(),arrivedAt:clock.now(),sourceEndAt:clock.now()-80},page);
      const painted=await speech.route({type:'speech:diagnostics'},ui) as {rows:{id:string;firstPaintMs?:number}[]};
      assert.equal(typeof painted.rows[0].firstPaintMs,'number');assert.equal(storage.writes(),1);assert.equal(disk().rows.length,0);
      clock.advance(14_000);
      assert.equal(storage.writes(),1);
      await health(15,15);
      assert.equal(storage.writes(),2);assert.equal(stored().seconds,15);assert.equal(stored().asrUsage?.totalTokens,15);
      assert.equal(disk().rows.length,1);assert.equal(disk().rows[0].id,report.rows[0].id);assert.equal(typeof disk().rows[0].firstPaintMs,'number');
      assert.equal((session.speechConfig as {profileId:string;target:string}).profileId,'p');
      assert.equal((session.speechConfig as {target:string}).target,'zh-Hans');
      assert.deepEqual(Object.keys(session).sort(),['speechConfig','speechDiagnostics','speechState']);
      clock.advance(1000);
      assert.equal(await speech.route({type:'speech:diagnostics-clear'},ui),true);
      assert.equal(storage.writes(),3);assert.equal(disk().rows.length,0);assert.equal(disk().counters.asrEvents,0);
      await health(16,16);
      assert.equal(storage.writes(),3);
      const live=await speech.route({type:'speech:status'},ui) as {seconds:number;asrUsage:{totalTokens:number}};
      assert.equal(live.seconds,16);assert.equal(live.asrUsage.totalTokens,16);assert.equal(stored().seconds,15);
      const stopped=await speech.route({type:'speech:stop'},ui) as {state:string;seconds:number;asrUsage:{totalTokens:number};message:string};
      assert.equal(storage.writes(),4);assert.equal(stopped.state,'stopped');assert.equal(stored().state,'stopped');
      assert.equal(stored().seconds,16);assert.equal(stored().asrUsage?.totalTokens,16);assert.equal(disk().rows.length,0);
      for(const key of ['state','sessionId','tabId','message','seconds','sentBytes','hasAudio','completed','lastSource','lastTranslation','asrUsage'])assert.equal(key in stored(),true,key);
    }finally{clock.restore();}
  });

  test('a fake-clock hour keeps diagnostics and session maps capped and persists about once per 15s',async()=>{
    assert.equal(SPEECH_PERSIST_INTERVAL_MS,15_000);assert.equal(LIVE_CONTEXT_CHARS,300);
    const session=activeSession() as Record<string,unknown>,storage=installChrome(session),clock=installClock(1_700_000_000_000);
    const {translate,jobs}=translateOk();
    const speech=createSpeechController({ready:Promise.resolve(),config:async()=>activeSession().speechConfig as never,translate,cancel(){}});
    const disk=()=>session.speechDiagnostics as {rows:{id:string}[];counters:{asrEvents:number}};
    const state=()=>session.speechState as {seconds:number;state:string;sessionId:string;message:string;completed:number;lastSource:string;lastTranslation:string;sentBytes:number;hasAudio:boolean;tabId:number;asrUsage?:{inputTokens:number;outputTokens:number;totalTokens:number}};
    try{
      let finals=0;
      for(let sec=0;sec<SOAK_SECONDS;sec++){
        if(sec){assert.equal(clock.pending(),0);clock.advance(1000);}
        await speech.route({type:'speech:health',sessionId:'sess',seconds:sec,sentBytes:sec*320,hasAudio:true,asrUsage:{inputTokens:sec,outputTokens:1,totalTokens:sec+1}},offscreen);
        if(sec%4===0){
          finals++;
          await speech.route({type:'speech:transcript',sessionId:'sess',itemId:`item-${sec}`,text:`句${sec}。`,preview:'',final:true,receivedAt:clock.now()},offscreen);
          await settle(jobs);
          const report=await speech.route({type:'speech:diagnostics'},ui) as {rows:{id:string}[]};
          const row=report.rows.at(-1);
          assert.ok(row);
          await speech.route({type:'speech:paint',sessionId:'sess',traceId:row.id,at:clock.now(),arrivedAt:clock.now(),sourceEndAt:clock.now()-50},page);
        }
        if(sec%60===0)assertWithinCaps(speech.footprint());
      }
      const foot=speech.footprint();
      assert.equal(foot.diagnostics,100);assert.equal(foot.sourceMeta,32);assert.equal(foot.latest,128);assert.equal(foot.translatedPieces,128);
      assert.equal(foot.finalItems,64);assert.equal(foot.utterances,32);assert.equal(foot.utteranceEmitted,32);assert.equal(foot.queue,0);
      assert.ok(foot.contextChars>0);assert.ok(foot.contextChars<=300);
      const memory=await speech.route({type:'speech:diagnostics'},ui) as {samples:number;rows:{id:string;outcome?:string}[];outcomes:{completed:number};counters:{asrEvents:number};metrics:{firstPaintMs?:{samples:number}}};
      const live=await speech.route({type:'speech:status'},ui) as {seconds:number;completed:number;asrUsage:{totalTokens:number};state:string};
      assert.equal(memory.samples,100);assert.equal(memory.outcomes.completed,100);assert.equal(memory.metrics.firstPaintMs?.samples,100);
      assert.equal(memory.counters.asrEvents,finals);assert.equal(live.completed,finals);assert.equal(live.seconds,SOAK_SECONDS-1);assert.equal(live.state,'active');
      assert.equal(disk().counters.asrEvents<memory.counters.asrEvents,true);
      assert.notEqual(disk().rows.at(-1)?.id,memory.rows.at(-1)?.id);
      assert.equal(state().seconds,Math.floor((SOAK_SECONDS-1)/15)*15);
      const periodic=Math.floor((SOAK_SECONDS-1)/15)+1;
      assert.equal(storage.writes(),periodic);
      assert.ok(storage.writes()<SOAK_SECONDS/5);
      const stopped=await speech.route({type:'speech:stop'},ui) as {state:string;seconds:number;completed:number;asrUsage:{totalTokens:number}};
      assert.equal(storage.writes(),periodic+1);
      assert.equal(stopped.state,'stopped');assert.equal(state().state,'stopped');assert.equal(state().seconds,SOAK_SECONDS-1);
      assert.equal(state().completed,finals);assert.equal(state().asrUsage?.totalTokens,SOAK_SECONDS);
      assert.equal(state().sessionId,'sess');assert.equal(typeof state().message,'string');assert.equal(state().hasAudio,true);assert.equal(state().tabId,7);
      assert.equal(typeof state().lastSource,'string');assert.equal(typeof state().lastTranslation,'string');assert.equal(typeof state().sentBytes,'number');
      const flushed=await speech.route({type:'speech:diagnostics'},ui) as {samples:number;rows:{id:string}[];counters:{asrEvents:number}};
      assert.equal(flushed.samples,100);assert.equal(disk().rows.length,100);assert.equal(disk().counters.asrEvents,flushed.counters.asrEvents);
      assert.equal(disk().rows.at(-1)?.id,flushed.rows.at(-1)?.id);
      assert.ok(JSON.stringify(session.speechDiagnostics).length<120_000);
      assert.deepEqual(Object.keys(session).sort(),['speechConfig','speechDiagnostics','speechState']);
      const cleared=speech.footprint();
      assert.equal(cleared.sourceMeta,0);assert.equal(cleared.latest,0);assert.equal(cleared.translatedPieces,0);
      assert.equal(cleared.finalItems,0);assert.equal(cleared.utterances,0);assert.equal(cleared.utteranceEmitted,0);assert.equal(cleared.queue,0);
      assert.equal(cleared.diagnostics,100);assert.ok(cleared.contextChars<=300);
    }finally{clock.restore();}
  });
});
