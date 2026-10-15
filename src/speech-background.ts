import {DEFAULT_SPEECH,IDLE_SPEECH,validateSpeech,speechAuthRule,type SpeechStatus,type SpeechSettings} from './core/speech';
import type {PublicConfig,TranslationInput,TranslationResult} from './core/types';
import {Utterances,enqueuePiece,type SpeechPiece} from './core/utterances';
export function createSpeechController(deps:{ready:Promise<unknown>;config:()=>Promise<PublicConfig>;translate:(input:TranslationInput,tabId:number)=>Promise<TranslationResult>;cancel:(taskId:string)=>void}){
  let state:SpeechStatus={...IDLE_SPEECH},config:PublicConfig,queue:SpeechPiece[]=[],busy=false,epoch=0,context='',shownOrder=-1;
  const utterances=new Utterances(),latest=new Map<string,string>(),translatedPieces=new Map<string,string>(),finalItems=new Set<string>();
  function enqueue(pieces:SpeechPiece[]){for(const piece of pieces){if(translatedPieces.get(piece.id)===piece.text)continue;latest.delete(piece.id);latest.set(piece.id,piece.text);queue=enqueuePiece(queue,{...piece,context:(context+' '+(piece.context??'')).trim().slice(-600)});while(latest.size>128){const key=latest.keys().next().value!;latest.delete(key);translatedPieces.delete(key);}}void pump();}
  let lock=Promise.resolve<unknown>(undefined),testing=false;
  const loaded=deps.ready.then(async()=>{const data=await chrome.storage.session.get(['speechState','speechConfig']);if(data.speechState)state=data.speechState;if(data.speechConfig)config=data.speechConfig;
    const contexts=await chrome.runtime.getContexts({contextTypes:[chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]});
    if(!contexts.length&&['active','connecting'].includes(state.state)){state={...state,state:'stopped',message:'上次音频会话已中断，请重新开启。'};await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[891]});}
  });
  let writes=Promise.resolve();
  const persist=()=>{const snapshot={speechState:{...state},...(config?{speechConfig:{...config}}:{})};writes=writes.catch(()=>{}).then(()=>chrome.storage.session.set(snapshot));return writes;};
  const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const next=lock.catch(()=>{}).then(fn);lock=next;return next;};
  const command=(extra:Record<string,unknown>)=>chrome.runtime.sendMessage({target:'speech-offscreen',...extra});
  const caption=(data:Record<string,unknown>)=>state.tabId<0?Promise.resolve():chrome.tabs.sendMessage(state.tabId,{type:'video:live-caption',sessionId:state.sessionId,...data},{frameId:0}).catch(()=>{});
  async function stop(message='实时语音翻译已停止。',error=false){
    epoch++;queue=[];busy=false;utterances.reset();latest.clear();translatedPieces.clear();finalItems.clear();deps.cancel(`subtitle-live-${state.sessionId}`);
    try{if((await chrome.runtime.getContexts({contextTypes:[chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]})).length){await command({action:'stop'});await chrome.offscreen.closeDocument();}}catch{ /* Closing a tab may have already released capture. */ }
    await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[891]});
    await caption({stop:true});state={...state,state:error?'error':'stopped',message};await chrome.action.setBadgeText({tabId:state.tabId>=0?state.tabId:undefined,text:''}).catch(()=>{});await persist();return state;
  }
  async function pump(){
    if(busy||state.state!=='active'||testing)return;const item=queue.shift();if(!item)return;
    if(Date.now()-item.at>12000){state.message='翻译跟不上语速，已跳过过期片段。';void persist();void pump();return;}
    if(translatedPieces.get(item.id)===item.text){void pump();return;}
    busy=true;const run=epoch,sessionId=state.sessionId,tabId=state.tabId,started=Date.now(),queueMs=started-item.at;
    const timeout=setTimeout(()=>{if(run===epoch){deps.cancel(`subtitle-live-${sessionId}`);epoch++;queue=[];busy=false;state.message='文字翻译超时，请点击重新开始，或更换更快的翻译模型。';void persist();}},12000);
    try{
      const result=await deps.translate({kind:'subtitle',taskId:`subtitle-live-${sessionId}`,requestId:crypto.randomUUID(),profileId:config.profileId,target:config.target,blocks:[{id:'live',context:item.context??'',segments:[{id:'live',text:item.text}]}]},tabId);
      if(run!==epoch||state.state!=='active'||Date.now()-item.at>15000)return;
      if(latest.has(item.id))translatedPieces.set(item.id,item.text);
      if(latest.get(item.id)!==item.text||item.order<shownOrder)return;
      shownOrder=item.order;
      state.lastTranslation=result.segments[0].text;state.completed++;state.message='正在识别并翻译标签页声音。';
      state.timing={queueMs,translationMs:Date.now()-started,textToCaptionMs:Date.now()-item.at};
      await caption({source:item.text,translation:state.lastTranslation,pieceId:item.id});await persist();
    }catch{if(run===epoch){state.message='文字翻译失败，语音识别仍在继续。请检查翻译模型、Key 或余额。';await persist();}}
    finally{clearTimeout(timeout);if(run===epoch){busy=false;void pump();}}
  }
  async function start(test=false){
    await stop();const saved=await chrome.storage.local.get('speechSettings');const settings:SpeechSettings=saved.speechSettings??DEFAULT_SPEECH;validateSpeech(settings);
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
    if(['speech:health','speech:ready','speech:transcript','speech:failed','speech:warning'].includes(m.type)){
      if(!offscreen)throw new Error('语音事件只允许来自音频处理页。');
      if(m.sessionId!==state.sessionId||!['connecting','active'].includes(state.state))return;
      if(m.type==='speech:failed')return serial(()=>m.sessionId===state.sessionId?stop(String(m.message??'音频连接失败。').slice(0,300),true):Promise.resolve(state));
      if(m.type==='speech:ready'){if(testing)return serial(()=>m.sessionId===state.sessionId?stop('语音连接成功，可以开始直播翻译。'):Promise.resolve(state));state.state='active';state.message='已连接，等待标签页声音。';await persist();return;}
      if(m.type==='speech:warning'){if(m.reconnecting){epoch++;busy=false;deps.cancel(`subtitle-live-${state.sessionId}`);state.state='connecting';utterances.reset();latest.clear();translatedPieces.clear();finalItems.clear();queue=[];shownOrder=-1;}state.message=String(m.message).slice(0,300);await persist();return;}
      if(m.type==='speech:health'){state.seconds=Math.max(0,Number(m.seconds)||0);state.sentBytes=Math.max(0,Number(m.sentBytes)||0);state.hasAudio=!!m.hasAudio;if(!state.hasAudio&&state.seconds>8)state.message='未检测到声音，请播放直播并检查播放器是否静音。';enqueue(utterances.flush());await persist();return;}
      const text=typeof m.text==='string'?m.text.trim().slice(-1500):'',preview=typeof m.preview==='string'?m.preview.slice(0,500):'';
      const transcriptEpoch=epoch;state.lastSource=(text+preview).slice(0,2000);await caption({source:state.lastSource,preview:true});
      if(transcriptEpoch!==epoch||m.sessionId!==state.sessionId||!['connecting','active'].includes(state.state))return;
      const itemId=String(m.itemId??'unknown').slice(0,100);enqueue(utterances.update(itemId,text,!!m.final));
      if(m.final&&!finalItems.has(itemId)){finalItems.add(itemId);if(finalItems.size>64)finalItems.delete(finalItems.values().next().value!);context=(context+' '+text).slice(-600);}
      await persist();return;
    }
    if(m.type==='speech:stop'&&!ui){if(sender.tab?.id!==state.tabId||m.sessionId!==state.sessionId)throw new Error('无权停止其他标签页音频。');return serial(()=>m.sessionId===state.sessionId?stop('视频已切换或拖动，请重新开始实时翻译。'):Promise.resolve(state));}
    if(!ui)throw new Error('此操作仅允许在扩展界面中执行。');
    if(m.type==='speech:settings-get')return (await chrome.storage.local.get('speechSettings')).speechSettings??DEFAULT_SPEECH;
    if(m.type==='speech:settings-save'){validateSpeech(m.settings);if(['active','connecting'].includes(state.state))await serial(()=>stop('语音配置已修改，请重新开始。'));await chrome.storage.local.set({speechSettings:m.settings});return true;}
    if(m.type==='speech:status')return {...state};
    if(m.type==='speech:start')return serial(()=>start());
    if(m.type==='speech:test')return serial(()=>start(true));
    if(m.type==='speech:stop')return serial(()=>stop());
    throw new Error('不支持的语音操作。');
  }
  chrome.tabs.onRemoved.addListener(id=>{void loaded.then(()=>{if(id===state.tabId&&['active','connecting'].includes(state.state))return serial(()=>stop('直播标签页已关闭。'));}).catch(()=>{});});
  chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status==='loading')void loaded.then(()=>{if(id===state.tabId&&['active','connecting'].includes(state.state))return serial(()=>stop('直播页面已刷新，请重新开始。'));}).catch(()=>{});});
  return {route};
}
