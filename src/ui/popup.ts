import {type Settings,type PageStatus,type VideoStatus} from '../core/types';
import {rpc,el,value,languageOptions,sitePattern} from './client';
let settings:Settings;let busy=false;let currentTab:chrome.tabs.Tab|undefined;
async function refreshSelection(){
  const state=await rpc<{enabled:boolean;supported:boolean}>('selection:state',{url:currentTab?.url??''});
  el('grant-site').textContent=state.enabled?'划词已开启 · 管理网站':'开启所有网站划词';
  el<HTMLButtonElement>('grant-site').disabled=!state.supported;
  el('grant-site').dataset.enabled=String(state.enabled);
}
function error(text:string){el('error').textContent=text;el('error').hidden=!text;}
function selectedDisplay(){return (document.querySelector('input[name="display"]:checked') as HTMLInputElement).value;}
async function preferences(){await rpc('preferences:save',{target:value('target'),display:selectedDisplay(),profileId:value('profile')});}
function paint(s:PageStatus){
  const labels:Record<PageStatus['state'],string>={idle:'准备翻译',scanning:'正在整理页面',translating:'正在翻译',watching:'已完成 · 等待新增内容',done:'翻译完成',stopped:'已停止'};
  el('state').textContent=labels[s.state];el('count').textContent=s.total?`${s.completed} / ${s.total}`:'';
  el<HTMLProgressElement>('progress').max=Math.max(1,s.total);el<HTMLProgressElement>('progress').value=s.completed;
  el('detail').textContent=s.message||(s.limited?'已达到单页文字上限，可在设置中调整。':s.failed?`${s.failed} 个段落未完成，可重试失败部分。`:'翻译当前页面，保留链接与格式。');
  el<HTMLButtonElement>('stop').disabled=!['scanning','translating','watching'].includes(s.state);
  el('retry').hidden=!s.failed;el<HTMLButtonElement>('translate').disabled=busy||['scanning','translating'].includes(s.state);
}
async function refresh(){try{paint(await rpc<PageStatus>('tab:status'));}catch(err){error(err instanceof Error?err.message:'无法访问当前页面。');}}
function paintVideo(s:VideoStatus){
  el('video-state').textContent=[s.source,s.message,s.completed?`已翻译 ${s.completed} 条字幕`: ''].filter(Boolean).join(' · ');
  el<HTMLButtonElement>('video-stop').disabled=!['loading','active'].includes(s.state);
  el('video-retry').hidden=s.state!=='active';el<HTMLButtonElement>('video-start').disabled=s.state==='loading';
  el('video-start').textContent=s.state==='active'?'重新开始':'翻译视频字幕';
  el<HTMLInputElement>('video-bilingual').checked=s.bilingual;
}
async function refreshVideo(){try{paintVideo(await rpc<VideoStatus>('video:status'));}catch{ /* Restricted pages retain the start action's explicit error. */ }}
async function videoAction(action:string){try{error('');await preferences();paintVideo(await rpc<VideoStatus>('video:action',{action,bilingual:el<HTMLInputElement>('video-bilingual').checked}));}catch(err){error(err instanceof Error?err.message:'无法操作视频字幕。');}}
for(const [id,action] of [['video-start','start'],['video-stop','stop'],['video-retry','retry']])el(id).addEventListener('click',()=>void videoAction(action));
el('video-bilingual').addEventListener('change',()=>void videoAction('display'));
async function action(action:string){busy=true;error('');el<HTMLButtonElement>('translate').disabled=true;try{await preferences();await rpc('tab:action',{action});await refresh();}catch(err){error(err instanceof Error?err.message:'操作失败。');}finally{busy=false;el<HTMLButtonElement>('translate').disabled=false;}}
el('settings').addEventListener('click',()=>chrome.runtime.openOptionsPage());
for(const [id,act]of [['translate','start'],['stop','stop'],['restore','restore'],['retry','retry']])el(id).addEventListener('click',()=>void action(act));
document.querySelectorAll('input[name="display"]').forEach(input=>input.addEventListener('change',async()=>{try{await preferences();await rpc('tab:action',{action:'display'});}catch(err){error(err instanceof Error?err.message:'无法切换显示。');}}));
for(const id of ['target','profile'])el(id).addEventListener('change',()=>preferences().catch(err=>error(err.message)));
el('grant-site').addEventListener('click',()=>{
  if(el('grant-site').dataset.enabled==='true'){void chrome.runtime.openOptionsPage();return;}
  // The origin is loaded on opening the popup, so request() is directly inside the user gesture.
  let pattern:string;try{pattern=sitePattern(currentTab?.url??'');}catch(err){error((err as Error).message);return;}
  const allSites=['https://*/*','http://*/*'];
  const grant=chrome.permissions.request({origins:allSites});
  void (async()=>{
    try{const granted=await grant;if(!granted){error('网站授权未开启。仍可使用右键翻译。');return;}
      await rpc('selection:save',{origins:allSites});
      await chrome.scripting.executeScript({target:{tabId:currentTab!.id!},files:['content.js']});await refreshSelection();
    }catch(err){error(err instanceof Error?err.message:'无法开启划词。');}
  })();
});
async function init(){
  [currentTab]=await chrome.tabs.query({active:true,currentWindow:true});
  languageOptions(el<HTMLSelectElement>('target'));settings=await rpc<Settings>('settings:get');el<HTMLSelectElement>('target').value=settings.target;
  for(const p of settings.profiles){const option=document.createElement('option');option.value=p.id;option.textContent=p.name;el('profile').append(option);}el<HTMLSelectElement>('profile').value=settings.activeProfileId;
  (document.querySelector(`input[name="display"][value="${settings.display}"]`)as HTMLInputElement).checked=true;
  const active=settings.profiles.find(p=>p.id===settings.activeProfileId);if(!active?.apiKey)error('首次使用：请在设置中填写 API Key 和模型。');
  await refresh();
  await refreshSelection();
  await refreshVideo();
}
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='session'&&Object.keys(changes).some(key=>key.startsWith('page:')))void refresh();if(area==='local'&&changes.selectionOrigins)void refreshSelection().catch(err=>error(err.message));});
chrome.permissions.onAdded.addListener(()=>void refreshSelection().catch(()=>{}));
chrome.permissions.onRemoved.addListener(()=>void refreshSelection().catch(()=>{}));
void init().catch(err=>error(err.message));
setInterval(()=>void refreshVideo(),1000);
