import {DEFAULT_SPEECH,IDLE_SPEECH,isSpeechStatus,normalizeSpeech,speechAuthRule,speechStatusOrIdle,type SpeechStatus,type SpeechSettings} from './core/speech';
import {liveInterruptHint} from './core/live-hints';
import type {PublicConfig,TranslationInput,TranslationResult,TranslationObserver} from './core/types';
import {Utterances,enqueuePiece,LIVE_QUEUE_LIMIT,type SpeechPiece} from './core/utterances';
import {SpeechDiagnostics,diagnosticSettings} from './core/speech-diagnostics';
const SKIP_AFTER_MS=12000,EXPIRE_AFTER_MS=15000,TRANSLATION_TIMEOUT_MS=12000;
export function createSpeechController(deps:{ready:Promise<unknown>;config:()=>Promise<PublicConfig>;translate:(input:TranslationInput,tabId:number,observer?:TranslationObserver)=>Promise<TranslationResult>;cancel:(taskId:string)=>void}){
  let state:SpeechStatus={...IDLE_SPEECH},config:PublicConfig,queue:SpeechPiece[]=[],busy=false,epoch=0,context='',shownOrder=-1;
  const utterances=new Utterances(),latest=new Map<string,string>(),translatedPieces=new Map<string,string>(),finalItems=new Set<string>();
  const diagnostics=new SpeechDiagnostics(),sourceMeta=new Map<string,{firstAt:number;receivedAt:number;sourceEndAt?:number}>();
  let counters={asrEvents:0,asrIntermediate:0,asrStableIntermediate:0};
  let inflight:{id:string;version:string;traceId:string}|undefined;
  function enqueue(pieces:SpeechPiece[]){for(let piece of pieces){if(translatedPieces.get(piece.id)===piece.text)continue;const meta=sourceMeta.get(piece.id.slice(0,piece.id.lastIndexOf(':'))),traceId=crypto.randomUUID();piece={...piece,traceId,sourceEndAt:meta?.sourceEndAt};diagnostics.add({id:traceId,createdAt:piece.at,sourceChars:piece.text.length,...(meta?{commitMs:Math.max(0,piece.at-meta.receivedAt)}:{}),...(meta?.sourceEndAt!==undefined?{asrMs:Math.max(0,meta.receivedAt-meta.sourceEndAt)}:{})});const prior=queue;latest.delete(piece.id);latest.set(piece.id,piece.text);queue=enqueuePiece([...queue],{...piece,context:(context+' '+(piece.context??'')).trim().slice(-600)});for(const old of prior)if(old.traceId&&!queue.some(p=>p.traceId===old.traceId))diagnostics.update(old.traceId,{outcome:old.id===piece.id?'stale':'skipped'});while(latest.size>128){const key=latest.keys().next().value!;latest.delete(key);translatedPieces.delete(key);}}void pump();}
  let lock=Promise.resolve<unknown>(undefined),testing=false;
  const loaded=deps.ready.then(async()=>{const data=await chrome.storage.session.get(['speechState','speechConfig','speechDiagnostics']);if(isSpeechStatus(data.speechState))state=data.speechState;if(data.speechConfig)config=data.speechConfig;if(data.speechDiagnostics){diagnostics.load(data.speechDiagnostics.rows);counters={...counters,...data.speechDiagnostics.counters};}
    const contexts=await chrome.runtime.getContexts({contextTypes:[chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]});
    if(!contexts.length&&['active','connecting'].includes(state.state)){state={...state,state:'stopped',message:'上次音频会话已中断，请重新开启。'};await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[891]});}
    if(contexts.length&&['active','connecting'].includes(state.state)){for(const row of diagnostics.rows)if(!row.outcome)row.outcome='cancelled';await caption({resetProvisional:true});}
  });
  let writes=Promise.resolve();
  const persist=()=>{const snapshot={speechState:{...state},speechDiagnostics:{rows:diagnostics.rows.map(r=>({...r})),counters:{...counters}},...(config?{speechConfig:{...config}}:{})};writes=writes.catch(()=>{}).then(()=>chrome.storage.session.set(snapshot));return writes;};
  const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const next=lock.catch(()=>{}).then(fn);lock=next;return next;};
  const command=(extra:Record<string,unknown>)=>chrome.runtime.sendMessage({target:'speech-offscreen',...extra});
  const caption=(data:Record<string,unknown>)=>state.tabId<0?Promise.resolve():chrome.tabs.sendMessage(state.tabId,{type:'video:live-caption',sessionId:state.sessionId,...data},{frameId:0}).catch(()=>{});
  async function stop(message='实时语音翻译已停止。',error=false,hint=''){
    epoch++;inflight=undefined;for(const row of diagnostics.rows)if(!row.outcome)row.outcome='cancelled';queue=[];busy=false;utterances.reset();sourceMeta.clear();latest.clear();translatedPieces.clear();finalItems.clear();deps.cancel(`subtitle-live-${state.sessionId}`);
    try{if((await chrome.runtime.getContexts({contextTypes:[chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]})).length){await command({action:'stop'});await chrome.offscreen.closeDocument();}}catch{ /* Closing a tab may have already released capture. */ }
    await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[891]});
    await caption(hint?{stop:true,hint:hint.slice(0,200)}:{stop:true});state={...state,state:error?'error':'stopped',message};await chrome.action.setBadgeText({tabId:state.tabId>=0?state.tabId:undefined,text:''}).catch(()=>{});await persist();return state;
  }
  async function pump(){
    if(busy||state.state!=='active'||testing)return;const item=queue.shift();if(!item)return;
    if(Date.now()-item.at>SKIP_AFTER_MS){if(item.traceId)diagnostics.update(item.traceId,{outcome:'skipped'});state.message='翻译跟不上语速，已跳过过期片段。';void persist();void pump();return;}
    if(translatedPieces.get(item.id)===item.text){void pump();return;}
    busy=true;const run=epoch,sessionId=state.sessionId,tabId=state.tabId,started=Date.now(),queueMs=started-item.at,requestId=crypto.randomUUID(),traceId=item.traceId!;let networkAt=started,firstTextAt=0;
    diagnostics.update(traceId,{queueMs});
    inflight={id:item.id,version:requestId,traceId};
    const timeout=setTimeout(()=>{if(run===epoch){deps.cancel(`subtitle-live-${sessionId}`);diagnostics.update(traceId,{outcome:'failed'});for(const p of queue)if(p.traceId)diagnostics.update(p.traceId,{outcome:'skipped'});epoch++;queue=[];busy=false;void caption({failed:true,pieceId:item.id,version:requestId});state.message='文字翻译超时，请点击重新开始，或更换更快的翻译模型。';void persist();}},TRANSLATION_TIMEOUT_MS);
    const valid=()=>run===epoch&&state.state==='active'&&latest.get(item.id)===item.text&&item.order>=shownOrder;
    try{
      const result=await deps.translate({kind:'subtitle',taskId:`subtitle-live-${sessionId}`,requestId,profileId:config.profileId,target:config.target,blocks:[{id:'live',context:item.context??'',segments:[{id:'live',text:item.text}]}]},tabId,{
        start:streaming=>{networkAt=Date.now();diagnostics.update(traceId,{schedulerMs:networkAt-started,streaming});},
        token:()=>diagnostics.update(traceId,{firstTokenMs:Date.now()-networkAt}),
        text:text=>{if(!valid())return;if(!firstTextAt){firstTextAt=Date.now();diagnostics.update(traceId,{firstTextMs:firstTextAt-networkAt});}void caption({source:item.text,translation:text,pieceId:item.id,version:requestId,traceId,sourceEndAt:item.sourceEndAt,partial:true});}
      });
      if(run!==epoch||state.state!=='active')return;
      // The provisional caption is already on screen. Dropping the late result without a failure leaves the reader on “生成中”.
      if(Date.now()-item.at>EXPIRE_AFTER_MS){if(latest.has(item.id))translatedPieces.set(item.id,item.text);diagnostics.update(traceId,{outcome:'stale'});void caption({failed:true,pieceId:item.id,version:requestId});state.message='翻译跟不上语速，已跳过过期片段。';void persist();return;}
      if(latest.has(item.id))translatedPieces.set(item.id,item.text);
      if(!valid()){diagnostics.update(traceId,{outcome:'stale'});void caption({failed:true,pieceId:item.id,version:requestId});return;}
      shownOrder=item.order;
      state.lastTranslation=result.segments[0].text;state.completed++;state.message='正在识别并翻译标签页声音。';
      const done=Date.now();diagnostics.update(traceId,{outcome:'completed',targetChars:state.lastTranslation.length,translationMs:done-networkAt,cache:result.cached,...(!firstTextAt?{firstTextMs:done-networkAt}:{})});
      state.timing={queueMs,translationMs:done-networkAt,textToCaptionMs:done-item.at};
      await caption({source:item.text,translation:state.lastTranslation,pieceId:item.id,version:requestId,traceId,sourceEndAt:item.sourceEndAt});await persist();
    }catch{if(run===epoch){diagnostics.update(traceId,{outcome:'failed'});await caption({failed:true,pieceId:item.id,version:requestId});state.message='文字翻译失败，语音识别仍在继续。请检查翻译模型、Key 或余额。';await persist();}}
    finally{clearTimeout(timeout);if(run===epoch){inflight=undefined;busy=false;void pump();}}
  }
  async function start(test=false){
    await stop();const saved=await chrome.storage.local.get('speechSettings');const settings=normalizeSpeech(saved.speechSettings??DEFAULT_SPEECH);
    if(!settings.apiKey.trim())throw new Error('请先在设置的「实时语音」中填写百炼 API Key。');
    config=await deps.config();if(!test&&!config.ready)throw new Error('请先配置文字翻译模型。');
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!test&&(tab?.id===undefined||!/^https?:\/\//.test(tab.url??'')))throw new Error('请在直播网页打开工具栏，再点击开始。');
    testing=test;state={...IDLE_SPEECH,state:'connecting',sessionId:crypto.randomUUID(),tabId:test?-1:tab.id!,message:test?'正在测试语音连接…':'正在连接语音服务…'};context='';shownOrder=-1;await persist();
    try{
      if(!test){await chrome.scripting.executeScript({target:{tabId:tab.id!},files:['video.js']});await chrome.tabs.sendMessage(tab.id!,{type:'video:live-start',sessionId:state.sessionId},{frameId:0});}
      await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[891],addRules:[speechAuthRule(settings.endpoint,settings.model,settings.apiKey,chrome.runtime.id)]});
      let streamId:string|undefined;if(!test)streamId=await new Promise<string>((resolve,reject)=>chrome.tabCapture.getMediaStreamId({targetTabId:tab.id!},id=>{if(chrome.runtime.lastError)reject(new Error(chrome.runtime.lastError.message));else resolve(id);}));
      await chrome.offscreen.createDocument({url:'offscreen.html',reasons:[chrome.offscreen.Reason.USER_MEDIA],justification:'用户开启的标签页音频识别与实时字幕；保留原声播放。'});
      await command({action:'start',sessionId:state.sessionId,settings:{...settings,apiKey:''},streamId,testing:test});
      if(!test){await chrome.action.setBadgeBackgroundColor({color:'#b43543'});await chrome.action.setBadgeText({tabId:tab.id!,text:'音'});}
      return {...state};
    }catch{await stop('无法启动实时翻译，请重新加载扩展、刷新直播页并检查语音配置和浏览器权限。',true);return {...state};}
  }
  async function route(m:any,sender:chrome.runtime.MessageSender){
    if(sender.id!==chrome.runtime.id)throw new Error('无效扩展来源。');
    await loaded;const offscreen=sender.url===chrome.runtime.getURL('offscreen.html'),ui=!!sender.url?.startsWith(chrome.runtime.getURL(''))&&!offscreen;
    if(m.type==='speech:paint'){
      if(sender.tab?.id!==state.tabId||m.sessionId!==state.sessionId||!['connecting','active'].includes(state.state))return;
      const row=diagnostics.rows.find(r=>r.id===m.traceId);if(!row)return;
      if(m.skipped){if(!['failed','stale','cancelled'].includes(row.outcome??''))diagnostics.update(row.id,{outcome:'skipped'});await persist();return;}
      const now=Date.now(),at=Number.isFinite(m.at)&&Math.abs(now-m.at)<10000?m.at:now;
      if(row.firstPaintMs===undefined){const sourceEndAt=Number.isFinite(m.sourceEndAt)?m.sourceEndAt:undefined;diagnostics.update(row.id,{firstPaintMs:Math.max(0,at-row.createdAt),displayWaitMs:Math.max(0,at-Number(m.arrivedAt??at)),...(sourceEndAt!==undefined&&sourceEndAt<=at?{audioToPaintMs:at-sourceEndAt}:{})});}
      await persist();return;
    }
    if(['speech:health','speech:ready','speech:transcript','speech:failed','speech:warning'].includes(m.type)){
      if(!offscreen)throw new Error('语音事件只允许来自音频处理页。');
      if(m.sessionId!==state.sessionId||!['connecting','active'].includes(state.state))return;
      if(m.type==='speech:failed')return serial(()=>m.sessionId===state.sessionId?stop(String(m.message??'音频连接失败。').slice(0,300),true):Promise.resolve(state));
      if(m.type==='speech:ready'){if(testing)return serial(()=>m.sessionId===state.sessionId?stop('语音连接成功，可以开始直播翻译。'):Promise.resolve(state));state.state='active';state.message='已连接，等待标签页声音。';await persist();return;}
      if(m.type==='speech:warning'){if(m.reconnecting){if(inflight){diagnostics.update(inflight.traceId,{outcome:'cancelled'});void caption({failed:true,pieceId:inflight.id,version:inflight.version});}for(const p of queue)if(p.traceId)diagnostics.update(p.traceId,{outcome:'cancelled'});inflight=undefined;epoch++;busy=false;deps.cancel(`subtitle-live-${state.sessionId}`);state.state='connecting';utterances.reset();sourceMeta.clear();latest.clear();translatedPieces.clear();finalItems.clear();queue=[];shownOrder=-1;}state.message=String(m.message).slice(0,300);await persist();return;}
      if(m.type==='speech:health'){state.seconds=Math.max(0,Number(m.seconds)||0);state.sentBytes=Math.max(0,Number(m.sentBytes)||0);state.hasAudio=!!m.hasAudio;if(m.asrUsage&&['inputTokens','outputTokens','totalTokens'].every(k=>Number.isSafeInteger(m.asrUsage[k])&&m.asrUsage[k]>=0&&m.asrUsage[k]<=2e12))state.asrUsage={inputTokens:m.asrUsage.inputTokens,outputTokens:m.asrUsage.outputTokens,totalTokens:m.asrUsage.totalTokens};if(!state.hasAudio&&state.seconds>8)state.message='未检测到声音，请播放直播并检查播放器是否静音。';enqueue(utterances.flush());await persist();return;}
      const text=typeof m.text==='string'?m.text.trim().slice(-1500):'',preview=typeof m.preview==='string'?m.preview.slice(0,500):'';
      const transcriptEpoch=epoch;state.lastSource=(text+preview).slice(0,2000);await caption({source:state.lastSource,preview:true});
      if(transcriptEpoch!==epoch||m.sessionId!==state.sessionId||!['connecting','active'].includes(state.state))return;
      if(Number.isSafeInteger(m.beginMs)&&m.beginMs>=0)state.sourceTime={beginMs:m.beginMs,...(Number.isSafeInteger(m.endMs)&&m.endMs>=m.beginMs?{endMs:m.endMs}:{})};
      const itemId=String(m.itemId??'unknown').slice(0,100),receivedAt=Number.isFinite(m.receivedAt)&&Math.abs(Date.now()-m.receivedAt)<10000?m.receivedAt:Date.now(),previous=sourceMeta.get(itemId);counters.asrEvents++;if(!m.final){counters.asrIntermediate++;if(text)counters.asrStableIntermediate++;}
      const incomingEnd=Number.isFinite(m.sourceEndAt)&&m.sourceEndAt<=receivedAt&&m.sourceEndAt>receivedAt-60000?m.sourceEndAt:undefined,carriedEnd=previous?.sourceEndAt!==undefined&&previous.sourceEndAt<=receivedAt&&previous.sourceEndAt>receivedAt-60000?previous.sourceEndAt:undefined,sourceEndAt=incomingEnd??carriedEnd;
      sourceMeta.set(itemId,{firstAt:previous?.firstAt??receivedAt,receivedAt,...(sourceEndAt!==undefined?{sourceEndAt}:{})});while(sourceMeta.size>32)sourceMeta.delete(sourceMeta.keys().next().value!);enqueue(utterances.update(itemId,text,!!m.final));
      if(m.final&&!finalItems.has(itemId)){finalItems.add(itemId);if(finalItems.size>64)finalItems.delete(finalItems.values().next().value!);context=(context+' '+text).slice(-600);}
      if(m.final)await persist();return;
    }
    if(m.type==='speech:stop'&&!ui){if(sender.tab?.id!==state.tabId||m.sessionId!==state.sessionId)throw new Error('无权停止其他标签页音频。');const hint=liveInterruptHint(m.cause);return serial(()=>m.sessionId===state.sessionId?stop(hint,false,hint):Promise.resolve(state));}
    if(!ui)throw new Error('此操作仅允许在扩展界面中执行。');
    if(m.type==='speech:diagnostics'){const local=await chrome.storage.local.get(['speechSettings','settings','captionLayout']);const speech=local.speechSettings??DEFAULT_SPEECH,profile=(local.settings?.profiles??[]).find((item:{id?:string;model?:unknown;stream?:unknown})=>item?.id===local.settings?.activeProfileId),target=(typeof config==='undefined'?undefined:config?.target)??local.settings?.target;return {extensionVersion:chrome.runtime.getManifest().version,...diagnostics.report(),counters:{...counters},settings:diagnosticSettings({asrModel:speech.model,language:speech.language,textModel:profile?.model,textStream:profile?.stream,readingMode:local.captionLayout?.readingMode??'balanced',target}),policy:{maxQueue:LIVE_QUEUE_LIMIT,skipAfterMs:SKIP_AFTER_MS,expireAfterMs:EXPIRE_AFTER_MS,translationTimeoutMs:TRANSLATION_TIMEOUT_MS}};}
    if(m.type==='speech:diagnostics-clear'){diagnostics.clear();counters={asrEvents:0,asrIntermediate:0,asrStableIntermediate:0};await persist();return true;}
    if(m.type==='speech:settings-get')return (await chrome.storage.local.get('speechSettings')).speechSettings??DEFAULT_SPEECH;
    if(m.type==='speech:settings-save'){const next=normalizeSpeech(m.settings);if(['active','connecting'].includes(state.state))await serial(()=>stop('语音配置已修改，请重新开始。'));await chrome.storage.local.set({speechSettings:next});return true;}
    if(m.type==='speech:status')return speechStatusOrIdle(state);
    if(m.type==='speech:start')return serial(()=>start());
    if(m.type==='speech:test')return serial(()=>start(true));
    if(m.type==='speech:stop')return serial(()=>stop());
    throw new Error('不支持的语音操作。');
  }
  chrome.tabs.onRemoved.addListener(id=>{void loaded.then(()=>{if(id===state.tabId&&['active','connecting'].includes(state.state))return serial(()=>stop('直播标签页已关闭。'));}).catch(()=>{});});
  chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status!=='loading')return;void loaded.then(()=>{if(id!==state.tabId)return;const hint=liveInterruptHint('refresh');if(['active','connecting'].includes(state.state))void serial(()=>stop(hint,false,hint));else if(state.state==='stopped'&&state.message===liveInterruptHint('leave'))void serial(async()=>{if(state.state!=='stopped'||state.message!==liveInterruptHint('leave'))return;state={...state,message:hint};await persist();});}).catch(()=>{});});
  return {route};
}
