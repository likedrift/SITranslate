import {type Settings,type PageStatus,type VideoStatus} from '../core/types';
import {rpc,el,value,languageOptions,sitePattern} from './client';
import type {SpeechStatus} from '../core/speech';
import type {CaptionLayout} from '../core/caption-layout';
import {PAUSE_SCROLL_POPUP_NOTE,STREAM_OFF_WARNING} from '../core/live-hints';
el('caption-pause-note').textContent=PAUSE_SCROLL_POPUP_NOTE;
let settings:Settings;let busy=false;let currentTab:chrome.tabs.Tab|undefined;
const IDLE_VIDEO_COPY='有字幕的视频可开启翻译。';
async function refreshSelection(){
  const button=el<HTMLButtonElement>('grant-site');
  try{
    const state=await rpc<{enabled:boolean;supported:boolean}>('selection:state',{url:currentTab?.url??''});
    button.dataset.enabled=String(state.enabled);
    button.dataset.supported=String(state.supported);
    if(!state.supported){button.disabled=true;button.textContent='当前页面不支持划词';return;}
    button.disabled=false;
    button.textContent=state.enabled?'划词已开启 · 管理网站':'开启所有网站划词';
  }catch(err){
    button.disabled=true;button.dataset.enabled='false';button.textContent='无法读取划词状态';
    error(err instanceof Error?err.message:'无法读取划词状态。');
  }
}
function error(text:string){el('error').textContent=text;el('error').hidden=!text;}
function openFold(id:string){const node=el(id) as HTMLDetailsElement;if(!node.open)node.open=true;}
function paintStreamWarning(){
  const profile=settings?.profiles.find(p=>p.id===value('profile'));
  const node=el('speech-stream-warning');
  const off=!!profile&&profile.stream===false;
  node.hidden=!off;node.textContent=off?STREAM_OFF_WARNING:'';
  if(off)openFold('speech-fold');
}
function selectedDisplay(){return (document.querySelector('input[name="display"]:checked') as HTMLInputElement).value;}
async function preferences(){await rpc('preferences:save',{target:value('target'),display:selectedDisplay(),profileId:value('profile')});}
function paint(s:PageStatus){
  const labels:Record<PageStatus['state'],string>={idle:'准备翻译',scanning:'正在整理页面',translating:'正在翻译',watching:'已完成 · 等待新增内容',done:'翻译完成',stopped:'已停止'};
  el('state').textContent=labels[s.state];el('count').textContent=s.total?`${s.completed} / ${s.total}`:'';
  el<HTMLProgressElement>('progress').max=Math.max(1,s.total);el<HTMLProgressElement>('progress').value=s.completed;
  const detail=s.message||(s.limited?'已达到单页文字上限。':s.failed?`${s.failed} 个段落未完成。`:'');
  el('detail').textContent=detail;el('detail').hidden=!detail;
  el('progress-card').hidden=s.state==='idle'&&!detail&&!s.failed&&!s.total;
  el<HTMLButtonElement>('stop').disabled=!['scanning','translating','watching'].includes(s.state);
  el('retry').hidden=!s.failed;el<HTMLButtonElement>('translate').disabled=busy||['scanning','translating'].includes(s.state);
}
async function refresh(){try{paint(await rpc<PageStatus>('tab:status'));}catch(err){error(err instanceof Error?err.message:'无法访问当前页面。');}}
function paintVideo(s:VideoStatus){
  const message=s.message===IDLE_VIDEO_COPY?'':s.message;
  const idle=s.state==='idle';
  el('video-state').textContent=[s.source,message,s.completed?`已翻译 ${s.completed} 条字幕`:''].filter(Boolean).join(' · ')||(idle?'未开始':'');
  el('video-state').hidden=idle;
  if(!idle&&s.state!=='loading')openFold('video-fold');
  el<HTMLButtonElement>('video-stop').disabled=!['loading','active'].includes(s.state);
  el('video-retry').hidden=s.state!=='active'||s.source==='标签页音频';
  el<HTMLButtonElement>('video-start').disabled=s.state==='loading';
  el('video-start').textContent=s.state==='active'?'重新开始':s.state==='loading'?'正在读取字幕状态…':'翻译视频字幕';
}
function paintVideoUnavailable(message:string){
  el('video-state').textContent=message;el('video-state').hidden=false;
  el<HTMLButtonElement>('video-stop').disabled=true;
  el('video-retry').hidden=true;
  el<HTMLButtonElement>('video-start').disabled=true;
  el('video-start').textContent='当前页面不可用';
}
async function refreshVideo(){try{paintVideo(await rpc<VideoStatus>('video:status'));}catch(err){paintVideoUnavailable(err instanceof Error?err.message:'无法读取字幕状态。');}}
async function videoAction(action:string){try{error('');await preferences();paintVideo(await rpc<VideoStatus>('video:action',{action,bilingual:el<HTMLInputElement>('video-bilingual').checked}));}catch(err){error(err instanceof Error?err.message:'无法操作视频字幕。');}}
for(const [id,action] of [['video-start','start'],['video-stop','stop'],['video-retry','retry']])el(id).addEventListener('click',()=>void videoAction(action));
el('video-bilingual').addEventListener('change',()=>void videoAction('display'));
async function action(action:string){busy=true;error('');el<HTMLButtonElement>('translate').disabled=true;try{await preferences();await rpc('tab:action',{action});await refresh();}catch(err){error(err instanceof Error?err.message:'操作失败。');}finally{busy=false;el<HTMLButtonElement>('translate').disabled=false;}}
el('settings').addEventListener('click',()=>chrome.runtime.openOptionsPage());
for(const [id,act]of [['translate','start'],['stop','stop'],['restore','restore'],['retry','retry']])el(id).addEventListener('click',()=>void action(act));
document.querySelectorAll('input[name="display"]').forEach(input=>input.addEventListener('change',async()=>{try{await preferences();await rpc('tab:action',{action:'display'});}catch(err){error(err instanceof Error?err.message:'无法切换显示。');}}));
for(const id of ['target','profile'])el(id).addEventListener('change',()=>{if(id==='profile')paintStreamWarning();preferences().catch(err=>error(err.message));});
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
  const active=settings.profiles.find(p=>p.id===settings.activeProfileId);if(!active?.apiKey)error('请先在设置中填写 API Key 和模型。');
  paintStreamWarning();
  await refresh();
  await refreshSelection();
  await refreshVideo();
  paintCaption(await rpc<CaptionLayout>('caption:get'));
}
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='session'&&Object.keys(changes).some(key=>key.startsWith('page:')))void refresh();if(area==='local'&&changes.selectionOrigins)void refreshSelection();if(area==='local'&&changes.captionLayout)paintCaption(changes.captionLayout.newValue);if(area==='local'&&changes.settings?.newValue){settings=changes.settings.newValue;paintStreamWarning();}});
chrome.permissions.onAdded.addListener(()=>void refreshSelection());
chrome.permissions.onRemoved.addListener(()=>void refreshSelection());
void init().catch(err=>error(err.message));
setInterval(()=>void refreshVideo(),1000);
async function refreshSpeech(){try{const s=await rpc<SpeechStatus>('speech:status');const base=s.state==='idle'?'未开始':s.message;const restart=/开始实时翻译/.test(s.message)&&['stopped','error'].includes(s.state);el('speech-state').hidden=s.state==='idle';el('speech-state').textContent=restart?s.message:base+(s.seconds?` · ${Math.floor(s.seconds/60)}分${s.seconds%60}秒 · 已译 ${s.completed} 段`:'');el('speech-state').className=restart?'status attention':'status';if(s.state!=='idle')openFold('speech-fold');el<HTMLButtonElement>('speech-stop').disabled=!['active','connecting'].includes(s.state);el<HTMLButtonElement>('speech-start').disabled=s.state==='connecting';el('speech-start').textContent=s.state==='active'?'重新开始':'开始实时翻译';el('speech-usage').hidden=!s.asrUsage;if(s.asrUsage)el('speech-usage').textContent=`已收到语音用量：输入 ${s.asrUsage.inputTokens.toLocaleString()} / 输出 ${s.asrUsage.outputTokens.toLocaleString()} Token（非最终账单）`;el('speech-timing').hidden=!s.timing;if(s.timing)el('speech-timing').textContent=`最近一段：排队 ${s.timing.queueMs}ms · 翻译 ${s.timing.translationMs}ms（从识别文本确认后计时）`;}catch{}}
el('speech-start').addEventListener('click',async()=>{el<HTMLButtonElement>('speech-start').disabled=true;try{await preferences();settings=await rpc<Settings>('settings:get');paintStreamWarning();await rpc('speech:start');await refreshSpeech();}catch(e){error(e instanceof Error?e.message:'无法开启实时翻译。');}finally{el<HTMLButtonElement>('speech-start').disabled=false;}});
el('speech-stop').addEventListener('click',()=>void rpc('speech:stop').then(refreshSpeech).catch(e=>error(e.message)));
el('speech-settings').addEventListener('click',event=>{event.preventDefault();event.stopPropagation();void chrome.tabs.create({url:chrome.runtime.getURL('options.html#speech')});});
void refreshSpeech();setInterval(()=>void refreshSpeech(),1000);
function paintCaption(s:CaptionLayout){if(!s)return;for(const [id,n,unit] of [['font',s.fontSize,'px'],['width',s.width,'%'],['opacity',Math.round(s.opacity*100),'%']] as const){if(document.activeElement!==el(`caption-${id}`))el<HTMLInputElement>(`caption-${id}`).value=String(n);el(`caption-${id}-label`).textContent=n+unit;}el<HTMLSelectElement>('caption-mode').value=s.mode;el<HTMLSelectElement>('caption-reading').value=s.readingMode??'balanced';el<HTMLInputElement>('caption-lock').checked=s.locked;el<HTMLInputElement>('video-bilingual').checked=s.showOriginal;}
for(const [id,key] of [['font','fontSize'],['width','width'],['opacity','opacity']] as const){const input=el<HTMLInputElement>(`caption-${id}`);input.addEventListener('input',()=>{el(`caption-${id}-label`).textContent=input.value+(id==='font'?'px':'%');});input.addEventListener('change',()=>void rpc('caption:save',{patch:{[key]:Number(input.value)/(id==='opacity'?100:1)}}).catch(e=>error(e.message)));}
el('caption-mode').addEventListener('change',()=>void rpc('caption:save',{patch:{mode:value('caption-mode')}}).catch(e=>error(e.message)));
el('caption-reading').addEventListener('change',()=>void rpc('caption:save',{patch:{readingMode:value('caption-reading')}}).catch(e=>error(e.message)));
el('caption-lock').addEventListener('change',()=>void rpc('caption:save',{patch:{locked:el<HTMLInputElement>('caption-lock').checked}}).catch(e=>error(e.message)));
el('caption-reset').addEventListener('click',()=>void rpc<CaptionLayout>('caption:reset').then(paintCaption).catch(e=>error(e.message)));
async function refreshDiagnostics(){try{const d=await rpc<any>('speech:diagnostics');const labels:Record<string,string>={asrMs:'识别返回（估算）',commitMs:'本地组句',queueMs:'待译排队',schedulerMs:'模型调度',firstTokenMs:'模型首 Token',firstTextMs:'模型首段译文',translationMs:'译文完成',displayWaitMs:'显示缓冲',firstPaintMs:'提交到上屏',audioToPaintMs:'句末到上屏（估算）'};const summary=`最近 ${d.samples} 个片段 · 浏览会话累计中间识别 ${d.counters.asrIntermediate} 次，其中含稳定文字 ${d.counters.asrStableIntermediate} 次`;const warning=d.rows.some((r:any)=>r.streaming===false)?'部分文字请求未开启流式响应，需在模型设置开启才能渐进显示。':'';el('speech-diagnostics-summary').textContent=warning?`${summary}\n${warning}`:summary;const dump=Object.entries(d.metrics).map(([key,v]:[string,any])=>`${labels[key]??key}：P50 ${v.p50}ms / P95 ${v.p95}ms（${v.samples} 段）`).join('\n');const node=el('speech-diagnostics-dump');node.textContent=dump;node.hidden=dump.length===0;}catch{}}
el('speech-diagnostics').addEventListener('toggle',()=>{if((el('speech-diagnostics') as HTMLDetailsElement).open)void refreshDiagnostics();});
el('speech-diagnostics-clear').addEventListener('click',()=>void rpc('speech:diagnostics-clear').then(refreshDiagnostics).catch(e=>error(e.message)));
el('speech-diagnostics-export').addEventListener('click',async()=>{try{const d=await rpc<any>('speech:diagnostics');const url=URL.createObjectURL(new Blob([JSON.stringify({...d,exportedAt:new Date().toISOString(),notes:['仅本地最近100段数字计时，无原文/译文/音频/Key/网址。','首Token不等于首段可显示译文。','ASR及句末到上屏由上传音频帧与ASR时间戳估算，缺失时不计，排除YouTube/CDN延迟。','上屏使用可见页连续两次requestAnimationFrame估算，非硬件呈现时间。']},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='si-translate-latency.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){error(e instanceof Error?e.message:'导出失败。');}});
setInterval(()=>{if((el('speech-diagnostics') as HTMLDetailsElement).open)void refreshDiagnostics();},1000);
