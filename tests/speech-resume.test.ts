import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSpeechController} from '../src/speech-background.ts';
import {DEFAULT_SPEECH,IDLE_SPEECH} from '../src/core/speech.ts';
import type {TranslationResult} from '../src/core/types.ts';

const url='https://example.test/watch?v=one',extension='chrome-extension://ext/';
const page={id:'ext',url,tab:{id:7},frameId:0},ui={id:'ext',url:extension+'popup.html'},offscreen={id:'ext',url:extension+'offscreen.html'};
const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
function harness(){
  const session:Record<string,any>={speechState:{...IDLE_SPEECH,state:'active',sessionId:'session',recognitionId:'old',pageUrl:url,tabId:7},speechConfig:{profileId:'saved',target:'zh-Hans',ready:true}};
  const commands:any[]=[],captions:any[]=[],cancelled:string[]=[],injected:any[]=[],requests:any[]=[];
  let updated:(id:number,change:any)=>void=()=>{},closed=0,currentUrl=url;
  (globalThis as any).chrome={
    runtime:{id:'ext',getURL:(s:string)=>extension+s,getContexts:async()=>[{}],ContextType:{OFFSCREEN_DOCUMENT:'OFFSCREEN_DOCUMENT'},sendMessage:async(m:any)=>{commands.push(m);return {ok:true};}},
    storage:{session:{get:async()=>session,set:async(v:any)=>Object.assign(session,v)},local:{get:async()=>({speechSettings:DEFAULT_SPEECH})}},
    tabs:{get:async()=>({url:currentUrl}),sendMessage:async(_id:number,m:any)=>{captions.push(m);return true;},onUpdated:{addListener:(fn:any)=>{updated=fn;}},onRemoved:{addListener(){}}},
    scripting:{executeScript:async(m:any)=>{injected.push(m);}},offscreen:{closeDocument:async()=>{closed++;}},declarativeNetRequest:{updateSessionRules:async()=>{}},action:{setBadgeText:async()=>{}},
  };
  const speech=createSpeechController({ready:Promise.resolve(),config:async()=>{throw new Error('must preserve the active configuration');},cancel:id=>cancelled.push(id),translate:(input,_tab,observer)=>{
    let resolve!:(r:TranslationResult)=>void;const promise=new Promise<TranslationResult>(r=>{resolve=r;});requests.push({input,observer,resolve});return promise;
  }});
  const status=()=>speech.route({type:'speech:status'},ui) as Promise<any>;
  const event=(type:string,recognitionId:string,extra={})=>speech.route({type,sessionId:'session',recognitionId,...extra},offscreen);
  const seek=(phase:string,sender=page)=>speech.route({type:'speech:resync',sessionId:'session',phase},sender);
  return {speech,status,event,seek,session,commands,captions,cancelled,injected,requests,get closed(){return closed;},navigate:async(change:any)=>{if(change.url)currentUrl=change.url;updated(7,change);await flush();}};
}

test('seek cancels pending text, rejects old recognition and errors, resumes once with the original config',async()=>{
  const h=harness();await h.event('speech:transcript','old',{itemId:'one',text:'移動前の文章。',final:true});
  assert.equal(h.requests.length,1);h.requests[0].observer.text('旧字幕');
  await h.seek('begin');const state=await h.status();assert.equal(state.state,'connecting');assert.equal(state.lastTranslation,'');assert.notEqual(state.recognitionId,'old');assert.equal(h.closed,0);
  await h.seek('begin');assert.equal(h.commands.filter(m=>m.action==='suspend').length,1);
  await h.event('speech:transcript','old',{itemId:'late',text:'古い結果。',final:true});await h.event('speech:ready','old');await h.event('speech:failed','old');
  assert.equal((await h.status()).state,'connecting');assert.equal(h.requests.length,1);
  const resetAt=h.captions.length;h.requests[0].observer.text('迟到增量');h.requests[0].resolve({segments:[{id:'live',text:'迟到结果'}],cached:false,usage:{input:0,output:0,estimatedCost:0}});await flush();
  assert.ok(!h.captions.slice(resetAt).some(m=>m.translation));
  await h.seek('end');await h.seek('end');assert.equal(h.commands.filter(m=>m.action==='resume').length,1);
  await h.event('speech:ready',state.recognitionId);await h.event('speech:transcript',state.recognitionId,{itemId:'one',text:'移動後の文章。',final:true});
  assert.equal(h.requests.length,2);assert.equal(h.requests[1].input.profileId,'saved');assert.equal(h.requests[1].input.blocks[0].context,'');
  h.requests[1].resolve({segments:[{id:'live',text:'新字幕'}],cached:false,usage:{input:0,output:0,estimatedCost:0}});await flush();
  assert.equal((await h.status()).lastTranslation,'新字幕');assert.equal(h.closed,0);
});

test('refresh only reattaches the overlay and resumes the same capture; stop wins over a delayed load',async()=>{
  const h=harness();await h.status();await h.navigate({status:'loading'});
  assert.equal((await h.status()).resumePending,true);assert.equal(h.closed,0);
  await h.navigate({status:'complete'});assert.equal(h.injected.length,1);assert.equal(h.captions.filter(m=>m.type==='video:live-start').length,1);
  assert.equal(h.commands.filter(m=>m.action==='resume').length,1);assert.equal((await h.status()).sessionId,'session');
  await h.navigate({status:'loading'});await h.speech.route({type:'speech:stop'},ui);await h.navigate({status:'complete'});
  assert.equal((await h.status()).state,'stopped');assert.equal(h.injected.length,1);assert.equal(h.closed,1);
});

test('another page or another frame cannot inherit the active recording',async()=>{
  const h=harness();await h.status();
  await assert.rejects(h.seek('begin',{...page,tab:{id:9}}));await assert.rejects(h.seek('begin',{...page,frameId:1}));
  assert.equal(h.commands.length,0);
  await h.navigate({url:'https://example.test/watch?v=two',status:'loading'});
  assert.equal((await h.status()).state,'stopped');assert.equal(h.closed,1);await h.navigate({status:'complete'});assert.equal(h.injected.length,0);
});
