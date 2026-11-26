import type {PlayerState} from './core/player';
import type {CaptionStyle} from './core/caption-layout';

// Only the top YouTube document loads this small entry point. Mounting never starts a task.
const scope=globalThis as typeof globalThis&{__siPlayerControls?:boolean};
if(!scope.__siPlayerControls){scope.__siPlayerControls=true;boot();}
function boot(){
  const STYLE_ORDER:CaptionStyle[]=['glass','minimal','solid'];
  const STYLE_LABELS:Record<CaptionStyle,string>={glass:'轻磨砂',minimal:'无框描边',solid:'深色高对比'};
  const host=document.createElement('div');host.id='si-player-controls';host.dataset.siOwned='player';host.className='ytp-button';
  host.style.cssText='position:relative;display:inline-block;width:48px;height:100%;vertical-align:top;overflow:visible;';
  const root=host.attachShadow({mode:'open'});
  root.innerHTML=`<style>
    :host{all:initial;display:block;width:100%;height:100%;font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;color:#ededef;text-align:left;line-height:1.4;font-size:13px;-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}
    button{all:unset;box-sizing:border-box;font:inherit;color:inherit;cursor:pointer;transition:background-color .15s ease,border-color .15s ease,color .15s ease,opacity .15s ease}
    button:focus-visible{outline:2px solid #6b94f2;outline-offset:-2px}
    button:disabled{opacity:.42;cursor:default}
    [hidden]{display:none!important}
    #toggle{position:relative;display:grid;place-items:center;width:100%;height:100%;background:transparent;color:rgba(255,255,255,.92)}
    #toggle:hover{color:#fff}
    #toggle svg{display:block;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
    #toggle[data-active=true]{color:#6b94f2}
    #toggle[data-active=true]::after{content:"";display:block;position:absolute;bottom:6px;left:50%;transform:translateX(-50%);width:18px;height:2.5px;background:#34d399;border-radius:999px}
    #panel{position:fixed;inset:auto;margin:0;width:256px;max-width:calc(100vw - 20px);overflow:auto;padding:8px;background:rgba(20,21,24,.94);backdrop-filter:blur(20px) saturate(1.1);-webkit-backdrop-filter:blur(20px) saturate(1.1);color:#ededef;box-shadow:0 14px 36px rgba(0,0,0,.58),0 2px 8px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.09);border-radius:12px;white-space:normal;text-shadow:none;line-height:1.4;font-size:13px}
    .panel-head{display:flex;align-items:center;gap:8px;height:36px;padding:0 4px 8px 8px;margin-bottom:4px;border-bottom:1px solid rgba(255,255,255,.07)}
    .mini-mark{display:grid;place-items:center;width:18px;height:18px;border-radius:5px;background:#3b6ad4;color:#fff;flex-shrink:0}
    .mini-mark svg{display:block}
    h2{font-size:13.5px;font-weight:600;margin:0;line-height:1.2;letter-spacing:-0.01em;color:#ededef}
    .status-pill{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:#9a9fa8;line-height:1;white-space:nowrap}
    .status-pill::before{content:"";width:6px;height:6px;border-radius:50%;background:#686d76;flex-shrink:0;transition:background-color .15s ease,box-shadow .15s ease}
    .status-pill[data-live=true]{color:#6ee7b7}
    .status-pill[data-live=true]::before{background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.18)}
    #settings{display:grid;place-items:center;width:26px;height:26px;border-radius:6px;color:#9a9fa8;flex-shrink:0}
    #settings:hover{background:rgba(255,255,255,.08);color:#ededef}
    #settings svg{display:block}
    .group{display:flex;flex-direction:column;gap:2px}
    .divider{height:1px;margin:6px 8px;background:rgba(255,255,255,.07)}
    .menu-row{display:flex;align-items:center;gap:10px;width:100%;height:36px;padding:0 8px;border-radius:8px;font-size:13px;font-weight:400;color:#ededef;line-height:1.2}
    button.menu-row:hover:not(:disabled){background:rgba(255,255,255,.06)}
    button.menu-row:active:not(:disabled){background:rgba(255,255,255,.09)}
    .row-icon{display:grid;place-items:center;width:16px;height:16px;color:#9a9fa8;flex-shrink:0;transition:color .15s ease}
    .row-icon svg{display:block}
    button.menu-row[aria-checked=true] .row-icon{color:#6b94f2}
    .row-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .switch-track{position:relative;width:34px;height:18px;border-radius:999px;background:rgba(255,255,255,.18);flex-shrink:0;transition:background-color .16s ease}
    .switch-track::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .16s cubic-bezier(.22,1,.36,1)}
    .menu-row[aria-checked=true] .switch-track{background:#3b6ad4}
    .menu-row[aria-checked=true] .switch-track::after{transform:translateX(16px)}
    .row-value{font-size:12px;color:#9a9fa8;margin-left:auto;white-space:nowrap}
    .chevron{display:block;color:#686d76;flex-shrink:0;margin-left:-4px}
    button.menu-row:hover .row-value{color:#d4d7de}
    .stepper{display:inline-flex;align-items:center;gap:2px;margin-left:auto;background:rgba(255,255,255,.06);border-radius:6px;padding:2px}
    .step-btn{display:grid;place-items:center;width:22px;height:22px;border-radius:5px;font-size:13px;font-weight:500;color:#cbd5e1;line-height:1}
    .step-btn:hover:not(:disabled){background:rgba(255,255,255,.12);color:#fff}
    .step-val{min-width:34px;text-align:center;font-size:11.5px;font-weight:500;color:#d4d7de;font-variant-numeric:tabular-nums}
    #feedback{margin:6px 4px 2px;padding:7px 10px;border-radius:8px;font-size:11.5px;line-height:1.45;overflow-wrap:anywhere;background:rgba(255,255,255,.05);color:#cbd5e1}
    #feedback[data-tone=warn]{background:rgba(251,191,36,.12);color:#fde68a}
    #feedback[data-tone=error]{background:rgba(248,113,113,.13);color:#fecaca}
    #feedback:empty{display:none}
    .links{display:flex;align-items:center;margin-top:4px;padding:0 6px}
    .links:not(:has(button:not([hidden]))){display:none}
    #shortcuts{font-size:11.5px;padding:3px 0;color:#6b94f2;line-height:1.3}
    #shortcuts:hover{color:#93b4f7;text-decoration:underline}
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
      <span class="mini-mark" aria-hidden="true"><svg width="11" height="11" viewBox="0 0 32 32" fill="none"><rect x="4" y="4" width="16" height="16" rx="4" fill="white" fill-opacity="0.34"/><rect x="12" y="12" width="16" height="16" rx="4" fill="white"/><path d="M20 14.5V17M16 17H24M22 17.8L16.5 24M19 19L23.5 24" stroke="#2b5ce0" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <h2>思译</h2>
      <span id="status-pill" class="status-pill" data-live="false">未开启</span>
      <button id="settings" type="button" title="翻译设置" aria-label="翻译设置">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
    </div>
    <div class="group">
      <button id="speech" class="menu-row" type="button" role="switch" aria-checked="false" title="识别视频声音，无需网站字幕">
        <span class="row-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M8 8v8"/><path d="M16 8v8"/><path d="M4 11v2"/><path d="M20 11v2"/></svg></span>
        <span class="row-label">实时语音翻译</span>
        <span class="switch-track" aria-hidden="true"></span>
      </button>
      <button id="captions" class="menu-row" type="button" role="switch" aria-checked="false" title="需先开启播放器自带字幕">
        <span class="row-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M7 13h4"/><path d="M14 13h3"/><path d="M7 10h2"/><path d="M12 10h5"/></svg></span>
        <span class="row-label">网站字幕翻译</span>
        <span class="switch-track" aria-hidden="true"></span>
      </button>
    </div>
    <div class="divider"></div>
    <div class="group">
      <button id="bilingual" class="menu-row" type="button" role="switch" aria-checked="true">
        <span class="row-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 12h12"/><path d="M4 17h9"/></svg></span>
        <span class="row-label">同时显示原文</span>
        <span class="switch-track" aria-hidden="true"></span>
      </button>
      <button id="caption-style" class="menu-row" type="button" title="点击切换字幕背景风格">
        <span class="row-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg></span>
        <span class="row-label">字幕风格</span>
        <span id="caption-style-val" class="row-value">轻磨砂</span>
        <svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
      <div class="menu-row" role="group" aria-label="字体大小">
        <span class="row-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19 9 6l5 13"/><path d="M5.8 14.5h6.4"/><path d="M16 19v-7"/><path d="M19.5 19v-7"/><path d="M16 15.5h3.5"/></svg></span>
        <span class="row-label">字体大小</span>
        <span class="stepper">
          <button id="font-dec" class="step-btn" type="button" aria-label="减小字号">−</button>
          <span id="font-size-val" class="step-val">22px</span>
          <button id="font-inc" class="step-btn" type="button" aria-label="增大字号">+</button>
        </span>
      </div>
    </div>
    <p id="feedback" role="status" aria-live="polite"></p>
    <div class="links"><button id="shortcuts" type="button" hidden>设置快捷键</button></div>
  </section>`;
  const get=<T extends HTMLElement>(id:string)=>root.getElementById(id) as T;
  const toggle=get<HTMLButtonElement>('toggle'),panel=get<HTMLElement>('panel'),statusPill=get<HTMLElement>('status-pill');
  const speech=get<HTMLButtonElement>('speech'),captions=get<HTMLButtonElement>('captions'),bilingual=get<HTMLButtonElement>('bilingual');
  const styleBtn=get<HTMLButtonElement>('caption-style'),styleVal=get<HTMLElement>('caption-style-val');
  const fontDec=get<HTMLButtonElement>('font-dec'),fontInc=get<HTMLButtonElement>('font-inc'),fontVal=get<HTMLElement>('font-size-val');
  const feedback=get<HTMLElement>('feedback');
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
    const voiceOn=active(state?.speech.state),captionsOn=active(state?.captions.state),isLive=voiceOn||captionsOn;
    toggle.dataset.active=String(isLive);
    toggle.title=voiceOn?'思译：实时语音翻译中':captionsOn?'思译：网站字幕翻译中':'思译翻译';
    statusPill.dataset.live=String(isLive);
    statusPill.textContent=voiceOn?(state?.speech.state==='connecting'?'语音连接中':'语音运行中'):captionsOn?(state?.captions.state==='loading'?'字幕读取中':'字幕运行中'):'未开启';
    speech.setAttribute('aria-checked',String(voiceOn));
    captions.setAttribute('aria-checked',String(captionsOn));
    bilingual.setAttribute('aria-checked',String(state?.showOriginal!==false));
    const currentStyle:CaptionStyle=state?.captionStyle??'glass';
    styleVal.textContent=STYLE_LABELS[currentStyle]??'轻磨砂';
    const currentFont=state?.fontSize??22;
    fontVal.textContent=`${currentFont}px`;
    const disabled=busy||!state;
    speech.disabled=captions.disabled=bilingual.disabled=styleBtn.disabled=disabled;
    fontDec.disabled=disabled||currentFont<=14;
    fontInc.disabled=disabled||currentFont>=40;
    const activation=state?.speech.needsActivation?(state.shortcut?`当前标签页需要音频授权，请按 ${state.shortcut} 开始实时翻译；之后可在此开关。`:'当前标签页需要音频授权，请先设置“开始 / 停止实时语音翻译”快捷键，再按快捷键启动。'):'';
    const errMsg=[state?.speech,state?.captions].find(s=>s?.state==='error')?.message||'';
    const infoMsg=captionsOn&&state?.captions.message&&/开启字幕|等待播放器/.test(state.captions.message)?state.captions.message:'';
    feedback.textContent=notice||activation||errMsg||infoMsg||'';
    feedback.dataset.tone=activation?'warn':(notice||errMsg)?'error':'info';
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
  function patchCaption(patch:Record<string,unknown>,errText:string){
    if(busy||!state)return;busy=true;notice='';render();
    void rpc<PlayerState>({type:'player:caption',patch})
      .then(updated=>{state=updated;})
      .catch(error=>{notice=error instanceof Error?error.message:errText;})
      .finally(()=>{busy=false;render();});
  }
  speech.addEventListener('click',event=>{if(event.isTrusted)void action('speech');});
  captions.addEventListener('click',event=>{if(event.isTrusted)void action('captions');});
  bilingual.addEventListener('click',event=>{
    if(!event.isTrusted||!state)return;
    patchCaption({showOriginal:state.showOriginal===false},'无法切换双语显示。');
  });
  styleBtn.addEventListener('click',event=>{
    if(!event.isTrusted||!state)return;
    const idx=STYLE_ORDER.indexOf(state.captionStyle??'glass');
    const next=STYLE_ORDER[(idx+1)%STYLE_ORDER.length];
    patchCaption({style:next},'无法切换字幕风格。');
  });
  fontDec.addEventListener('click',event=>{
    if(!event.isTrusted||!state)return;
    patchCaption({fontSize:Math.max(14,(state.fontSize??22)-2)},'无法调整字号。');
  });
  fontInc.addEventListener('click',event=>{
    if(!event.isTrusted||!state)return;
    patchCaption({fontSize:Math.min(40,(state.fontSize??22)+2)},'无法调整字号。');
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
