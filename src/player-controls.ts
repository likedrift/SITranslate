import type {PlayerState} from './core/player';

// Only the top YouTube document loads this small entry point. Mounting never starts a task.
const scope=globalThis as typeof globalThis&{__siPlayerControls?:boolean};
if(!scope.__siPlayerControls){scope.__siPlayerControls=true;boot();}
function boot(){
  const host=document.createElement('div');host.id='si-player-controls';host.dataset.siOwned='player';host.className='ytp-button';
  host.style.cssText='position:relative;display:inline-block;width:48px;height:100%;vertical-align:top;overflow:visible;';
  const root=host.attachShadow({mode:'open'});
  root.innerHTML=`<style>
    :host{font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;color:#f1f5f9;text-align:left;line-height:1.5;font-size:13.5px}
    *{box-sizing:border-box}
    button{font:inherit;color:inherit;border:0;cursor:pointer;transition:background-color .15s ease,border-color .15s ease,color .15s ease,opacity .15s ease}
    button:focus-visible{outline:2px solid #60a5fa;outline-offset:-3px}
    #toggle{position:relative;display:grid;place-items:center;width:100%;height:100%;padding:0;background:transparent;color:rgba(255,255,255,.92)}
    #toggle:hover{color:#fff}
    #toggle svg{display:block;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
    #toggle[data-active=true]{color:#60a5fa}
    #toggle[data-active=true]::after{content:"";display:block;position:absolute;bottom:6px;left:50%;transform:translateX(-50%);width:18px;height:2.5px;background:#60a5fa;border-radius:999px}
    #panel{position:fixed;inset:auto;margin:0;width:296px;max-width:calc(100vw - 24px);overflow:auto;padding:14px;background:rgba(18,22,30,.95);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);color:#f1f5f9;box-shadow:0 14px 38px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.12);border-radius:14px;white-space:normal;text-shadow:none}
    [hidden]{display:none!important}
    .panel-head{display:flex;align-items:center;gap:8px;margin:0 0 12px}
    .mini-mark{display:grid;place-items:center;width:22px;height:22px;border-radius:6px;background:#2563eb;color:#fff;flex-shrink:0}
    .mini-mark svg{display:block}
    h2{font-size:14.5px;font-weight:600;margin:0;letter-spacing:-0.005em}
    .group{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
    .desc{margin:0 2px;color:#94a3b8;font-size:11.5px;line-height:1.5}
    .action{position:relative;display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:9px 11px;font-size:13px;font-weight:500;color:#f1f5f9}
    .action::before{content:"";width:7px;height:7px;border-radius:50%;background:rgba(148,163,184,.55);flex-shrink:0;transition:background-color .15s ease,box-shadow .15s ease}
    .action:hover:not(:disabled){background:rgba(255,255,255,.13);border-color:rgba(255,255,255,.2)}
    .action[data-on=true]{background:rgba(37,99,235,.22);border-color:rgba(96,165,250,.45);color:#fff}
    .action[data-on=true]::before{background:#60a5fa;box-shadow:0 0 0 3px rgba(96,165,250,.22)}
    button:disabled{opacity:.55;cursor:wait}
    .toggle-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 2px;margin-top:2px;border-top:1px solid rgba(255,255,255,.09);font-size:12.5px;color:#cbd5e1}
    .switch-btn{position:relative;width:36px;height:20px;border-radius:10px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.18);padding:0;flex-shrink:0}
    .switch-btn::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#cbd5e1;transition:transform .15s ease,background-color .15s ease}
    .switch-btn[aria-checked=true]{background:#2563eb;border-color:#2563eb}
    .switch-btn[aria-checked=true]::after{transform:translateX(16px);background:#fff}
    #feedback{margin:8px 0 0;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.05);color:#cbd5e1;font-size:11.5px;line-height:1.55;overflow-wrap:anywhere}
    #feedback:empty{display:none}
    .links{display:flex;align-items:center;gap:14px;margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.09)}
    .links button{font-size:12px;padding:3px 0;background:transparent;color:#93c5fd}
    .links button:hover{color:#bfdbfe}
    @media(prefers-reduced-motion:reduce){*{transition:none!important}}
  </style>
  <button id="toggle" type="button" aria-label="思译翻译" title="思译翻译" aria-haspopup="dialog" aria-expanded="false" aria-controls="panel">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/>
      <path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>
    </svg>
  </button>
  <section id="panel" role="dialog" aria-label="思译翻译" popover="manual" hidden>
    <div class="panel-head">
      <span class="mini-mark" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 32 32" fill="none"><rect x="4" y="4" width="16" height="16" rx="4" fill="white" fill-opacity="0.34"/><rect x="12" y="12" width="16" height="16" rx="4" fill="white"/><path d="M20 14.5V17M16 17H24M22 17.8L16.5 24M19 19L23.5 24" stroke="#1d4ed8" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <h2>思译翻译</h2>
    </div>
    <div class="group">
      <button id="speech" class="action" type="button">开始实时语音翻译</button>
      <p class="desc">识别视频声音，无需网站字幕。</p>
    </div>
    <div class="group">
      <button id="captions" class="action" type="button">开始网站字幕翻译</button>
      <p class="desc">请先打开播放器自带字幕。</p>
    </div>
    <div class="toggle-row">
      <span>同时显示原文</span>
      <button id="bilingual" class="switch-btn" type="button" role="switch" aria-checked="true" aria-label="同时显示原文"></button>
    </div>
    <p id="feedback" role="status" aria-live="polite"></p>
    <div class="links"><button id="settings" type="button">翻译设置</button><button id="shortcuts" type="button" hidden>设置快捷键</button></div>
  </section>`;
  const get=<T extends HTMLElement>(id:string)=>root.getElementById(id) as T;
  const toggle=get<HTMLButtonElement>('toggle'),panel=get<HTMLElement>('panel'),speech=get<HTMLButtonElement>('speech'),captions=get<HTMLButtonElement>('captions'),bilingual=get<HTMLButtonElement>('bilingual'),feedback=get<HTMLElement>('feedback');
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
    speech.textContent=voiceOn?'停止实时语音翻译':'开始实时语音翻译';speech.dataset.on=String(voiceOn);
    captions.textContent=captionsOn?'停止网站字幕翻译':'开始网站字幕翻译';captions.dataset.on=String(captionsOn);
    bilingual.setAttribute('aria-checked',String(state?.showOriginal!==false));
    speech.disabled=captions.disabled=bilingual.disabled=busy||!state;
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
  bilingual.addEventListener('click',event=>{
    if(!event.isTrusted||busy||!state)return;
    busy=true;notice='';render();
    const next=state.showOriginal===false;
    void rpc<PlayerState>({type:'player:bilingual',showOriginal:next})
      .then(updated=>{state=updated;})
      .catch(error=>{notice=error instanceof Error?error.message:'无法切换双语显示。';})
      .finally(()=>{busy=false;render();});
  });
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
