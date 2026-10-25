import {describe,test} from 'node:test';import assert from 'node:assert/strict';
import {createSpeechController} from '../src/speech-background.ts';
import {RateLimitError} from '../src/core/provider.ts';
import {rateLimitBackoffMs} from '../src/core/rate-limit.ts';
import {LIVE_CONTEXT_CHARS} from '../src/core/live-translate.ts';
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
    assert.deepEqual(report.policy,{maxQueue:3,skipAfterMs:12000,expireAfterMs:15000,translationTimeoutMs:12000,silenceDurationMs:600});
    const row=report.rows.find(item=>item.sourceChars==='短句。'.length)!;
    await speech.route({type:'speech:paint',sessionId:'sess',traceId:row.id,at:receivedAt+500,arrivedAt:receivedAt+20,sourceEndAt},page);
    const painted=await speech.route({type:'speech:diagnostics'},ui) as {metrics:{audioToPaintMs?:{samples:number;p50:number};asrMs?:{samples:number}}};
    assert.equal(painted.metrics.asrMs?.samples,2);assert.equal(painted.metrics.audioToPaintMs?.samples,1);assert.equal(painted.metrics.audioToPaintMs?.p50,920);
    const raw=JSON.stringify(report);
    for(const secret of ['secret-speech-key','secret-text-key','山田太郎','dashscope','https://','短句','再来一句','sourceEndAt'])assert.ok(!raw.includes(secret),secret);
  });
  test('diagnostic policy reports each saved VAD tier and treats a legacy config as 600 ms',async()=>{
    for(const silenceDurationMs of [400,800] as const){
      installChrome(activeSession(),{...speechLocal(),speechSettings:{...DEFAULT_SPEECH,apiKey:'secret-speech-key',silenceDurationMs,context:'不要出现在导出'}},[]);
      const speech=createSpeechController({ready:Promise.resolve(),config:async()=>activeSession().speechConfig as never,translate:async()=>{throw new Error('unused');},cancel(){}});
      const report=await speech.route({type:'speech:diagnostics'},ui) as {policy:{silenceDurationMs:number}};
      assert.equal(report.policy.silenceDurationMs,silenceDurationMs);
      const raw=JSON.stringify(report);
      assert.ok(!raw.includes('secret-speech-key'));assert.ok(!raw.includes('不要出现在导出'));
    }
    const legacy={...DEFAULT_SPEECH,apiKey:'secret-speech-key'} as {silenceDurationMs?:number};
    delete legacy.silenceDurationMs;
    installChrome(activeSession(),{...speechLocal(),speechSettings:legacy},[]);
    const speech=createSpeechController({ready:Promise.resolve(),config:async()=>activeSession().speechConfig as never,translate:async()=>{throw new Error('unused');},cancel(){}});
    const report=await speech.route({type:'speech:diagnostics'},ui) as {policy:{silenceDurationMs:number}};
    assert.equal(report.policy.silenceDurationMs,600);
  });
  test('A long enough unfinished tail flushes at 800 ms without waiting for the next speech:health',async()=>{
    const captions:Record<string,unknown>[]=[],session=activeSession();
    const local={speechSettings:{...DEFAULT_SPEECH,apiKey:'secret-speech-key'},settings:{version:1,activeProfileId:'p',target:'zh-Hans',profiles:[{id:'p',model:'deepseek-flash',stream:true}]},captionLayout:{readingMode:'balanced'}};
    installChrome(session,local,captions);
    const clock=installClock(1_700_000_000_000);
    const jobs:Promise<TranslationResult>[]=[];
    const translate=(input:TranslationInput)=>{
      const job=(async()=>({segments:[{id:'live',text:'译：'+input.blocks[0].segments[0].text}],cached:false,usage:{input:1,output:1,estimatedCost:0}}))();
      jobs.push(job);return job;
    };
    const settled=async()=>{await Promise.all(jobs.splice(0));for(let i=0;i<20;i++)await Promise.resolve();};
    try{
      const speech=createSpeechController({ready:Promise.resolve(),config:async()=>session.speechConfig as never,translate,cancel(){}});
      const tail='あいうえおかきくけこさし';
      const send=(text:string,itemId:string,at=clock.now())=>speech.route({type:'speech:transcript',sessionId:'sess',itemId,text,preview:'',final:false,receivedAt:at},offscreen);
      await send('今日は晴れです。','punct');
      assert.equal(jobs.length,1);
      await settled();
      const started=clock.now();
      await send(tail,'tail',started);
      assert.equal(jobs.length,0);
      clock.advance(799);
      assert.equal(jobs.length,0);
      clock.advance(1);
      assert.equal(jobs.length,1);
      await settled();
      const report=await speech.route({type:'speech:diagnostics'},ui) as {rows:{sourceChars:number;commitMs?:number}[]};
      assert.equal(report.rows.find(row=>row.sourceChars===tail.length)?.commitMs,800);
      const again=clock.now();
      await send(tail+'す','slide',again);
      clock.advance(400);
      await send(tail+'すせ','slide',clock.now());
      clock.advance(399);
      assert.equal(jobs.length,0);
      clock.advance(1);
      assert.equal(jobs.length,1);
      await settled();
      const slid=await speech.route({type:'speech:diagnostics'},ui) as {rows:{sourceChars:number;commitMs?:number}[]};
      assert.equal(slid.rows.find(row=>row.sourceChars===(tail+'すせ').length)?.commitMs,400);
      await send('あいうえお','short');
      clock.advance(5000);
      await speech.route({type:'speech:health',sessionId:'sess',seconds:9,sentBytes:9000,hasAudio:true},offscreen);
      assert.equal(jobs.length,0);
    }finally{clock.restore();}
  });
  test('speech:health still flushes a due tail when the scheduled check has not run',async()=>{
    const captions:Record<string,unknown>[]=[],session=activeSession();
    const local={speechSettings:{...DEFAULT_SPEECH,apiKey:'secret-speech-key'},settings:{version:1,activeProfileId:'p',target:'zh-Hans',profiles:[{id:'p',model:'deepseek-flash',stream:true}]},captionLayout:{readingMode:'balanced'}};
    installChrome(session,local,captions);
    const clock=installClock(1_700_000_000_000);
    const jobs:Promise<TranslationResult>[]=[];
    const translate=(input:TranslationInput)=>{
      const job=(async()=>({segments:[{id:'live',text:'译：'+input.blocks[0].segments[0].text}],cached:false,usage:{input:1,output:1,estimatedCost:0}}))();
      jobs.push(job);return job;
    };
    try{
      const speech=createSpeechController({ready:Promise.resolve(),config:async()=>session.speechConfig as never,translate,cancel(){}});
      const tail='あいうえおかきくけこさし',started=clock.now();
      await speech.route({type:'speech:transcript',sessionId:'sess',itemId:'held',text:tail,preview:'',final:false,receivedAt:started},offscreen);
      clock.advance(800,false);
      assert.equal(jobs.length,0);
      await speech.route({type:'speech:health',sessionId:'sess',seconds:4,sentBytes:4000,hasAudio:true},offscreen);
      assert.equal(jobs.length,1);
      await Promise.all(jobs.splice(0));
      const report=await speech.route({type:'speech:diagnostics'},ui) as {rows:{sourceChars:number;commitMs?:number}[]};
      assert.equal(report.rows.find(row=>row.sourceChars===tail.length)?.commitMs,800);
    }finally{clock.restore();}
  });
  test('live requests keep at most 300 characters of prior transcript',async()=>{
    const captions:Record<string,unknown>[]=[],session=activeSession();
    const local={speechSettings:{...DEFAULT_SPEECH,apiKey:'secret-speech-key'},settings:{version:1,activeProfileId:'p',target:'zh-Hans',profiles:[{id:'p',model:'deepseek-flash',stream:true}]},captionLayout:{readingMode:'balanced'}};
    installChrome(session,local,captions);
    const jobs:Promise<TranslationResult>[]=[];
    const seen:{text:string;context:string;taskId:string}[]=[];
    const translate=(input:TranslationInput)=>{
      const block=input.blocks[0];
      seen.push({text:block.segments[0].text,context:block.context,taskId:input.taskId});
      const job=(async()=>({segments:[{id:'live',text:'译'}],cached:false,usage:{input:1,output:1,estimatedCost:0}}))();
      jobs.push(job);return job;
    };
    const settled=async()=>{await Promise.all(jobs.splice(0));for(let i=0;i<20;i++)await Promise.resolve();};
    const speech=createSpeechController({ready:Promise.resolve(),config:async()=>session.speechConfig as never,translate,cancel(){}});
    const line=(i:number)=>`第${String(i).padStart(2,'0')}番確認発話です。`;
    for(let i=0;i<40;i++){
      await speech.route({type:'speech:transcript',sessionId:'sess',itemId:`ctx-${i}`,text:line(i),preview:'',final:true,receivedAt:Date.now()},offscreen);
      await settled();
    }
    assert.equal(seen.length,40);
    assert.equal(seen[0].context,'');
    assert.equal(line(0).length,11);
    for(const row of seen){assert.ok(row.context.length<=LIVE_CONTEXT_CHARS,String(row.context.length));assert.equal(row.taskId,'subtitle-live-sess');}
    const last=seen.at(-1)!;
    assert.equal(last.text,line(39));
    assert.ok(last.context.length<=LIVE_CONTEXT_CHARS&&last.context.length>=LIVE_CONTEXT_CHARS-1);
    assert.equal(last.context.endsWith(line(38)),true);
    assert.equal(last.context.includes(line(0)),false);
    const chunk='続'.repeat(35)+'。';
    await speech.route({type:'speech:transcript',sessionId:'sess',itemId:'split',text:chunk.repeat(3),preview:'',final:true,receivedAt:Date.now()},offscreen);
    await settled();
    const split=seen.slice(40);
    assert.ok(split.length>=2);
    for(const row of split)assert.ok(row.context.length<=LIVE_CONTEXT_CHARS);
    assert.equal(split[1].context.includes('続'),true);
    assert.equal(split[1].context.endsWith(chunk),true);
  });
  test('queued short fragments share one request, keep every line, and captions stay in order',async()=>{
    const captions:Record<string,unknown>[]=[],jobs:Promise<unknown>[]=[],seen:string[]=[];
    installChrome(activeSession(),speechLocal(),captions);
    const first=deferred();
    const translate=translating(seen,jobs,async index=>{if(index===1)await first.promise;});
    const speech=createSpeechController({ready:Promise.resolve(),config:async()=>activeSession().speechConfig as never,translate,cancel(){}});
    const line=(i:number)=>`句${i}。`;
    try{
      for(let i=0;i<8;i++)await speech.route(transcript(`s${i}`,line(i)),offscreen);
      assert.deepEqual(seen,[line(0)]);
      first.resolve();await drain(jobs);
      const joined=Array.from({length:7},(_,i)=>line(i+1)).join('');
      assert.deepEqual(seen,[line(0),joined]);
      assert.ok(joined.indexOf(line(1))<joined.indexOf(line(7)));
      const spoken=captions.filter(message=>typeof message.source==='string'&&!message.preview);
      const primerFinal=spoken.findIndex(message=>message.source===line(0)&&!message.partial);
      const later=spoken.findIndex(message=>String(message.source).includes(line(1)));
      assert.ok(primerFinal>=0&&later>primerFinal,'后一句不能先于前一句的成稿上屏');
      assert.deepEqual(spoken.filter(message=>!message.partial).map(message=>message.source),[line(0),joined]);
      const reader=new LiveReader();let t=0;
      for(const message of captions){
        t+=100;
        if(message.preview||typeof message.translation!=='string')continue;
        reader.receive({id:String(message.pieceId??''),version:String(message.version??''),source:String(message.source??''),text:String(message.translation),final:!message.partial,arrivedAt:t},t);
      }
      assert.deepEqual(reader.items.map(item=>item.source),[line(0),joined]);
      assert.equal(reader.current?.text,'译：'+line(0));assert.equal(reader.current?.final,true);
      reader.tick(t+30_000);
      assert.equal(reader.current?.source,joined);assert.equal(reader.current?.text,'译：'+joined);assert.equal(reader.current?.final,true);
      const report=await speech.route({type:'speech:diagnostics'},ui) as {outcomes:Record<string,number>};
      assert.equal(report.outcomes.skipped,0);assert.equal(report.outcomes.completed,8);
    }finally{first.resolve();}
  });
  test('overflow still drops the oldest merged group and translates the rest in order',async()=>{
    const captions:Record<string,unknown>[]=[],jobs:Promise<unknown>[]=[],seen:string[]=[];
    installChrome(activeSession(),speechLocal(),captions);
    const first=deferred();
    const translate=translating(seen,jobs,async index=>{if(index===1)await first.promise;});
    const speech=createSpeechController({ready:Promise.resolve(),config:async()=>activeSession().speechConfig as never,translate,cancel(){}});
    const line=(i:number)=>`${String(i).padStart(2,'0')}${'あ'.repeat(33)}。`;
    try{
      assert.equal(Array.from(line(0)).length,36);
      for(let i=0;i<9;i++)await speech.route(transcript(`b${i}`,line(i)),offscreen);
      first.resolve();await drain(jobs);
      const pair=(left:number,right:number)=>line(left)+line(right);
      assert.deepEqual(seen,[line(0),pair(3,4),pair(5,6),pair(7,8)]);
      assert.equal(seen.some(text=>text.includes(line(1))||text.includes(line(2))),false);
      const report=await speech.route({type:'speech:diagnostics'},ui) as {rows:{outcome?:string}[];outcomes:Record<string,number>};
      assert.equal(report.outcomes.skipped,2);assert.equal(report.outcomes.completed,7);
      assert.deepEqual(report.rows.slice(1,3).map(row=>row.outcome),['skipped','skipped']);
      assert.deepEqual(captions.filter(message=>typeof message.translation==='string'&&!message.partial&&!message.preview).map(message=>message.source),seen);
    }finally{first.resolve();}
  });
  test('a queued revision updates the merged request instead of translating the stale fragment',async()=>{
    const captions:Record<string,unknown>[]=[],jobs:Promise<unknown>[]=[],seen:string[]=[];
    installChrome(activeSession(),speechLocal(),captions);
    const first=deferred();
    const translate=translating(seen,jobs,async index=>{if(index===1)await first.promise;});
    const speech=createSpeechController({ready:Promise.resolve(),config:async()=>activeSession().speechConfig as never,translate,cancel(){}});
    try{
      await speech.route(transcript('hold','占位长句保持在途。'),offscreen);
      await speech.route(transcript('a','甲。'),offscreen);
      await speech.route(transcript('b','丙丁戊。'),offscreen);
      await speech.route(transcript('a','甲乙。'),offscreen);
      first.resolve();await drain(jobs);
      assert.deepEqual(seen,['占位长句保持在途。','甲乙。丙丁戊。']);
      const report=await speech.route({type:'speech:diagnostics'},ui) as {rows:{sourceChars:number;outcome?:string}[];outcomes:Record<string,number>};
      assert.equal(report.rows.find(row=>row.sourceChars==='甲。'.length)?.outcome,'stale');
      assert.equal(report.outcomes.skipped,0);assert.equal(report.outcomes.completed,3);
    }finally{first.resolve();}
  });
  test('a fresh fragment more than 3s later is not skipped with an older neighbor',async()=>{
    const captions:Record<string,unknown>[]=[],jobs:Promise<unknown>[]=[],seen:string[]=[];
    installChrome(activeSession(),speechLocal(),captions);
    const clock=installClock(1_700_000_000_000),first=deferred();
    const translate=translating(seen,jobs,async index=>{if(index===1)await first.promise;});
    try{
      const speech=createSpeechController({ready:Promise.resolve(),config:async()=>activeSession().speechConfig as never,translate,cancel(){}});
      await speech.route(transcript('hold','占位句。'),offscreen);
      await speech.route(transcript('old','旧。'),offscreen);
      clock.advance(4000,false);
      await speech.route(transcript('fresh','新的句子。'),offscreen);
      clock.advance(9000,false);
      first.resolve();await drain(jobs);
      assert.deepEqual(seen,['占位句。','新的句子。']);
      const report=await speech.route({type:'speech:diagnostics'},ui) as {rows:{sourceChars:number;outcome?:string}[];outcomes:Record<string,number>};
      assert.equal(report.rows.find(row=>row.sourceChars==='旧。'.length)?.outcome,'skipped');
      assert.equal(report.rows.find(row=>row.sourceChars==='新的句子。'.length)?.outcome,'completed');
      assert.equal(report.outcomes.skipped,1);assert.equal(report.outcomes.completed,2);
    }finally{first.resolve();clock.restore();}
  });
  test('a merged group waits from its earliest fragment and is skipped together after 12s',async()=>{
    const captions:Record<string,unknown>[]=[],jobs:Promise<unknown>[]=[],seen:string[]=[];
    installChrome(activeSession(),speechLocal(),captions);
    const clock=installClock(1_700_000_000_000),first=deferred();
    const translate=translating(seen,jobs,async index=>{if(index===1)await first.promise;});
    try{
      const speech=createSpeechController({ready:Promise.resolve(),config:async()=>activeSession().speechConfig as never,translate,cancel(){}});
      await speech.route(transcript('hold','占位句。'),offscreen);
      await speech.route(transcript('a','甲。'),offscreen);
      await speech.route(transcript('b','乙。'),offscreen);
      clock.advance(13000,false);
      first.resolve();await drain(jobs);
      assert.deepEqual(seen,['占位句。']);
      const report=await speech.route({type:'speech:diagnostics'},ui) as {outcomes:Record<string,number>};
      assert.equal(report.outcomes.completed,1);assert.equal(report.outcomes.skipped,2);
    }finally{first.resolve();clock.restore();}
  });
  test('a merged translation that returns after 15s withdraws 生成中 for every fragment',async()=>{
    const captions:Record<string,unknown>[]=[],jobs:Promise<unknown>[]=[],seen:string[]=[];
    installChrome(activeSession(),speechLocal(),captions);
    const clock=installClock(1_700_000_000_000),first=deferred(),second=deferred();
    const translate=translating(seen,jobs,async index=>{if(index===1)await first.promise;else await second.promise;});
    try{
      const speech=createSpeechController({ready:Promise.resolve(),config:async()=>activeSession().speechConfig as never,translate,cancel(){}});
      await speech.route(transcript('hold','占位句。'),offscreen);
      await speech.route(transcript('a','甲。'),offscreen);
      await speech.route(transcript('b','乙。'),offscreen);
      first.resolve();
      for(let i=0;i<20&&seen.length<2;i++)await Promise.resolve();
      assert.equal(seen[1],'甲。乙。');
      clock.advance(16000,false);second.resolve();await drain(jobs);
      assert.equal(captions.some(message=>message.translation==='译：甲。乙。'&&!message.partial),false);
      const reader=new LiveReader();let t=clock.now();
      for(const message of captions){
        t+=100;
        if(message.failed){reader.withdraw(String(message.pieceId??''),String(message.version??''),t);continue;}
        if(message.preview||typeof message.translation!=='string')continue;
        reader.receive({id:String(message.pieceId??''),version:String(message.version??''),source:String(message.source??''),text:String(message.translation),final:!message.partial,arrivedAt:t},t);
      }
      reader.tick(t+30_000);
      assert.equal(reader.current?.text,'译：占位句。');assert.equal(reader.current?.final,true);
      assert.ok(!reader.items.some(item=>!item.final));
      const report=await speech.route({type:'speech:diagnostics'},ui) as {outcomes:Record<string,number>};
      assert.equal(report.outcomes.stale,2);assert.equal(report.outcomes.completed,1);
    }finally{first.resolve();second.resolve();clock.restore();}
  });
  test('a 12s translation timeout still fails the in-flight line and skips the merged queue',async()=>{
    const captions:Record<string,unknown>[]=[],jobs:Promise<unknown>[]=[],seen:string[]=[];
    installChrome(activeSession(),speechLocal(),captions);
    const clock=installClock(1_700_000_000_000),first=deferred();
    const translate=translating(seen,jobs,async index=>{if(index===1)await first.promise;});
    try{
      const speech=createSpeechController({ready:Promise.resolve(),config:async()=>activeSession().speechConfig as never,translate,cancel(){}});
      await speech.route(transcript('hold','占位句。'),offscreen);
      await speech.route(transcript('a','甲。'),offscreen);
      await speech.route(transcript('b','乙。'),offscreen);
      clock.advance(12000);
      const timedOut=await speech.route({type:'speech:status'},ui) as {state:string;message:string};
      assert.equal(timedOut.state,'active');
      assert.equal(timedOut.message,'文字翻译超时，已跳过，继续识别。');
      assert.equal(/重新开始/.test(timedOut.message),false);
      first.resolve();await drain(jobs);
      const report=await speech.route({type:'speech:diagnostics'},ui) as {rows:{sourceChars:number;outcome?:string}[];outcomes:Record<string,number>};
      assert.equal(report.rows.find(row=>row.sourceChars==='占位句。'.length)?.outcome,'failed');
      assert.equal(report.outcomes.skipped,2);assert.equal(report.outcomes.completed,0);
      assert.equal(seen.length,1);
      await speech.route(transcript('next','下一句仍然要译。'),offscreen);
      await drain(jobs);
      assert.deepEqual(seen,['占位句。','下一句仍然要译。']);
      const continued=await speech.route({type:'speech:status'},ui) as {state:string;message:string};
      assert.equal(continued.state,'active');
      assert.equal(continued.message,'正在识别并翻译标签页声音。');
    }finally{first.resolve();clock.restore();}
  });
  test('a rate limit waits out the backoff before the next live request and keeps recognition running',async()=>{
    const captions:Record<string,unknown>[]=[];
    installChrome(activeSession(),speechLocal(),captions);
    const clock=installClock(1_700_000_000_000);
    let calls=0;
    const translate=(input:TranslationInput)=>{
      calls++;
      const text=input.blocks[0].segments[0].text;
      if(text.startsWith('限流'))return Promise.reject(new RateLimitError('请求过于频繁，请稍后再试。'));
      return Promise.resolve({segments:[{id:'live',text:'译：'+text}],cached:false,usage:{input:1,output:1,estimatedCost:0}});
    };
    const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
    try{
      const speech=createSpeechController({ready:Promise.resolve(),config:async()=>activeSession().speechConfig as never,translate,cancel(){}});
      await speech.route(transcript('a','限流一。'),offscreen);
      await flush();
      const paused=await speech.route({type:'speech:status'},ui) as {state:string;message:string};
      assert.equal(paused.state,'active');
      assert.equal(paused.message,'请求过于频繁，稍候继续识别。');
      assert.equal(/重新开始/.test(paused.message),false);
      await speech.route(transcript('b','限流二。'),offscreen);
      await flush();
      assert.equal(calls,1);
      clock.advance(rateLimitBackoffMs(0)-1);
      await flush();
      assert.equal(calls,1,'退避结束前不能发出下一次翻译');
      clock.advance(1);
      await flush();
      assert.equal(calls,2);
      await speech.route(transcript('c','恢复一句。'),offscreen);
      await flush();
      assert.equal(calls,2);
      clock.advance(rateLimitBackoffMs(1)-1);
      await flush();
      assert.equal(calls,2);
      clock.advance(1);
      await flush();
      assert.equal(calls,3);
      const continued=await speech.route({type:'speech:status'},ui) as {state:string;message:string;completed:number};
      assert.equal(continued.state,'active');
      assert.equal(continued.message,'正在识别并翻译标签页声音。');
      assert.equal(continued.completed,1);
      const report=await speech.route({type:'speech:diagnostics'},ui) as {outcomes:Record<string,number>};
      assert.equal(report.outcomes.failed,2);assert.equal(report.outcomes.completed,1);
    }finally{clock.restore();}
  });
  test('a translation failure other than rate limiting continues without that pause',async()=>{
    const captions:Record<string,unknown>[]=[];
    installChrome(activeSession(),speechLocal(),captions);
    const clock=installClock(1_700_000_000_000);
    let calls=0;
    const translate=(input:TranslationInput)=>{
      calls++;
      const text=input.blocks[0].segments[0].text;
      if(calls===1)return Promise.reject(new Error('模型返回了空译文。'));
      return Promise.resolve({segments:[{id:'live',text:'译：'+text}],cached:false,usage:{input:1,output:1,estimatedCost:0}});
    };
    const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
    try{
      const speech=createSpeechController({ready:Promise.resolve(),config:async()=>activeSession().speechConfig as never,translate,cancel(){}});
      await speech.route(transcript('a','失败一句。'),offscreen);
      await flush();
      const failed=await speech.route({type:'speech:status'},ui) as {state:string;message:string};
      assert.equal(failed.state,'active');
      assert.match(failed.message,/语音识别仍在继续/);
      assert.equal(/重新开始/.test(failed.message),false);
      await speech.route(transcript('b','下一句。'),offscreen);
      await flush();
      assert.equal(calls,2);
      clock.advance(0);
      const continued=await speech.route({type:'speech:status'},ui) as {state:string;message:string};
      assert.equal(continued.state,'active');
      assert.equal(continued.message,'正在识别并翻译标签页声音。');
    }finally{clock.restore();}
  });
});
function speechLocal(){
  return {speechSettings:{...DEFAULT_SPEECH,apiKey:'secret-speech-key'},settings:{version:1,activeProfileId:'p',target:'zh-Hans',profiles:[{id:'p',model:'deepseek-flash',stream:true}]},captionLayout:{readingMode:'balanced'}};
}
function transcript(itemId:string,text:string){return {type:'speech:transcript',sessionId:'sess',itemId,text,preview:'',final:true,receivedAt:Date.now()};}
function deferred(){let resolve:()=>void=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function translating(seen:string[],jobs:Promise<unknown>[],wait:(index:number)=>Promise<void>){
  let started=0;
  return (input:TranslationInput,_tab:number,observer?:TranslationObserver)=>{
    const text=input.blocks[0].segments[0].text;seen.push(text);
    const index=++started;
    const job=(async()=>{
      await wait(index);observer?.start?.(true);observer?.text?.('译：'+text);
      return {segments:[{id:'live',text:'译：'+text}],cached:false,usage:{input:1,output:1,estimatedCost:0}};
    })();
    jobs.push(job);return job;
  };
}
async function drain(jobs:Promise<unknown>[]){
  let idle=0;
  for(let guard=0;guard<50&&idle<8;guard++){if(jobs.length){idle=0;await Promise.all(jobs.splice(0));}else idle++;await Promise.resolve();}
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
    advance(ms:number,fire=true){
      now+=ms;if(!fire)return;
      for(let guard=0;guard<8;guard++){
        const due=[...pending.entries()].filter(([,timer])=>timer.at<=now).sort((a,b)=>a[1].at-b[1].at);
        if(!due.length)return;
        for(const [id,timer] of due){if(!pending.has(id))continue;pending.delete(id);timer.fn();}
      }
    },
    restore(){Date.now=realNow;globalThis.setTimeout=realSetTimeout;globalThis.clearTimeout=realClearTimeout;}
  };
}
