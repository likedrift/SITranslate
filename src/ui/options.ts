import {type Settings,type Profile,type TranslationResult} from '../core/types';
import type {CaptionLayout} from '../core/caption-layout';
import {endpointFor,validateSettings} from '../core/validation';
import {rpc,el,value,check,languageOptions,sitePattern} from './client';
import {normalizeSpeech,isStreaming,type SpeechSettings,type SpeechStatus} from '../core/speech';
let settings:Settings,editing='',origins:string[]=[],dirty=false,ready=false;
el('app-version').textContent=`VERSION ${chrome.runtime.getManifest().version}`;
function feedback(text:string,state=''){const node=el('feedback');node.textContent=text;node.className=state;}
function markDirty(text='有未保存的修改。'){dirty=true;feedback(text,'dirty');}
function localStatus(id:string,text:string,state=''){const node=el(id);node.textContent=text;node.className=state?`field-status ${state}`:'field-status';}
function speechStatus(text:string,state=''){localStatus('speech-feedback',text,state);}
function paintCaptionOriginal(showOriginal:boolean){el<HTMLInputElement>('caption-original').checked=showOriginal;}
el('caption-original').addEventListener('change',()=>{
  const showOriginal=el<HTMLInputElement>('caption-original').checked;
  void rpc('caption:save',{patch:{showOriginal}}).then(()=>localStatus('reading-feedback','')).catch(err=>localStatus('reading-feedback',err instanceof Error?err.message:'字幕设置保存失败。','error'));
});
function capture(){
  const profile=settings?.profiles.find(item=>item.id===editing);if(!profile)return;
  Object.assign(profile,{name:value('profile-name').trim(),type:value('profile-type'),baseUrl:value('base-url').trim(),apiKey:value('api-key').trim(),model:value('model').trim(),
    stream:check('stream'),jsonMode:check('json-mode'),disableThinking:check('disable-thinking'),inputPrice:Number(value('input-price'))||0,outputPrice:Number(value('output-price'))||0});
  if(check('is-active'))settings.activeProfileId=profile.id;
}
function profileList(){
  el('profile-list').replaceChildren();
  for(const profile of settings.profiles){const option=document.createElement('option');option.value=profile.id;option.textContent=`${profile.name||'未命名'}${profile.id===settings.activeProfileId?' · 默认':''}`;el('profile-list').append(option);}
  el<HTMLSelectElement>('profile-list').value=editing;
  el<HTMLButtonElement>('delete-profile').disabled=settings.profiles.length<=1;
}
function fillProfile(){
  const profile=settings.profiles.find(item=>item.id===editing);if(!profile)return;
  el<HTMLInputElement>('profile-name').value=profile.name;el<HTMLSelectElement>('profile-type').value=profile.type;el<HTMLInputElement>('base-url').value=profile.baseUrl;el<HTMLInputElement>('api-key').value=profile.apiKey;el<HTMLInputElement>('api-key').type='password';el('toggle-key').textContent='显示';el<HTMLInputElement>('model').value=profile.model;
  el<HTMLInputElement>('input-price').value=profile.inputPrice?String(profile.inputPrice):'';el<HTMLInputElement>('output-price').value=profile.outputPrice?String(profile.outputPrice):'';
  el<HTMLInputElement>('stream').checked=profile.stream;el<HTMLInputElement>('json-mode').checked=profile.jsonMode;el<HTMLInputElement>('disable-thinking').checked=profile.disableThinking;el<HTMLInputElement>('is-active').checked=profile.id===settings.activeProfileId;
  el('thinking-row').hidden=profile.type!=='deepseek';profileList();
}
function applyReading(){
  el<HTMLSelectElement>('target').value=settings.target;el<HTMLSelectElement>('display').value=settings.display;el<HTMLSelectElement>('max-chars').value=String(settings.maxPageChars);
  el<HTMLInputElement>('dynamic').checked=settings.dynamic;el<HTMLInputElement>('include-context').checked=settings.includeContext;el<HTMLInputElement>('cache-enabled').checked=settings.cacheEnabled;
}
function gather(){
  capture();
  settings.target=value('target');settings.display=value('display') as Settings['display'];settings.maxPageChars=Number(value('max-chars'));
  settings.dynamic=check('dynamic');settings.includeContext=check('include-context');settings.cacheEnabled=check('cache-enabled');
  for(const profile of settings.profiles){
    if(!profile.name.trim())throw new Error('请填写配置名称。');
    if(!profile.baseUrl.trim())throw new Error('请填写 API 服务地址。');
    if(!profile.model.trim())throw new Error('请填写模型名称。');
  }
  validateSettings(settings);return structuredClone(settings);
}
async function persist(candidate:Settings,grant:Promise<boolean>){
  if(!await grant)throw new Error('API 服务访问权限未授予，设置尚未保存。');
  await rpc('settings:save',{settings:candidate});
  settings=await rpc<Settings>('settings:get');
  if(!settings.profiles.some(profile=>profile.id===editing))editing=settings.activeProfileId;
  dirty=false;applyReading();fillProfile();feedback('设置已保存。','success');
}
// Permission requests are invoked synchronously from the submit/click handlers.
function save(){const candidate=gather();const required=[...new Set(candidate.profiles.map(profile=>endpointFor(profile.baseUrl).permission))];const grant=chrome.permissions.request({origins:required});return persist(candidate,grant);}
el('settings-form').addEventListener('submit',event=>{
  event.preventDefault();if(!settings){feedback('设置仍在加载。','error');return;}
  let saved:Promise<void>;try{saved=save();}catch(err){feedback((err as Error).message,'error');return;}
  el<HTMLButtonElement>('save').disabled=true;el<HTMLButtonElement>('test').disabled=true;
  saved.catch(err=>feedback(err.message,'error')).finally(()=>{el<HTMLButtonElement>('save').disabled=false;el<HTMLButtonElement>('test').disabled=false;});
});
el('settings-form').addEventListener('input',event=>{
  if(!ready)return;
  const id=(event.target as HTMLElement).id;
  if(id==='caption-original'||id==='is-active')return;
  markDirty();
});
el('settings-form').addEventListener('change',event=>{
  if(!ready)return;
  const id=(event.target as HTMLElement).id;
  if(id==='caption-original'||id==='profile-list'||id==='is-active')return;
  markDirty();
});
el('profile-list').addEventListener('change',()=>{if(!settings)return;capture();editing=value('profile-list');fillProfile();});
el('profile-type').addEventListener('change',()=>{el('thinking-row').hidden=value('profile-type')!=='deepseek';});
el('is-active').addEventListener('change',()=>{
  if(!settings)return;
  if(!check('is-active')){
    const keep=editing===settings.activeProfileId;
    el<HTMLInputElement>('is-active').checked=keep;
    if(keep)feedback(dirty?'有未保存的修改。请保留一个默认服务。':'请保留一个默认服务。',dirty?'dirty':'');
    return;
  }
  capture();profileList();if(ready)markDirty();
});
el('add-profile').addEventListener('click',()=>{
  if(!settings)return;capture();
  if(settings.profiles.length>=12){feedback('最多保存 12 个服务配置。','error');return;}
  const profile:Profile={id:crypto.randomUUID(),name:'新服务',type:'compatible',baseUrl:'',apiKey:'',model:'',stream:true,jsonMode:false,disableThinking:false,inputPrice:0,outputPrice:0};
  settings.profiles.push(profile);editing=profile.id;fillProfile();markDirty('填写服务地址和模型后保存。');
});
el('delete-profile').addEventListener('click',()=>{
  if(!settings||settings.profiles.length<=1)return;
  settings.profiles=settings.profiles.filter(profile=>profile.id!==editing);
  if(!settings.profiles.some(profile=>profile.id===settings.activeProfileId))settings.activeProfileId=settings.profiles[0].id;
  editing=settings.activeProfileId;fillProfile();markDirty('配置已移除，保存后生效。');
});
el('toggle-key').addEventListener('click',()=>{const key=el<HTMLInputElement>('api-key');key.type=key.type==='password'?'text':'password';el('toggle-key').textContent=key.type==='password'?'显示':'隐藏';el('toggle-key').setAttribute('aria-label',key.type==='password'?'显示 API Key':'隐藏 API Key');});
el('test').addEventListener('click',()=>{
  if(!settings){feedback('设置仍在加载。','error');return;}
  let saved:Promise<void>;try{saved=save();}catch(err){feedback((err as Error).message,'error');el('test-result').textContent='';return;}
  const testProfile=editing;let savedOk=false;
  el<HTMLButtonElement>('test').disabled=true;el<HTMLButtonElement>('save').disabled=true;el('test-result').textContent='正在连接…';
  const heartbeat=setInterval(()=>rpc('task:heartbeat').catch(()=>{}),15000);
  saved.then(()=>{savedOk=true;return rpc<TranslationResult>('translate',{input:{kind:'test',taskId:crypto.randomUUID(),requestId:crypto.randomUUID(),profileId:testProfile,target:settings.target,blocks:[{id:'test',context:'',segments:[{id:'test',text:'Hello, world! こんにちは。'}]}]}});})
    .then(result=>{el('test-result').textContent=`连接成功：${result.segments[0].text}`;void refreshUsage();})
    .catch(err=>{const message=err instanceof Error?err.message:String(err);if(savedOk)el('test-result').textContent=message;else{feedback(message,'error');el('test-result').textContent='';}})
    .finally(()=>{clearInterval(heartbeat);el<HTMLButtonElement>('test').disabled=false;el<HTMLButtonElement>('save').disabled=false;});
});
const ALL_SITES=['https://*/*','http://*/*'];
function originLabel(origin:string){return origin==='https://*/*'?'所有 HTTPS 网站':origin==='http://*/*'?'所有 HTTP 网站':origin;}
let originPaint=0;
async function renderOrigins(){
  const token=++originPaint;
  const rows=await Promise.all(origins.map(async origin=>({origin,granted:await chrome.permissions.contains({origins:[origin]})})));
  if(token!==originPaint)return;
  el('site-list').replaceChildren();
  if(!rows.length){const empty=document.createElement('li');empty.className='site-empty';empty.textContent='尚未指定网站';el('site-list').append(empty);}
  for(const row of rows){
    const li=document.createElement('li'),label=document.createElement('span'),remove=document.createElement('button');
    label.textContent=row.granted?originLabel(row.origin):`${originLabel(row.origin)} · 未授权`;
    if(!row.granted)label.className='ungranted';
    remove.type='button';remove.className='text-button danger';remove.textContent='移除';
    remove.addEventListener('click',()=>saveOrigins(origins.filter(origin=>origin!==row.origin)).catch(err=>localStatus('selection-feedback',err.message,'error')));
    li.append(label,remove);el('site-list').append(li);
  }
  const grantedAll=ALL_SITES.every(pattern=>rows.some(row=>row.origin===pattern&&row.granted));
  const storedAll=ALL_SITES.every(pattern=>origins.includes(pattern));
  const button=el<HTMLButtonElement>('all-sites');
  button.textContent=grantedAll?'已在所有普通网站开启':storedAll?'重新授权所有普通网站':'在所有普通网站开启划词';
  button.setAttribute('aria-pressed',String(grantedAll));
}
async function saveOrigins(next:string[]){origins=await rpc<string[]>('selection:save',{origins:next});await renderOrigins();localStatus('selection-feedback','划词范围已更新。已打开的网页请刷新。','success');}
el('site-form').addEventListener('submit',event=>{
  event.preventDefault();
  let pattern:string;try{pattern=sitePattern(value('site-url'));}catch(err){localStatus('selection-feedback',(err as Error).message,'error');return;}
  const grant=chrome.permissions.request({origins:[pattern]});
  grant.then(ok=>{if(!ok)throw new Error('网站访问权限未授予。');return saveOrigins([...new Set([...origins,pattern])]);}).then(()=>{el<HTMLInputElement>('site-url').value='';}).catch(err=>localStatus('selection-feedback',err.message,'error'));
});
el('all-sites').addEventListener('click',()=>{
  if(el('all-sites').getAttribute('aria-pressed')==='true'){localStatus('selection-feedback','划词已覆盖所有普通网站。','success');return;}
  const grant=chrome.permissions.request({origins:ALL_SITES});
  grant.then(ok=>{if(!ok)throw new Error('网站访问权限未授予。');return saveOrigins(ALL_SITES);}).catch(err=>localStatus('selection-feedback',err.message,'error'));
});
async function refreshUsage(){
  const data=await rpc<{usage:{requests:number;input:number;output:number;estimatedCost:number};cache:{entries:number;bytes:number}}>('usage:get');
  el('usage-requests').textContent=data.usage.requests.toLocaleString();el('usage-tokens').textContent=(data.usage.input+data.usage.output).toLocaleString();el('usage-cost').textContent=data.usage.estimatedCost?data.usage.estimatedCost.toFixed(4):'—';
  el('cache-summary').textContent=`会话缓存 ${data.cache.entries} 条 · ${(data.cache.bytes/1024).toFixed(1)} KB / 4 MB`;
}
el('clear-cache').addEventListener('click',()=>rpc('cache:clear').then(refreshUsage).then(()=>localStatus('data-feedback','译文缓存已清除。','success')).catch(err=>localStatus('data-feedback',err.message,'error')));
el('clear-usage').addEventListener('click',()=>rpc('usage:clear').then(refreshUsage).then(()=>localStatus('data-feedback','用量统计已重置。','success')).catch(err=>localStatus('data-feedback',err.message,'error')));
function paintSpeech(speech:SpeechSettings){
  for(const [id,key] of [['speech-key','apiKey'],['speech-endpoint','endpoint'],['speech-model','model'],['speech-language','language'],['speech-context','context']] as const)el<HTMLInputElement>(id).value=speech[key];
  readSpeechAddress();speechModelHelp();
}
async function init(){
  settings=await rpc<Settings>('settings:get');editing=settings.activeProfileId;
  languageOptions(el<HTMLSelectElement>('target'));applyReading();fillProfile();ready=true;
  try{paintSpeech(await rpc<SpeechSettings>('speech:settings-get'));}catch(error){speechStatus(error instanceof Error?error.message:'无法读取语音配置。','error');}
  try{origins=await rpc<string[]>('selection:origins');await renderOrigins();}catch(error){localStatus('selection-feedback',error instanceof Error?error.message:'无法读取划词范围。','error');}
  try{await refreshUsage();}catch(error){localStatus('data-feedback',error instanceof Error?error.message:'无法读取用量。','error');}
  try{paintCaptionOriginal((await rpc<CaptionLayout>('caption:get')).showOriginal);}catch(error){localStatus('reading-feedback',error instanceof Error?error.message:'无法读取字幕设置。','error');}
}
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local'||!settings)return;
  if(changes.captionLayout?.newValue&&typeof changes.captionLayout.newValue.showOriginal==='boolean')paintCaptionOriginal(changes.captionLayout.newValue.showOriginal);
  if(changes.selectionOrigins){origins=changes.selectionOrigins.newValue??[];void renderOrigins();}
  if(changes.settings?.newValue&&!dirty){settings=changes.settings.newValue;if(!settings.profiles.some(profile=>profile.id===editing))editing=settings.activeProfileId;applyReading();fillProfile();}
});
chrome.permissions.onAdded.addListener(()=>void renderOrigins());
chrome.permissions.onRemoved.addListener(()=>void renderOrigins());
void init().catch(err=>feedback(err.message,'error'));
let speechBusy=false;
async function saveSpeech(test=false){
  if(speechBusy)return;speechBusy=true;
  el<HTMLButtonElement>('speech-save').disabled=true;el<HTMLButtonElement>('speech-test').disabled=true;
  const data:SpeechSettings={apiKey:value('speech-key').trim(),endpoint:value('speech-endpoint').trim(),model:value('speech-model').trim(),language:value('speech-language') as SpeechSettings['language'],context:value('speech-context').trim()};
  try{
    const next=normalizeSpeech(data);await rpc('speech:settings-save',{settings:next});el<HTMLInputElement>('speech-endpoint').value=next.endpoint;readSpeechAddress();speechStatus('语音配置已保存。','success');
    if(test){await rpc('speech:test');const deadline=Date.now()+18000;while(Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,400));const state=await rpc<SpeechStatus>('speech:status');speechStatus(state.message,state.state==='error'?'error':'');if(state.state!=='connecting')return;}speechStatus('连接测试超时，请检查网络与地域。','error');}
  }catch(error){speechStatus(error instanceof Error?error.message:'语音配置保存失败。','error');}
  finally{speechBusy=false;el<HTMLButtonElement>('speech-save').disabled=false;el<HTMLButtonElement>('speech-test').disabled=false;}
}
el('speech-form').addEventListener('submit',event=>{event.preventDefault();void saveSpeech();});
el('speech-test').addEventListener('click',()=>void saveSpeech(true));
function speechModelHelp(){const streaming=isStreaming(value('speech-model').trim());el<HTMLTextAreaElement>('speech-context').maxLength=streaming?400:2000;el('speech-context-help').textContent=streaming?'3.1 Streaming 最多 400 字。':'原版术语最多 2000 字。';el('speech-address-help').textContent=streaming?'3.1 需要业务空间地址。填写 Workspace ID 后自动生成，Key 须匹配地域和业务空间。':'可使用默认地址或业务空间地址，Key 须匹配地域。';}
function readSpeechAddress(){try{const url=new URL(value('speech-endpoint')),match=url.hostname.match(/^([a-zA-Z0-9-]+)\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/);el<HTMLInputElement>('speech-workspace').value=match?.[1]??'';el<HTMLSelectElement>('speech-region').value=match?.[2]??(url.hostname==='dashscope-intl.aliyuncs.com'?'ap-southeast-1':'cn-beijing');}catch{}}
function buildSpeechAddress(){
  const workspace=value('speech-workspace').trim(),region=value('speech-region'),streaming=isStreaming(value('speech-model').trim());speechModelHelp();
  if(workspace&&!/^[a-zA-Z0-9-]+$/.test(workspace)){speechStatus('Workspace ID 只填写业务空间 ID，不包含域名、网址或空格。','error');return;}
  let local:URL|undefined;try{const parsed=new URL(value('speech-endpoint'));if(parsed.protocol==='ws:'&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)&&!workspace)local=parsed;}catch{}
  const host=workspace?`${workspace}.${region}.maas.aliyuncs.com`:region==='ap-southeast-1'?'dashscope-intl.aliyuncs.com':'dashscope.aliyuncs.com';
  el<HTMLInputElement>('speech-endpoint').value=`${local?.origin??'wss://'+host}/api-ws/v1/${streaming?'inference':'realtime'}`;
  speechStatus(streaming&&!workspace&&!local?'请填写对应地域的 Workspace ID，或粘贴完整业务空间地址。':'有未保存的语音配置。',streaming&&!workspace&&!local?'error':'');
}
for(const id of ['speech-model','speech-region','speech-workspace'])el(id).addEventListener('change',buildSpeechAddress);
el('speech-endpoint').addEventListener('change',readSpeechAddress);
const navLinks=[...document.querySelectorAll<HTMLAnchorElement>('.nav-link')];
function setActiveNav(id:string){
  for(const link of navLinks){
    const on=link.getAttribute('href')===`#${id}`;
    link.classList.toggle('active',on);
    if(on)link.setAttribute('aria-current','true');else link.removeAttribute('aria-current');
  }
}
function sectionFromScroll(){
  const items=navLinks.map(link=>({id:link.getAttribute('href')?.slice(1)||'',section:document.getElementById(link.getAttribute('href')?.slice(1)||'')})).filter(item=>item.section);
  if(!items.length)return 'providers';
  if(window.scrollY+window.innerHeight>=document.documentElement.scrollHeight-4)return items[items.length-1].id;
  const marker=Math.min(160,window.innerHeight*0.3);let current=items[0].id;
  for(const item of items)if(item.section!.getBoundingClientRect().top<=marker)current=item.id;
  return current;
}
function syncNav(){setActiveNav(sectionFromScroll());}
for(const link of navLinks)link.addEventListener('click',()=>{const id=link.getAttribute('href')?.slice(1);if(id)setActiveNav(id);});
document.addEventListener('scroll',syncNav,{passive:true});
window.addEventListener('hashchange',syncNav);
syncNav();
requestAnimationFrame(()=>requestAnimationFrame(syncNav));
