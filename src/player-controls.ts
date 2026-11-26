import type {PlayerState} from './core/player';

// Only the top YouTube document loads this small entry point. Mounting never starts a task.
const scope=globalThis as typeof globalThis&{__siPlayerControls?:boolean};
if(!scope.__siPlayerControls){scope.__siPlayerControls=true;boot();}
function boot(){
  const host=document.createElement('div');host.id='si-player-controls';host.dataset.siOwned='player';host.className='ytp-button';
  host.style.cssText='position:relative;display:inline-block;width:48px;height:100%;vertical-align:top;overflow:visible;';
  const root=host.attachShadow({mode:'open'});
  root.innerHTML=`<style>
    :host{all:initial;display:block;width:100%;height:100%;font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;color:#f1f5f9;text-align:left;line-height:1.4;font-size:13px;-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}
    button{all:unset;box-sizing:border-box;font:inherit;color:inherit;cursor:pointer;transition:background-color .15s ease,border-color .15s ease,color .15s ease,opacity .15s ease}
    button:focus-visible{outline:2px solid #60a5fa;outline-offset:-2px}
    [hidden]{display:none!important}
    #toggle{position:relative;display:grid;place-items:center;width:100%;height:100%;background:transparent;color:rgba(255,255,255,.92)}
    #toggle:hover{color:#fff}
    #toggle svg{display:block;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
    #toggle[data-active=true]{color:#60a5fa}
    #toggle[data-active=true]::after{content:"";display:block;position:absolute;bottom:6px;left:50%;transform:translateX(-50%);width:18px;height:2.5px;background:#60a5fa;border-radius:999px}
    #panel{position:fixed;inset:auto;margin:0;width:248px;max-width:calc(100vw - 20px);overflow:auto;padding:11px;background:rgba(16,19,26,.94);backdrop-filter:blur(18px) saturate(1.15);-webkit-backdrop-filter:blur(18px) saturate(1.15);color:#f1f5f9;box-shadow:0 12px 32px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.11);border-radius:12px;white-space:normal;text-shadow:none;line-height:1.4;font-size:12.5px}
    .panel-head{display:flex;align-items:center;gap:7px;padding:1px 2px 9px;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,.08)}
    .mini-mark{display:grid;place-items:center;width:19px;height:19px;border-radius:5px;background:#2563eb;color:#fff;flex-shrink:0}
    .mini-mark svg{display:block}
    h2{font-size:13px;font-weight:600;margin:0;line-height:1.2;letter-spacing:-0.01em;color:#f8fafc}
    #settings{margin-left:auto;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 7px;border-radius:6px;font-size:11.5px;color:#94a3b8;line-height:1}
    #settings:hover{background:rgba(255,255,255,.1);color:#f1f5f9}
    #settings svg{display:block;flex-shrink:0}
    .item{display:flex;flex-direction:column;gap:3px;margin-bottom:7px}
    .action{position:relative;display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);border-radius:8px;font-size:12.5px;font-weight:500;line-height:1;color:#f1f5f9}
    .action::before{content:"";width:6px;height:6px;border-radius:50%;background:rgba(148,163,184,.55);flex-shrink:0;transition:background-color .15s ease,box-shadow .15s ease}
    .action::after{content:"开启";margin-left:auto;font-size:10.5px;font-weight:500;padding:2px 6px;border-radius:999px;background:rgba(255,255,255,.08);color:#94a3b8;line-height:1.2}
    .action:hover:not(:disabled){background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.18)}
    .action:hover:not(:disabled)::after{color:#e2e8f0}
    .action[data-on=true]{background:rgba(37,99,235,.22);border-color:rgba(96,165,250,.48);color:#fff}
    .action[data-on=true]::before{background:#60a5fa;box-shadow:0 0 0 3px rgba(96,165,250,.22)}
    .action[data-on=true]::after{content:"运行中";background:rgba(59,130,246,.32);color:#dbeafe}
    button:disabled{opacity:.5;cursor:wait}
    .desc{margin:0;padding:0 3px;color:#94a3b8;font-size:11px;line-height:1.35}
    .toggle-row{display:flex;align-items:center;justify-content:space-between;gap:8px;height:32px;padding:0 2px;margin-top:2px;border-top:1px solid rgba(255,255,255,.08);font-size:12px;color:#cbd5e1}
    .switch-btn{position:relative;width:32px;height:18px;border-radius:9px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.16);flex-shrink:0}
    .switch-btn::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#cbd5e1;transition:transform .15s ease,background-color .15s ease}
    .switch-btn[aria-checked=true]{background:#2563eb;border-color:#2563eb}
    .switch-btn[aria-checked=true]::after{transform:translateX(14px);background:#fff}
    #feedback{margin:6px 0 0;padding:0 2px;color:#94a3b8;font-size:11px;line-height:1.45;overflow-wrap:anywhere}
    #feedback[data-tone=active]{padding:6px 8px;border-radius:7px;background:rgba(37,99,235,.14);border:1px solid rgba(96,165,250,.24);color:#dbeafe}
    #feedback[data-tone=warn]{padding:6px 8px;border-radius:7px;background:rgba(239,68,68,.14);border:1px solid rgba(248,113,113,.28);color:#fecaca}
    #feedback:empty{display:none}
    .links{display:flex;align-items:center;margin-top:6px;padding:0 2px}
    .links:not(:has(button:not([hidden]))){display:none}
    #shortcuts{font-size:11.5px;padding:3px 0;color:#93c5fd;line-height:1.3}
    #shortcuts:hover{color:#bfdbfe;text-decoration:underline}
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
      <span class="mini-mark" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 32 32" fill="none"><rect x="4" y="4" width="16" height="16" rx="4" fill="white" fill-opacity="0.34"/><rect x="12" y="12" width="16" height="16" rx="4" fill="white"/><path d="M20 14.5V17M16 17H24M22 17.8L16.5 24M19 19L23.5 24" stroke="#1d4ed8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <h2>思译翻译</h2>
      <button id="settings" type="button" title="打开翻译设置">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>设置</span>
      </button>
    </div>
    <div class="item">
      <button id="speech" class="action" type="button">开始实时语音翻译</button>
      <p class="desc">识别视频声音，无需网站字幕</p>
    </div>
    <div class="item">
      <button id="captions" class="action" type="button">开始网站字幕翻译</button>
      <p class="desc">需先开启播放器自带字幕</p>
    </div>
    <div class="toggle-row">
      <span>同时显示原文</span>
      <button id="bilingual" class="switch-btn" type="button" role="switch" aria-checked="true" aria-label="同时显示原文"></button>
    </div>
    <p id="feedback" role="status" aria-live="polite"></p>
    <div class="links"><button id="shortcuts" type="button" hidden>设置快捷键</button></div>
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
    const errMsg=[state?.speech,state?.captions].find(s=>s?.state==='error')?.message||'';
    const hasWarn=!!(notice||activation||errMsg);
    feedback.textContent=notice||(voiceOn?state?.speech.message:captionsOn?state?.captions.message:activation||errMsg||'点击开始后才会发送内容进行翻译。')||'';
    feedback.dataset.tone=hasWarn?'warn':(voiceOn||captionsOn)?'active':'idle';
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
