import type {PlayerState} from './core/player';

// Only the top YouTube document loads this small entry point. Mounting never starts a task.
const scope=globalThis as typeof globalThis&{__siPlayerControls?:boolean};
if(!scope.__siPlayerControls){scope.__siPlayerControls=true;boot();}
function boot(){
  const host=document.createElement('div');host.id='si-player-controls';host.dataset.siOwned='player';host.className='ytp-button';
  host.style.cssText='position:relative;display:inline-block;width:52px;height:100%;vertical-align:top;overflow:visible;';
  const root=host.attachShadow({mode:'open'});
  root.innerHTML=`<style>
    :host{font-family:Arial,"Microsoft YaHei",sans-serif;color:#fff;text-align:left;line-height:1.5;font-size:14px}
    *{box-sizing:border-box}button{font:inherit;color:inherit;border:0;cursor:pointer}button:focus-visible{outline:2px solid #9ec5ff;outline-offset:-3px}
    #toggle{width:100%;height:100%;padding:0;background:transparent;font-size:15px;font-weight:600;text-shadow:0 1px 2px #000}
    #toggle[data-active=true]{color:#9ec5ff}#toggle[data-active=true]::after{content:"";display:block;position:absolute;bottom:5px;left:18px;width:16px;height:3px;background:#9ec5ff;border-radius:2px}
    #panel{position:fixed;inset:auto;margin:0;width:280px;max-width:calc(100vw - 32px);overflow:auto;padding:14px;background:rgba(25,25,28,.97);color:#fff;box-shadow:0 5px 22px #0006;border:1px solid #ffffff25;border-radius:10px;white-space:normal;text-shadow:none}
    [hidden]{display:none!important}h2{font-size:15px;margin:0 0 10px}p{margin:6px 0 12px;color:#ccc;font-size:12px;line-height:1.6}
    .action{display:block;width:100%;text-align:left;background:#ffffff12;border-radius:5px;padding:9px 10px}.action:hover{background:#ffffff25}button:disabled{opacity:.6;cursor:wait}
    #feedback{margin:10px 0 0;color:#d9e7ff;overflow-wrap:anywhere}.links{display:flex;gap:16px;margin-top:10px}.links button{font-size:12px;padding:3px 0;background:transparent;color:#b9d5ff}
  </style>
  <button id="toggle" type="button" aria-label="思译翻译" title="思译翻译" aria-haspopup="dialog" aria-expanded="false" aria-controls="panel">翻译</button>
  <section id="panel" role="dialog" aria-label="思译翻译" popover="manual" hidden>
    <h2>思译翻译</h2>
    <button id="speech" class="action" type="button">开始实时语音翻译</button><p>识别视频声音，无需网站字幕。</p>
    <button id="captions" class="action" type="button">开始网站字幕翻译</button><p>请先打开播放器自带字幕。</p>
    <p id="feedback" role="status" aria-live="polite"></p>
    <div class="links"><button id="settings" type="button">翻译设置</button><button id="shortcuts" type="button" hidden>设置快捷键</button></div>
  </section>`;
  const get=<T extends HTMLElement>(id:string)=>root.getElementById(id) as T;
  const toggle=get<HTMLButtonElement>('toggle'),panel=get<HTMLElement>('panel'),speech=get<HTMLButtonElement>('speech'),captions=get<HTMLButtonElement>('captions'),feedback=get<HTMLElement>('feedback');
  let state:PlayerState|undefined,busy=false,opened=false,refreshing=false,again=false,frame=0,notice='',poll:ReturnType<typeof setInterval>|undefined;
  const active=(value:string|undefined)=>value==='active'||value==='connecting'||value==='loading';
  async function rpc<T=unknown>(message:unknown):Promise<T>{const r=await chrome.runtime.sendMessage(message);if(!r?.ok)throw new Error(r?.error??'扩展已更新，请刷新网页。');return r.data;}
  function positionPanel(){
    if(!opened)return;const anchor=toggle.getBoundingClientRect();
    panel.style.maxHeight=`${Math.max(120,anchor.top-20)}px`;
    panel.style.left=`${Math.max(8,Math.min(anchor.right-panel.offsetWidth,innerWidth-panel.offsetWidth-8))}px`;
    panel.style.top=`${Math.max(8,anchor.top-panel.offsetHeight-12)}px`;
  }
  function render(){
    const voiceOn=active(state?.speech.state),captionsOn=active(state?.captions.state);
    toggle.dataset.active=String(voiceOn||captionsOn);toggle.title=voiceOn?'思译：实时语音翻译中':captionsOn?'思译：网站字幕翻译中':'思译翻译';
    speech.textContent=voiceOn?'停止实时语音翻译':'开始实时语音翻译';captions.textContent=captionsOn?'停止网站字幕翻译':'开始网站字幕翻译';
    speech.disabled=captions.disabled=busy||!state;
    const activation=state?.speech.needsActivation?(state.shortcut?`当前标签页需要音频授权，请按 ${state.shortcut} 开始实时翻译；之后可在此开关。`:'当前标签页需要音频授权，请先设置“开始 / 停止实时语音翻译”快捷键，再按快捷键启动。'):'';
    feedback.textContent=notice||(voiceOn?state?.speech.message:captionsOn?state?.captions.message:activation||[state?.speech,state?.captions].find(s=>s?.state==='error')?.message||'点击开始后才会发送内容进行翻译。')||'';
    get('shortcuts').hidden=!state?.speech.needsActivation;
    positionPanel();
  }
  async function refresh(){
    if(refreshing){again=true;return;}refreshing=true;
    try{do{again=false;const next=await rpc<PlayerState>({type:'player:status'});if((!active(state?.speech.state)&&active(next.speech.state))||(!active(state?.captions.state)&&active(next.captions.state)))notice='';state=next;render();}while(again);}catch(error){notice=error instanceof Error?error.message:'无法读取翻译状态。';render();}finally{refreshing=false;}
  }
  function open(value:boolean){
    opened=value;panel.hidden=!value;toggle.setAttribute('aria-expanded',String(value));
    // The browser top layer keeps this menu above draggable captions and outside player clipping.
    if(value){panel.showPopover();positionPanel();}else panel.hidePopover();
    if(poll)clearInterval(poll);poll=undefined;
    if(value){void refresh();poll=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},1000);}
  }
  toggle.addEventListener('click',event=>{if(event.isTrusted)open(!opened);});
  async function action(mode:'speech'|'captions'){
    if(busy||!state)return;busy=true;notice='';render();
    try{state=await rpc<PlayerState>({type:'player:action',mode,action:active(state[mode].state)?'stop':'start'});if(state[mode].state==='error'&&!state.speech.needsActivation)notice=state[mode].message;}
    catch(error){notice=error instanceof Error?error.message:'无法切换翻译。';}
    finally{busy=false;render();void refresh();}
  }
  speech.addEventListener('click',event=>{if(event.isTrusted)void action('speech');});
  captions.addEventListener('click',event=>{if(event.isTrusted)void action('captions');});
  for(const id of ['settings','shortcuts'])get(id).addEventListener('click',event=>{if(event.isTrusted)void rpc({type:`player:${id}`}).catch(error=>{notice=String(error.message);render();});});
  for(const name of ['click','pointerdown','keyup'])root.addEventListener(name,event=>event.stopPropagation());
  root.addEventListener('keydown',event=>{event.stopPropagation();if((event as KeyboardEvent).key==='Escape'){event.preventDefault();open(false);toggle.focus();}});
  document.addEventListener('pointerdown',event=>{if(opened&&!event.composedPath().includes(host))open(false);},{capture:true});
  document.addEventListener('keydown',event=>{if(opened&&event.key==='Escape'){event.preventDefault();event.stopPropagation();open(false);toggle.focus();}},{capture:true});
  panel.addEventListener('toggle',()=>{if(opened&&!panel.matches(':popover-open'))open(false);});
  window.addEventListener('resize',positionPanel);document.addEventListener('scroll',positionPanel,{capture:true,passive:true});
  function mount(){
    frame=0;const bar=document.querySelector('#movie_player .ytp-right-controls, .html5-video-player .ytp-right-controls');
    if(bar&&host.parentElement!==bar){bar.prepend(host);void refresh();}
    else if(!bar&&host.isConnected){host.remove();open(false);}
  }
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(mount);};
  new MutationObserver(()=>{if(!host.isConnected||!host.parentElement?.matches('.ytp-right-controls'))schedule();}).observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener('yt-navigate-finish',()=>{open(false);notice='';schedule();void refresh();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){schedule();void refresh();}});
  chrome.runtime.onMessage.addListener((message,sender)=>{if(sender.id===chrome.runtime.id&&message?.type==='player:refresh')void refresh();});
  render();mount();
}
