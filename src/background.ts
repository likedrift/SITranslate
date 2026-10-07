import {DEFAULT_SETTINGS, EMPTY_STATUS, configFor, type Settings, type TranslationInput, type PageStatus, type TranslationResult} from './core/types';
import {endpointFor,validateSettings,validateInput} from './core/validation';
import {Scheduler} from './core/scheduler';
import {adapterFor,ProviderError} from './core/provider';
import {TranslationCache,cacheKey} from './core/cache';
import {SharedWork} from './core/shared';

const scheduler=new Scheduler(2),cache=new TranslationCache();
const sharedRequests=new SharedWork<TranslationResult>();
const jobs=new Map<string,{controller:AbortController;tabId:number;frameId:number;taskId:string}>();
const taskBudget=new Map<string,{chars:number;limit:number}>();
const cancelledTasks=new Set<string>();
let settings:Settings=structuredClone(DEFAULT_SETTINGS);
let jobHistory:Record<string,{state:string;time:number}>={};
let cacheEpoch=0;
let storageWrites=Promise.resolve();
const write=(values:Record<string,unknown>)=> {storageWrites=storageWrites.catch(()=>{}).then(()=>chrome.storage.session.set(values));return storageWrites;};
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
})();
const trusted=(sender:chrome.runtime.MessageSender)=> sender.id===chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
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
async function safeConfig(){await initialized;return configFor(settings);}
async function activeTab(){const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(tab?.id===undefined||!/^https?:\/\//.test(tab.url??''))throw new Error('此页面无法翻译。请打开普通 HTTP 或 HTTPS 网页。');return tab;}
async function inject(tabId:number){await chrome.scripting.executeScript({target:{tabId},files:['content.js']});}
async function tabAction(action:string,tabId?:number){
  if(!['start','stop','restore','retry','display'].includes(action))throw new Error('不支持的页面操作。');
  const tab=tabId===undefined?await activeTab():await chrome.tabs.get(tabId);
  if(tab.id===undefined||!/^https?:\/\//.test(tab.url??''))throw new Error('此页面无法翻译。');
  await inject(tab.id);
  const config=await safeConfig();
  if(action==='start'&&!config.ready)throw new Error('请先在设置中填写 API Key 和模型。');
  if(action==='start'||action==='retry'){
    for(const [key,job] of jobs)if(job.tabId===tab.id && job.frameId===0 && !job.taskId.startsWith('selection-'))job.controller.abort();
    const taskId=crypto.randomUUID();
    for(const key of taskBudget.keys())if(key.startsWith(`${tab.id}:0:`))taskBudget.delete(key);
    taskBudget.set(`${tab.id}:0:${taskId}`,{chars:0,limit:settings.maxPageChars});
    await write({taskBudgets:Object.fromEntries(taskBudget)});
    return chrome.tabs.sendMessage(tab.id,{type:`page:${action}`,config,taskId},{frameId:0});
  }
  return chrome.tabs.sendMessage(tab.id,{type:`page:${action}`,display:settings.display},{frameId:0});
}
async function translate(input:TranslationInput,sender:chrome.runtime.MessageSender){
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
  const cachedKey=await cacheKey(profile,input);
  const epoch=cacheEpoch;
    if(settings.cacheEnabled){const hit=cache.get(cachedKey,input);if(hit)return hit;}
    await recordJob(key,'queued');
    const shared=await sharedRequests.run(`${epoch}:${cachedKey}`,controller.signal,networkSignal=>scheduler.enqueue(input.kind==='page'?0:10,networkSignal,async()=>{
      await recordJob(key,'running');
      let lastProgress=0;
      const progress=(raw:string)=>{
        // A validated prefix is only for the one plain-text selection preview; final result is still fully validated.
        if(input.kind!=='selection'||!profile.stream||Date.now()-lastProgress<100)return;
        const match=raw.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/s);if(!match)return;
        let text:string;try{text=JSON.parse(`"${match[1]}"`);}catch{return;}
        lastProgress=Date.now();chrome.tabs.sendMessage(tabId,{type:'selection:progress',requestId:input.requestId,text},{frameId}).catch(()=>{});
      };
      let result;
      for(let attempt=0;attempt<2;attempt++){
        try{result=await adapterFor(profile).translate(profile,input,networkSignal,progress);break;}
        catch(error){if(attempt===0&&error instanceof ProviderError&&error.retryable){await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>{networkSignal.removeEventListener('abort',abort);resolve();},1500);const abort=()=>{clearTimeout(timeout);reject(new DOMException('已取消','AbortError'));};networkSignal.addEventListener('abort',abort,{once:true});if(networkSignal.aborted)abort();});continue;}throw error;}
      }
      if(!result)throw new Error('翻译失败。');
      if(networkSignal.aborted)throw new DOMException('已取消','AbortError');
      if(settings.cacheEnabled&&epoch===cacheEpoch){cache.put(cachedKey,result.segments.map(s=>s.text));await write({translationCache:cache.snapshot()});}
      // The scheduler serializes this short update separately from long network calls.
      await updateUsage(result.usage);
      return result;
    }));
    await recordJob(key,'completed');
    const ids=input.blocks.flatMap(b=>b.segments.map(s=>s.id));
    return {...shared.value,segments:shared.value.segments.map((s,i)=>({id:ids[i],text:s.text})),usage:shared.shared?{input:0,output:0,estimatedCost:0}:shared.value.usage};
  }catch(error){await recordJob(key,controller.signal.aborted?'cancelled':'failed');throw error;}
  finally{jobs.delete(key);}
}
let usageWrites=Promise.resolve();
function updateUsage(next:{input:number;output:number;estimatedCost:number}){
  usageWrites=usageWrites.catch(()=>{}).then(async()=>{const data=await chrome.storage.local.get('usage');const old=data.usage??{input:0,output:0,estimatedCost:0,requests:0};await chrome.storage.local.set({usage:{input:old.input+next.input,output:old.output+next.output,estimatedCost:old.estimatedCost+next.estimatedCost,requests:old.requests+1}});});return usageWrites;
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
async function route(message:any,sender:chrome.runtime.MessageSender){
  await initialized;if(!message||typeof message.type!=='string')throw new Error('无效消息。');
  const ui=trusted(sender);
  if(message.type==='selection:state'&&(ui||pageSender(sender)))return selectionState(ui?String(message.url??''):sender.url!);
  if(message.type==='translate')return translate(message.input,sender);
  if(message.type==='page:config'&&pageSender(sender))return safeConfig();
  if(message.type==='page:status'&&pageSender(sender)){
    if(sender.frameId!==0)return;
    const s=message.status as PageStatus;if(!s||!['idle','scanning','translating','watching','done','stopped'].includes(s.state)||!['total','completed','failed','chars'].every(k=>Number.isFinite(s[k as keyof PageStatus])&&Number(s[k as keyof PageStatus])>=0)||typeof s.message!=='string'||s.message.length>400)throw new Error('无效进度。');
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
    case 'settings:get':return settings;
    case 'settings:save':{
      validateSettings(message.settings);await permissionsForProfiles(message.settings);settings=structuredClone(message.settings);
      await chrome.storage.local.set({settings});cacheEpoch++;cache.clear();await write({translationCache:[]});return true;
    }
    case 'preferences:save':{
      const candidate={...settings,target:message.target,display:message.display,activeProfileId:message.profileId};validateSettings(candidate);settings=candidate;await chrome.storage.local.set({settings});return true;
    }
    case 'tab:action':return tabAction(message.action);
    case 'tab:status':{const tab=await activeTab();try{return await chrome.tabs.sendMessage(tab.id!,{type:'page:get-status'},{frameId:0});}catch{const stored=await chrome.storage.session.get(`page:${tab.id}`);return {...EMPTY_STATUS,...stored[`page:${tab.id}`],state:'idle',message:''};}}
    case 'selection:origins':{const data=await chrome.storage.local.get('selectionOrigins');return data.selectionOrigins??[];}
    case 'selection:save':{
      if(!Array.isArray(message.origins)||message.origins.length>50)throw new Error('网站授权列表无效。');
      for(const origin of message.origins)if(typeof origin!=='string'||!/^https?:\/\/([^/]+)\/\*$/.test(origin)||!await chrome.permissions.contains({origins:[origin]}))throw new Error('网站尚未获得访问授权。');
      await chrome.storage.local.set({selectionOrigins:[...new Set(message.origins)]});return registerSelection();
    }
    case 'usage:get':return {usage:(await chrome.storage.local.get('usage')).usage??{input:0,output:0,estimatedCost:0,requests:0},cache:cache.size()};
    case 'cache:clear':cacheEpoch++;cache.clear();await write({translationCache:[]});return true;
    case 'usage:clear':await usageWrites;await chrome.storage.local.remove('usage');return true;
    default:throw new Error('不支持的操作。');
  }
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
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
chrome.commands.onCommand.addListener(command=>tabAction(command==='restore-page'?'restore':'start').catch(async(error)=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(tab?.id){await chrome.action.setBadgeText({tabId:tab.id,text:'!'});await chrome.action.setTitle({tabId:tab.id,title:errorText(error)});}}));
chrome.tabs.onRemoved.addListener(tabId=>{
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
