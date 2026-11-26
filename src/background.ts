import {DEFAULT_SETTINGS, configFor, isPageStatus, isVideoStatus, pageStatusOrIdle, videoStatusOrEmpty, type Settings, type TranslationInput, type TranslationResult,type TranslationObserver} from './core/types';
import {endpointFor,validateSettings,validateInput} from './core/validation';
import {Scheduler} from './core/scheduler';
import {adapterFor,retryDelayMs} from './core/provider';
import {TranslationCache,cacheKey} from './core/cache';
import {SharedWork} from './core/shared';
import {createSpeechController} from './speech-background';
import {isYouTubePage,type PlayerState} from './core/player';
import {DEFAULT_CAPTION,captionGeometryPatch,migrateCaption,normalizeCaption,validateCaption,type CaptionLayout} from './core/caption-layout';
import {streamSegment} from './core/stream-text';
import {isLiveSubtitle,liveMaxTranslationChars,LIVE_LEAK_CONTEXT_MIN_CHARS} from './core/live-translate';

const scheduler=new Scheduler(2),cache=new TranslationCache();
const sharedRequests=new SharedWork<TranslationResult>();
const jobs=new Map<string,{controller:AbortController;tabId:number;frameId:number;taskId:string}>();
const taskBudget=new Map<string,{chars:number;limit:number}>();
const cancelledTasks=new Set<string>();
let settings:Settings=structuredClone(DEFAULT_SETTINGS);
let jobHistory:Record<string,{state:string;time:number}>={};
let cacheEpoch=0;
let storageWrites=Promise.resolve();
let cachePersistTimer:ReturnType<typeof setTimeout>|undefined;
const videoTabs=new Set<number>();
const write=(values:Record<string,unknown>)=> {storageWrites=storageWrites.catch(()=>{}).then(()=>chrome.storage.session.set(values));return storageWrites;};
function persistCacheSoon(){
  if(cachePersistTimer!==undefined)return;
  cachePersistTimer=setTimeout(()=>{cachePersistTimer=undefined;void write({translationCache:cache.snapshot()});},600);
}
function flushCacheNow(){
  if(cachePersistTimer===undefined)return Promise.resolve();
  clearTimeout(cachePersistTimer);cachePersistTimer=undefined;
  return write({translationCache:cache.snapshot()});
}
function flushCacheClear(){
  if(cachePersistTimer!==undefined){clearTimeout(cachePersistTimer);cachePersistTimer=undefined;}
  return write({translationCache:[]});
}
const initialized=(async()=>{
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  const local=await chrome.storage.local.get('settings');
  if(local.settings){try{validateSettings(local.settings);settings=local.settings;}catch{ /* Keep recoverable defaults if an old configuration is malformed. */ }}
  const session=await chrome.storage.session.get(['translationCache','jobHistory','taskBudgets']);
  cache.load(session.translationCache??[]);
  for(const [key,value] of Object.entries(session.taskBudgets??{}))taskBudget.set(key,value as {chars:number;limit:number});
  const history=session.jobHistory??{};jobHistory=history;
  for(const key of Object.keys(history))if(['queued','running'].includes(history[key].state))history[key].state='interrupted';
  await write({jobHistory:history});
  const selectionDefaults=await chrome.storage.local.get('selectionDefaultsVersion');
  if(selectionDefaults.selectionDefaultsVersion!==1)await chrome.storage.local.set({selectionDefaultsVersion:1,selectionOrigins:['https://*/*','http://*/*']});
  const storedCaption=(await chrome.storage.local.get('captionLayout')).captionLayout;
  const migratedCaption=migrateCaption(storedCaption);
  if(migratedCaption)await chrome.storage.local.set({captionLayout:migratedCaption});
})();
const trusted=(sender:chrome.runtime.MessageSender)=> sender.id===chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
let captionWrites=Promise.resolve<unknown>(undefined);
async function captionLayout():Promise<CaptionLayout>{return normalizeCaption((await chrome.storage.local.get('captionLayout')).captionLayout);}
function saveCaption(patch:Partial<CaptionLayout>,reset=false){const next=captionWrites.catch(()=>{}).then(async()=>{const s=reset?structuredClone(DEFAULT_CAPTION):{...await captionLayout(),...patch};validateCaption(s);await chrome.storage.local.set({captionLayout:s});const targets=videoTabs.size?[...videoTabs]:(await chrome.tabs.query({active:true})).filter(t=>t.id!==undefined&&/^https?:\/\//.test(t.url??'')).map(t=>t.id!);await Promise.all(targets.map(id=>chrome.tabs.sendMessage(id,{type:'video:layout',layout:s},{frameId:0}).catch(()=>{})));return s;});captionWrites=next;return next;}
const speech=createSpeechController({ready:initialized,config:safeConfig,onTabAttach:id=>{videoTabs.add(id);},translate:async(input,tabId,observer)=>{const tab=await chrome.tabs.get(tabId);return translate(input,{id:chrome.runtime.id,tab,frameId:0,url:tab.url},observer);},cancel:taskId=>{for(const job of jobs.values())if(job.taskId===taskId)job.controller.abort();}});
const pageSender=(sender:chrome.runtime.MessageSender)=> sender.id===chrome.runtime.id && sender.tab?.id!==undefined && /^https?:\/\//.test(sender.url??'');
function errorText(error:unknown){return error instanceof Error?error.message:'操作失败，请重试。';}
async function recordJob(key:string,state:string) {
  const history=jobHistory;
  history[key]={state,time:Date.now()};const keys=Object.keys(history).sort((a,b)=>history[a].time-history[b].time);
  for(const old of keys.slice(0,Math.max(0,keys.length-100)))delete history[old];
  await write({jobHistory:structuredClone(history)});
}
async function permissionsForProfiles(s:Settings){
  for(const p of s.profiles){const permission=endpointFor(p.baseUrl).permission;if(!await chrome.permissions.contains({origins:[permission]}))throw new Error('请先授权 API 服务地址的访问权限。');}
}
async function safeConfig(profileId?:string){
  await initialized;
  if(profileId&&settings.profiles.some(p=>p.id===profileId))return configFor({...settings,activeProfileId:profileId});
  return configFor(settings);
}
async function activeTab(){const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(tab?.id===undefined||!/^https?:\/\//.test(tab.url??''))throw new Error('此页面无法翻译。请打开普通 HTTP 或 HTTPS 网页。');return tab;}
async function pageStatus(tabId:number,live:unknown){if(isPageStatus(live))return live;const stored=await chrome.storage.session.get(`page:${tabId}`);return pageStatusOrIdle(undefined,stored[`page:${tabId}`]);}
async function inject(tabId:number){await chrome.scripting.executeScript({target:{tabId},files:['content.js']});}
async function tabAction(action:string,tabId?:number){
  if(!['start','stop','restore','retry','display'].includes(action))throw new Error('不支持的页面操作。');
  const tab=tabId===undefined?await activeTab():await chrome.tabs.get(tabId);
  if(tab.id===undefined||!/^https?:\/\//.test(tab.url??''))throw new Error('此页面无法翻译。');
  await inject(tab.id);
  const config=await safeConfig();
  if(action==='start'&&!config.ready)throw new Error('请先在设置中填写 API Key 和模型。');
  if(action==='start'||action==='retry'){
    for(const [key,job] of jobs)if(job.tabId===tab.id && job.frameId===0 && !job.taskId.startsWith('selection-')&&!job.taskId.startsWith('subtitle-'))job.controller.abort();
    const taskId=crypto.randomUUID();
    for(const key of taskBudget.keys())if(key.startsWith(`${tab.id}:0:`))taskBudget.delete(key);
    taskBudget.set(`${tab.id}:0:${taskId}`,{chars:0,limit:settings.maxPageChars});
    await write({taskBudgets:Object.fromEntries(taskBudget)});
    return chrome.tabs.sendMessage(tab.id,{type:`page:${action}`,config,taskId},{frameId:0});
  }
  return chrome.tabs.sendMessage(tab.id,{type:`page:${action}`,display:settings.display},{frameId:0});
}
async function translate(input:TranslationInput,sender:chrome.runtime.MessageSender,observer?:TranslationObserver){
  validateInput(input);const internal=trusted(sender);
  if(internal && input.kind!=='test')throw new Error('无效测试请求。');
  if(!internal && (!pageSender(sender) || input.kind==='test'))throw new Error('无效页面请求。');
  const profile=settings.profiles.find(p=>p.id===input.profileId);
  if(!profile?.apiKey)throw new Error('请先配置 API Key。');
  if(!await chrome.permissions.contains({origins:[endpointFor(profile.baseUrl).permission]}))throw new Error('API 服务尚未获得访问授权，请打开设置保存配置。');
  const tabId=sender.tab?.id??-1,frameId=sender.frameId??0,key=`${tabId}:${frameId}:${input.requestId}`;
  if(cancelledTasks.has(`${tabId}:${frameId}:${input.taskId}`))throw new Error('翻译已取消。');
  if(jobs.has(key))throw new Error('此请求已在处理中。');
  if(jobs.size>=32 || [...jobs.values()].filter(j=>j.tabId===tabId).length>=6)throw new Error('翻译队列已满，请稍后重试。');
  const controller=new AbortController();jobs.set(key,{controller,tabId,frameId,taskId:input.taskId});
  try{
  if(input.kind==='page'){
    const budget=taskBudget.get(`${tabId}:${frameId}:${input.taskId}`);if(!budget)throw new Error('翻译任务已失效，请重新开始。');
    const chars=input.blocks.reduce((n,b)=>n+b.segments.reduce((m,s)=>m+s.text.length,0),0);
    if(budget.chars+chars>budget.limit*2)throw new Error('已达到本页请求上限。请调整上限或重新开始。');
    budget.chars+=chars;await write({taskBudgets:Object.fromEntries(taskBudget)});
  }
  const epoch=cacheEpoch;
  const lookup=settings.cacheEnabled?await cache.lookupBlocks(profile,input):undefined;
  const networkInput=lookup?{...input,blocks:lookup.missing}:input;
    if(!networkInput.blocks.length)return {segments:lookup!.segments,cached:true,usage:{input:0,output:0,estimatedCost:0}};
  const cachedKey=await cacheKey(profile,networkInput);
    await recordJob(key,'queued');
    const shared=await sharedRequests.run(`${epoch}:${cachedKey}${observer?':'+input.requestId:''}`,controller.signal,networkSignal=>scheduler.enqueue(input.kind==='page'?0:input.kind==='subtitle'?10:20,networkSignal,async()=>{
      await recordJob(key,'running');
      let lastProgress=0,firstToken=false,lastText='',pendingText='',progressTimer:ReturnType<typeof setTimeout>|undefined;observer?.start?.(profile.stream);
      const clearProgress=()=>{if(progressTimer)clearTimeout(progressTimer);progressTimer=undefined;};
      const flushProgress=()=>{clearProgress();if(networkSignal.aborted||!pendingText||pendingText===lastText)return;lastProgress=Date.now();lastText=pendingText;observer?.text?.(pendingText);};
      networkSignal.addEventListener('abort',clearProgress,{once:true});
      const progress=(raw:string)=>{
        if(observer&&!networkSignal.aborted){if(!firstToken&&raw){firstToken=true;observer.token?.();}const source=networkInput.blocks[0]?.segments[0];if(networkInput.blocks.length===1&&networkInput.blocks[0].segments.length===1&&source){const hasLongContext=Array.from(networkInput.blocks[0].context.trim()).length>=LIVE_LEAK_CONTEXT_MIN_CHARS;const limit=isLiveSubtitle(input)&&hasLongContext?liveMaxTranslationChars(source.text,input.target):Math.max(500,source.text.length*12);const text=streamSegment(raw,source.id,limit);if(text&&text!==lastText){pendingText=text;const wait=80-(Date.now()-lastProgress);if(wait<=0)flushProgress();else if(!progressTimer)progressTimer=setTimeout(flushProgress,wait);}}return;}
        // Single-segment non-live subtitle streaming (e.g., YouTube visible captions) previews text early.
        if(input.kind==='subtitle'&&!isLiveSubtitle(input)&&profile.stream&&networkInput.blocks.length===1&&networkInput.blocks[0].segments.length===1&&Date.now()-lastProgress>=80){
          const source=networkInput.blocks[0].segments[0];
          const text=streamSegment(raw,source.id,Math.max(500,source.text.length*12));
          if(text&&text!==lastText){lastProgress=Date.now();lastText=text;chrome.tabs.sendMessage(tabId,{type:'video:subtitle-progress',requestId:input.requestId,text},{frameId}).catch(()=>{});}
          return;
        }
        // A validated prefix is only for the one plain-text selection preview; final result is still fully validated.
        if(input.kind!=='selection'||!profile.stream||Date.now()-lastProgress<100)return;
        const match=raw.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/s);if(!match)return;
        let text:string;try{text=JSON.parse(`"${match[1]}"`);}catch{return;}
        lastProgress=Date.now();chrome.tabs.sendMessage(tabId,{type:'selection:progress',requestId:input.requestId,text},{frameId}).catch(()=>{});
      };
      let result;
      try{for(let attempt=0;attempt<2;attempt++){
        try{result=await adapterFor(profile).translate(profile,networkInput,networkSignal,progress);break;}
        catch(error){const delay=retryDelayMs(error,attempt);if(delay!==undefined){await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>{networkSignal.removeEventListener('abort',abort);resolve();},delay);const abort=()=>{clearTimeout(timeout);reject(new DOMException('已取消','AbortError'));};networkSignal.addEventListener('abort',abort,{once:true});if(networkSignal.aborted)abort();});continue;}throw error;}
      }}finally{clearProgress();networkSignal.removeEventListener('abort',clearProgress);}
      if(!result)throw new Error('翻译失败。');
      if(networkSignal.aborted)throw new DOMException('已取消','AbortError');
      if(settings.cacheEnabled&&epoch===cacheEpoch&&lookup){cache.putBlocks(lookup.keys,input,result);persistCacheSoon();}
      // The scheduler serializes this short update separately from long network calls.
      await updateUsage(result.usage);
      return result;
    },isLiveSubtitle(input)?'live':'shared'));
    await recordJob(key,'completed');
    const ids=networkInput.blocks.flatMap(b=>b.segments.map(s=>s.id));
    const output=new Map([...(lookup?.segments??[]),...shared.value.segments.map((s,i)=>({id:ids[i],text:s.text}))].map(s=>[s.id,s.text]));
    return {...shared.value,segments:input.blocks.flatMap(b=>b.segments.map(s=>({id:s.id,text:output.get(s.id)!}))),usage:shared.shared?{input:0,output:0,estimatedCost:0}:shared.value.usage};
  }catch(error){await recordJob(key,controller.signal.aborted?'cancelled':'failed');throw error;}
  finally{jobs.delete(key);}
}
let usageWrites=Promise.resolve();
function updateUsage(next:TranslationResult['usage']){
  usageWrites=usageWrites.catch(()=>{}).then(async()=>{const data=await chrome.storage.local.get('usage');const old=data.usage??{input:0,output:0,estimatedCost:0,requests:0};await chrome.storage.local.set({usage:{input:old.input+next.input,output:old.output+next.output,estimatedCost:old.estimatedCost+next.estimatedCost,requests:old.requests+(next.requests??1)}});});return usageWrites;
}
let selectionRegistration=Promise.resolve<string[]>([]);
function registerSelection(){
  selectionRegistration=selectionRegistration.catch(()=>[]).then(async()=>{
  const stored=await chrome.storage.local.get('selectionOrigins');const selected:string[]=stored.selectionOrigins??[];
  const allowed:string[]=[];for(const origin of selected)if(await chrome.permissions.contains({origins:[origin]}))allowed.push(origin);
  await chrome.scripting.unregisterContentScripts({ids:['selection-listener']}).catch(()=>{});
  if(allowed.length)await chrome.scripting.registerContentScripts([{id:'selection-listener',matches:allowed,js:['content.js'],runAt:'document_idle',allFrames:true,persistAcrossSessions:true}]);
  const tabs=await chrome.tabs.query({});
  await Promise.all(tabs.filter(t=>t.id!==undefined&&/^https?:\/\//.test(t.url??'')).map(t=>chrome.tabs.sendMessage(t.id!,{type:'selection:refresh'}).catch(()=>{})));
  return allowed;
  });return selectionRegistration;
}
async function selectionState(url:string){
  let parsed:URL;try{parsed=new URL(url);}catch{return {enabled:false,supported:false};}
  if(!['https:','http:'].includes(parsed.protocol))return {enabled:false,supported:false};
  const pattern=`${parsed.protocol}//${parsed.hostname}/*`;
  const stored=await chrome.storage.local.get('selectionOrigins');const origins:string[]=stored.selectionOrigins??[];
  const configured=origins.some(origin=>origin===pattern||origin===`${parsed.protocol}//*/*`);
  return {enabled:configured&&await chrome.permissions.contains({origins:[pattern]}),supported:true};
}
async function playerStatus(tabId:number):Promise<PlayerState>{
  const [voice,video,commands,layout]=await Promise.all([
    speech.statusForTab(tabId),
    chrome.tabs.sendMessage(tabId,{type:'video:player-status'},{frameId:0}).catch(()=>undefined),
    chrome.commands.getAll(),
    captionLayout()
  ]);
  return {
    speech:voice,
    captions:video&&typeof video.state==='string'&&typeof video.message==='string'?{state:video.state,message:video.message}:{state:'idle',message:''},
    shortcut:commands.find(c=>c.name==='toggle-speech')?.shortcut??'',
    showOriginal:layout.showOriginal,
    captionStyle:layout.style??'glass',
    fontSize:layout.fontSize
  };
}
async function route(message:any,sender:chrome.runtime.MessageSender){
  await initialized;if(!message||typeof message.type!=='string')throw new Error('无效消息。');
  if(message.type.startsWith('speech:'))return speech.route(message,sender);
  if(message.type.startsWith('player:')){
    if(!pageSender(sender)||sender.frameId!==0||!isYouTubePage(sender.url??''))throw new Error('播放器操作只允许来自当前 YouTube 页面。');
    const tabId=sender.tab!.id!;
    if(message.type==='player:status')return playerStatus(tabId);
    if(message.type==='player:changed'){void chrome.tabs.sendMessage(tabId,{type:'player:refresh'},{frameId:0}).catch(()=>{});return;}
    if(message.type==='player:settings')return chrome.runtime.openOptionsPage();
    if(message.type==='player:shortcuts'){await chrome.tabs.create({url:'chrome://extensions/shortcuts'});return;}
    if(message.type==='player:bilingual'){await saveCaption({showOriginal:message.showOriginal!==false});return playerStatus(tabId);}
    if(message.type==='player:caption'){
      const patch:Partial<CaptionLayout>={};
      for(const key of ['showOriginal','style','fontSize'] as const)if(key in (message.patch??{}))(patch as any)[key]=message.patch[key];
      await saveCaption(patch);
      return playerStatus(tabId);
    }
    if(message.type!=='player:action'||!['speech','captions'].includes(message.mode)||!['start','stop'].includes(message.action))throw new Error('不支持的播放器操作。');
    if(message.mode==='speech')await speech.controlTab(tabId,message.action);
    else{
      const current=await speech.statusForTab(tabId);
      if(message.action==='start'){
        const config=await safeConfig();if(!config.ready)throw new Error('请先在翻译设置中配置 API Key 和模型。');
        if(['active','connecting'].includes(current.state))await speech.controlTab(tabId,'stop');
        await chrome.scripting.executeScript({target:{tabId},files:['video.js']});
        videoTabs.add(tabId);
        await chrome.tabs.sendMessage(tabId,{type:'video:start',config},{frameId:0});
      }else if(!['active','connecting'].includes(current.state))await chrome.tabs.sendMessage(tabId,{type:'video:stop'},{frameId:0}).catch(()=>{});
    }
    return playerStatus(tabId);
  }
  const ui=trusted(sender);
  if(message.type==='caption:get'&&(ui||pageSender(sender)))return captionLayout();
  if(message.type==='caption:position'&&pageSender(sender)){
    if(!['normal','fullscreen'].includes(message.context))throw new Error('字幕位置类型无效。');
    return saveCaption({[message.context]:message.position});
  }
  if(message.type==='caption:geometry'&&pageSender(sender))return saveCaption(captionGeometryPatch(String(message.context??''),message.position,message.size,message.fontSize));
  if(message.type==='caption:quick'&&pageSender(sender)){
    const patch:Partial<CaptionLayout>={};
    for(const key of ['showOriginal','fontSize','locked'] as const)if(key in (message.patch??{}))(patch as any)[key]=message.patch[key];
    return saveCaption(patch);
  }
  if(message.type==='selection:state'&&(ui||pageSender(sender)))return selectionState(ui?String(message.url??''):sender.url!);
  if(message.type==='selection:settings'&&pageSender(sender))return chrome.runtime.openOptionsPage();
  if(message.type==='translate')return translate(message.input,sender);
  if(message.type==='page:config'&&pageSender(sender))return safeConfig();
  if(message.type==='page:status'&&pageSender(sender)){
    if(sender.frameId!==0)return;
    const s=message.status;if(!isPageStatus(s)||s.message.length>400)throw new Error('无效进度。');
    if(['done','watching','stopped'].includes(s.state))await flushCacheNow();
    await write({[`page:${sender.tab!.id}`]:s});return;
  }
  if(message.type==='task:heartbeat'&&(pageSender(sender)||ui))return true;
  if(message.type==='task:cancel'&&pageSender(sender)){
    const token=`${sender.tab!.id}:${sender.frameId??0}:${message.taskId}`;cancelledTasks.add(token);
    if(cancelledTasks.size>200)cancelledTasks.delete(cancelledTasks.values().next().value!);
    for(const job of jobs.values())if(job.tabId===sender.tab!.id&&job.frameId===(sender.frameId??0)&&job.taskId===message.taskId)job.controller.abort();return;
  }
  if(!ui)throw new Error('此操作仅允许在扩展界面中执行。');
  switch(message.type){
    case 'caption:save':{const patch:Partial<CaptionLayout>={};for(const key of ['fontSize','width','opacity','mode','locked','showOriginal','readingMode','style'] as const)if(key in (message.patch??{}))(patch as any)[key]=message.patch[key];if('width' in patch){patch.normalSize=undefined;patch.fullscreenSize=undefined;}return saveCaption(patch);}
    case 'caption:reset':return saveCaption({},true);
    case 'settings:get':return settings;
    case 'settings:save':{
      validateSettings(message.settings);await permissionsForProfiles(message.settings);settings=structuredClone(message.settings);
      await chrome.storage.local.set({settings});cacheEpoch++;cache.clear();await flushCacheClear();return true;
    }
    case 'preferences:save':{
      const candidate={...settings,target:message.target,display:message.display,activeProfileId:message.profileId};validateSettings(candidate);settings=candidate;await chrome.storage.local.set({settings});return true;
    }
    case 'tab:action':return tabAction(message.action);
    case 'video:action':{
      if(!['start','stop','display','retry'].includes(message.action))throw new Error('不支持的视频操作。');
      if(message.action==='start'||message.action==='stop')await speech.route({type:'speech:stop'},sender);
      if(message.action==='display'||(message.action==='start'&&typeof message.bilingual==='boolean'))await saveCaption({showOriginal:message.bilingual!==false});
      const tab=await activeTab();await chrome.scripting.executeScript({target:{tabId:tab.id!},files:['video.js']});videoTabs.add(tab.id!);
      const config=await safeConfig();if(message.action==='start'&&!config.ready)throw new Error('请先配置 API Key 和模型。');
      const replied=await chrome.tabs.sendMessage(tab.id!,{type:`video:${message.action}`,config,bilingual:message.bilingual!==false},{frameId:0});
      if(isVideoStatus(replied))return replied;
      try{return videoStatusOrEmpty(await chrome.tabs.sendMessage(tab.id!,{type:'video:get-status'},{frameId:0}));}catch{return videoStatusOrEmpty(undefined);}
    }
    case 'video:status':{const tab=await activeTab();try{return videoStatusOrEmpty(await chrome.tabs.sendMessage(tab.id!,{type:'video:get-status'},{frameId:0}));}catch{return videoStatusOrEmpty(undefined);}}
    case 'tab:status':{const tab=await activeTab();try{return await pageStatus(tab.id!,await chrome.tabs.sendMessage(tab.id!,{type:'page:get-status'},{frameId:0}));}catch{return pageStatus(tab.id!,undefined);}}
    case 'selection:origins':{const data=await chrome.storage.local.get('selectionOrigins');return data.selectionOrigins??[];}
    case 'selection:save':{
      if(!Array.isArray(message.origins)||message.origins.length>50)throw new Error('网站授权列表无效。');
      for(const origin of message.origins)if(typeof origin!=='string'||!/^https?:\/\/([^/]+)\/\*$/.test(origin)||!await chrome.permissions.contains({origins:[origin]}))throw new Error('网站尚未获得访问授权。');
      await chrome.storage.local.set({selectionOrigins:[...new Set(message.origins)]});return registerSelection();
    }
    case 'usage:get':return {usage:(await chrome.storage.local.get('usage')).usage??{input:0,output:0,estimatedCost:0,requests:0},cache:cache.size()};
    case 'cache:clear':cacheEpoch++;cache.clear();await flushCacheClear();return true;
    case 'usage:clear':await usageWrites;await chrome.storage.local.remove('usage');return true;
    default:throw new Error('不支持的操作。');
  }
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message?.target==='speech-offscreen')return;
  route(message,sender).then(data=>sendResponse({ok:true,data}),error=>sendResponse({ok:false,error:errorText(error)}));return true;
});
chrome.runtime.onInstalled.addListener(async()=>{
  await initialized;await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({id:'translate-selection',title:'用思译翻译选中文字',contexts:['selection'],documentUrlPatterns:['http://*/*','https://*/*']});
  await registerSelection();
});
chrome.runtime.onStartup.addListener(()=>{initialized.then(registerSelection).catch(()=>{});});
chrome.permissions.onRemoved.addListener(()=>registerSelection().catch(()=>{}));
chrome.permissions.onAdded.addListener(()=>registerSelection().catch(()=>{}));
chrome.contextMenus.onClicked.addListener(async(info,tab)=>{
  if(info.menuItemId!=='translate-selection'||!tab?.id||!info.selectionText)return;
  try{
    const frameId=info.frameId??0;
    await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[frameId]},files:['content.js']});
    await chrome.tabs.sendMessage(tab.id,{type:'selection:open',text:info.selectionText,config:await safeConfig()},{frameId});
    await chrome.action.setBadgeText({tabId:tab.id,text:''});
  }catch{
    try{await inject(tab.id);await chrome.tabs.sendMessage(tab.id,{type:'selection:open',text:info.selectionText,config:await safeConfig()},{frameId:0});}
    catch{await chrome.action.setBadgeText({tabId:tab.id,text:'!'});await chrome.action.setTitle({tabId:tab.id,title:'此页面无法访问。请在普通网页中使用思译。'});}
  }
});
chrome.commands.onCommand.addListener((command,tab)=>{
  const run=async()=>{
    await initialized;
    if(command==='toggle-speech'){
      const target=tab?.id===undefined?await activeTab():tab;
      await speech.controlTab(target.id!,'toggle');return;
    }
    if(command==='translate-page'||command==='restore-page')return tabAction(command==='restore-page'?'restore':'start');
  };
  void run().catch(async(error)=>{const target=tab?.id===undefined?(await chrome.tabs.query({active:true,currentWindow:true}))[0]:tab;if(target?.id){await chrome.action.setBadgeText({tabId:target.id,text:'!'});await chrome.action.setTitle({tabId:target.id,title:errorText(error)});void chrome.tabs.sendMessage(target.id,{type:'player:refresh'},{frameId:0}).catch(()=>{});}});
});
chrome.tabs.onRemoved.addListener(tabId=>{
  videoTabs.delete(tabId);
  for(const job of jobs.values())if(job.tabId===tabId)job.controller.abort();
  for(const key of taskBudget.keys())if(key.startsWith(`${tabId}:`))taskBudget.delete(key);
  initialized.then(()=>write({taskBudgets:Object.fromEntries(taskBudget)})).catch(()=>{});
  chrome.storage.session.remove(`page:${tabId}`).catch(()=>{});
});
chrome.tabs.onUpdated.addListener((tabId,change)=>{
  if(change.status!=='loading')return;
  for(const job of jobs.values())if(job.tabId===tabId)job.controller.abort();
  for(const key of taskBudget.keys())if(key.startsWith(`${tabId}:`))taskBudget.delete(key);
  initialized.then(()=>write({taskBudgets:Object.fromEntries(taskBudget)})).catch(()=>{});
  chrome.storage.session.remove(`page:${tabId}`).catch(()=>{});
});
