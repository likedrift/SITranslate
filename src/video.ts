import {EMPTY_VIDEO_STATUS,NO_VIDEO_CAPTION_MESSAGE,type PublicConfig,type TranslationResult,type VideoStatus} from './core/types';
import {cueIndex,activeSubtitle,subtitleText,YouTubeCaptionTracker,type SubtitleCue} from './core/subtitles';
import {DEFAULT_CAPTION,normalizeCaption,captionBounds,captionChrome,captionGestureLayout,captionPages,clamp,type CaptionLayout,type CaptionBox,type CaptionCorner} from './core/caption-layout';
import {LiveReader} from './core/live-reader';
import {PAUSE_SCROLL_NOTE,liveInterruptHint} from './core/live-hints';
import {LiveSeekGuard} from './core/live-seek';

// Loaded only after an explicit video action; ordinary pages do not load this module.
const scope=globalThis as typeof globalThis&{__siVideoTranslate?:boolean};
if(!scope.__siVideoTranslate){scope.__siVideoTranslate=true;boot();}
function boot(){
  interface Entry {cue:SubtitleCue;state:'pending'|'running'|'done'|'failed';text?:string}
  let status:VideoStatus={...EMPTY_VIDEO_STATUS};
  let video:HTMLVideoElement|undefined,track:TextTrack|undefined,originalMode:TextTrackMode|undefined;
  let config:PublicConfig|undefined,host:HTMLDivElement|undefined,original:HTMLDivElement|undefined,translated:HTMLDivElement|undefined;
  let task='',generation=0,timer:ReturnType<typeof setInterval>|undefined,loadingTimer:ReturnType<typeof setTimeout>|undefined;
  let entries=new Map<string,Entry>(),current:SubtitleCue[]=[],working=false;
  let youtube=false,videoId='',mediaSource='',lastTime=0,lastError='';
  const ytTracker=new YouTubeCaptionTracker();
  let liveSession='',liveShownAt=0,endedSession='',restartHint='',ending=false,restartTimer:ReturnType<typeof setTimeout>|undefined;
  let recognitionId:string|undefined,resyncing=false,seekPaused=false,seekTimer:ReturnType<typeof setTimeout>|undefined;
  const reader=new LiveReader();let livePreview='',previousLine:HTMLDivElement|undefined,liveTools:HTMLDivElement|undefined,holdButton:HTMLButtonElement|undefined,liveHint:HTMLSpanElement|undefined;
  const painted=new Set<string>();let paintScheduled=false;
  let layout:CaptionLayout=structuredClone(DEFAULT_CAPTION),layoutEpoch=0,card:HTMLDivElement|undefined,pager:HTMLDivElement|undefined;
  let menu:HTMLDivElement|undefined,menuToggle:HTMLButtonElement|undefined,menuOpen=false,menuHideTimer:ReturnType<typeof setTimeout>|undefined,hoveringOverlay=false;
  let quickOriginalBtn:HTMLButtonElement|undefined,quickLockBtn:HTMLButtonElement|undefined;
  let content:HTMLDivElement|undefined,pendingLayout:CaptionLayout|undefined;
  let ytStreamRequestId='',ytStreamText='';
  let pageIndex=0,pageKey='',pageAt=0,pageCount=1;
  let drag:{x:number;y:number;pointerId:number;box:CaptionBox;area:CaptionBox;before:CaptionLayout;full:boolean;corner?:CaptionCorner;minHeight:number;moved:boolean}|undefined;
  const disposers:(()=>void)[]=[];
  async function rpc<T=unknown>(value:unknown):Promise<T>{const r=await chrome.runtime.sendMessage(value);if(!r?.ok)throw new Error(r?.error??'扩展连接中断。');return r.data;}
  const notifyPlayer=()=>{void rpc({type:'player:changed'}).catch(()=>{});};
  function cancel(){if(task)void rpc({type:'task:cancel',taskId:task}).catch(()=>{});task=`subtitle-${crypto.randomUUID()}`;generation++;working=false;for(const e of entries.values())if(e.state==='running')e.state='pending';}
  function listen(target:EventTarget,event:string,fn:()=>void){target.addEventListener(event,fn);disposers.push(()=>target.removeEventListener(event,fn));}
  function stop(message='字幕翻译已停止。'){
    if(seekTimer)clearTimeout(seekTimer);seekTimer=undefined;resyncing=false;seekPaused=false;recognitionId=undefined;
    liveSession='';endedSession='';restartHint='';ending=false;if(restartTimer)clearTimeout(restartTimer);restartTimer=undefined;
    reader.reset();painted.clear();livePreview='';previousLine=undefined;liveTools=undefined;paintScheduled=false;
    cancel();if(timer)clearInterval(timer);if(loadingTimer)clearTimeout(loadingTimer);timer=undefined;loadingTimer=undefined;
    for(const dispose of disposers.splice(0))dispose();
    if(track&&originalMode&&track.mode==='hidden')track.mode=originalMode;
    if(menuHideTimer){clearTimeout(menuHideTimer);menuHideTimer=undefined;}hoveringOverlay=false;
    host?.remove();host=undefined;original=undefined;translated=undefined;card=undefined;menu=undefined;menuToggle=undefined;menuOpen=false;quickOriginalBtn=undefined;quickLockBtn=undefined;pager=undefined;content=undefined;drag=undefined;pendingLayout=undefined;pageKey='';video=undefined;track=undefined;entries.clear();current=[];ytTracker.reset();ytStreamRequestId='';ytStreamText='';
    lastError='';status={...status,state:'stopped',message};
    notifyPlayer();
  }
  function findVideo(){
    const videos=[...document.querySelectorAll('video')].filter(v=>{const r=v.getBoundingClientRect();return r.width>40&&r.height>30;});
    return videos.sort((a,b)=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return y.width*y.height-x.width*x.height;})[0];
  }
  function scheduleMenuAutoHide(){
    if(menuHideTimer){clearTimeout(menuHideTimer);menuHideTimer=undefined;}
    if(!menuOpen||hoveringOverlay||drag)return;
    menuHideTimer=setTimeout(()=>{
      menuHideTimer=undefined;
      if(menuOpen&&!hoveringOverlay&&!drag&&!card?.matches(':has(:focus-visible)')){menuOpen=false;render();}
    },3200);
  }
  function blurMouseClick(event:MouseEvent){
    if(event.detail>0&&event.currentTarget instanceof HTMLElement)event.currentTarget.blur();
  }
  function quickPatch(patch:Partial<CaptionLayout>){
    layoutEpoch++;
    useLayout({...layout,...patch});
    render();
    void rpc<CaptionLayout>({type:'caption:quick',patch}).then(s=>{useLayout(s);render();}).catch(()=>{});
  }
  function applyCardAppearance(){
    if(!card)return;
    const styleMode=layout.style??'glass';
    const op=clamp(layout.opacity,0.1,1);
    card.dataset.style=styleMode;
    if(styleMode==='minimal'){
      card.style.background='transparent';
      card.style.backdropFilter='none';
      card.style.setProperty('-webkit-backdrop-filter','none');
      card.style.borderColor='transparent';
      card.style.boxShadow='none';
      return;
    }
    if(styleMode==='solid'){
      card.style.background=`rgba(10,12,18,${Math.max(0.55,op)})`;
      card.style.backdropFilter='none';
      card.style.setProperty('-webkit-backdrop-filter','none');
      card.style.borderColor='rgba(255,255,255,0.08)';
      card.style.boxShadow='0 6px 20px rgba(0,0,0,0.42)';
      return;
    }
    // Glass mode: scale blur, border and shadow gracefully with opacity so low-opacity stays airy.
    const lowFactor=clamp((op-0.12)/0.68,0,1);
    const blurPx=Math.round(lowFactor*14);
    const borderAlpha=(0.03+lowFactor*0.08).toFixed(3);
    const topLight=(0.04+lowFactor*0.1).toFixed(3);
    const shadowAlpha=(lowFactor*0.3).toFixed(3);
    card.style.background=`rgba(14,18,26,${op})`;
    const blurVal=blurPx>0?`blur(${blurPx}px) saturate(${(1+lowFactor*0.18).toFixed(2)})`:'none';
    card.style.backdropFilter=blurVal;
    card.style.setProperty('-webkit-backdrop-filter',blurVal);
    card.style.borderColor=`rgba(255,255,255,${borderAlpha})`;
    card.style.boxShadow=blurPx>0?`0 8px 26px rgba(0,0,0,${shadowAlpha}), inset 0 1px 0 rgba(255,255,255,${topLight})`:'none';
  }
  function overlay(){
    host=document.createElement('div');host.dataset.siOwned='video';host.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;';
    const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style');
    for(const type of ['click','keydown','pointerdown'])shadow.addEventListener(type,e=>e.stopPropagation());
    style.textContent=':host{all:initial;pointer-events:none;font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif}:host([hidden]){display:none!important}[hidden]{display:none!important}.caption{position:relative;display:flex;align-items:center;justify-content:center;box-sizing:border-box;font:600 22px/1.48 "Segoe UI",-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;text-align:center;color:#f8fafc;overflow-wrap:anywhere;white-space:pre-line;text-shadow:0 1px 2px rgba(0,0,0,.9),0 2px 8px rgba(0,0,0,.6);padding:10px 16px;border-radius:12px;border:1px solid transparent;transition:border-color .18s ease,background-color .18s ease,box-shadow .18s ease}.caption[data-style=minimal]{text-shadow:0 0 4px rgba(0,0,0,.98),0 1px 3px rgba(0,0,0,.96),0 2px 10px rgba(0,0,0,.82)}.caption[data-style=minimal]:hover,.caption[data-style=minimal].moving,.caption[data-style=minimal]:has(:focus-visible){background:rgba(14,18,26,.46)!important;backdrop-filter:blur(8px)!important;-webkit-backdrop-filter:blur(8px)!important}.caption:hover,.caption.moving,.caption:has(:focus-visible){border-color:rgba(255,255,255,.24)!important}.caption:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}.content{width:100%;min-width:0}.prev-line{font-size:.75em;font-weight:400;opacity:.66;margin-bottom:5px;line-height:1.4}.source{font-size:.78em;font-weight:400;opacity:.88;line-height:1.42}.target{margin-top:4px;line-height:1.46}.target:empty{display:none}button{pointer-events:auto;font:500 12px/1.3 "Segoe UI",-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#f1f5f9;background:rgba(30,34,43,.92);border:1px solid rgba(255,255,255,.14);border-radius:7px;padding:4px 9px;cursor:pointer;transition:background-color .15s ease,border-color .15s ease,opacity .18s ease,color .15s ease}button:hover{background:rgba(44,50,64,.98);border-color:rgba(255,255,255,.28)}button:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}button[aria-pressed=true]{background:rgba(37,99,235,.28);border-color:rgba(96,165,250,.55);color:#dbeafe}.menu-toggle{position:absolute;right:0;bottom:calc(100% + 4px);z-index:2;opacity:0;padding:2px 8px;line-height:1.35;min-height:22px;background:rgba(18,22,30,.86);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-radius:7px}.caption:hover .menu-toggle,.caption:has(:focus-visible) .menu-toggle,.menu-toggle:hover,.menu-toggle:focus-visible,.menu-toggle[aria-expanded=true]{opacity:1}.menu{position:absolute;left:0;right:0;bottom:calc(100% + 30px);z-index:2;display:flex;flex-direction:column;gap:7px;padding:8px 10px;border-radius:11px;background:rgba(16,20,28,.93);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.13);box-shadow:0 12px 32px rgba(0,0,0,.46);pointer-events:auto;text-shadow:none}.caption.menu-below .menu-toggle{bottom:auto;top:calc(100% + 4px)}.caption.menu-below .menu{bottom:auto;top:calc(100% + 30px)}.pages{font:12px/1.4 "Segoe UI",-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;margin-top:0;display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px 8px;color:#cbd5e1}.pages + .pages{padding-top:7px;border-top:1px solid rgba(255,255,255,.09)}.note{font-weight:400;color:#94a3b8;font-size:11px}.caption:not(.locked){pointer-events:auto;cursor:grab;touch-action:none;user-select:none}.caption.moving{cursor:grabbing}.resize{position:absolute;width:18px;height:18px;padding:0;border:0;background:transparent;touch-action:none;opacity:0;transition:opacity .18s ease,background-color .15s ease}.resize:after{content:"";position:absolute;inset:4px;border:solid rgba(241,245,249,.82);border-width:0 2px 2px 0;border-radius:1px}.caption:hover .resize,.caption:has(:focus-visible) .resize,.caption.moving .resize{opacity:.78}.resize:hover,.resize:focus-visible{opacity:1!important;background:rgba(255,255,255,.14)}.nw{top:0;left:0;cursor:nwse-resize}.ne{top:0;right:0;cursor:nesw-resize}.sw{bottom:0;left:0;cursor:nesw-resize}.se{bottom:0;right:0;cursor:nwse-resize}.nw:after{transform:rotate(180deg)}.ne:after{transform:rotate(270deg)}.sw:after{transform:rotate(90deg)}.locked .resize{display:none}@media(prefers-reduced-motion:reduce){*{transition:none!important}}';
    card=document.createElement('div');card.className='caption';original=document.createElement('div');original.className='source';translated=document.createElement('div');translated.className='target';
    previousLine=document.createElement('div');previousLine.className='prev-line';previousLine.hidden=true;
    liveTools=document.createElement('div');liveTools.className='pages';liveTools.hidden=true;
    const back=document.createElement('button'),forward=document.createElement('button'),latestButton=document.createElement('button');holdButton=document.createElement('button');liveHint=document.createElement('span');
    back.textContent='‹';back.setAttribute('aria-label','上一条译文');back.onclick=e=>{blurMouseClick(e);reader.back(Date.now());pageKey='';render();scheduleMenuAutoHide();};
    forward.textContent='›';forward.setAttribute('aria-label','下一条译文');forward.onclick=e=>{blurMouseClick(e);reader.forward(Date.now());pageKey='';render();scheduleMenuAutoHide();};
    holdButton.onclick=e=>{blurMouseClick(e);reader.paused=!reader.paused;render();scheduleMenuAutoHide();};
    const pauseNote=document.createElement('span');pauseNote.className='note';pauseNote.textContent=PAUSE_SCROLL_NOTE;
    latestButton.textContent='回到最新';latestButton.onclick=e=>{blurMouseClick(e);reader.latest(Date.now());pageKey='';render();scheduleMenuAutoHide();};
    liveTools.append(back,holdButton,pauseNote,forward,latestButton,liveHint);
    menuToggle=document.createElement('button');menuToggle.className='menu-toggle';menuToggle.type='button';menuToggle.hidden=true;menuToggle.textContent='⋯';menuToggle.title='字幕操作';menuToggle.setAttribute('aria-label','字幕操作');menuToggle.setAttribute('aria-haspopup','true');menuToggle.setAttribute('aria-expanded','false');
    menu=document.createElement('div');menu.className='menu';menu.hidden=true;menu.setAttribute('role','group');menu.setAttribute('aria-label','字幕操作');
    pager=document.createElement('div');pager.className='pages';
    const previous=document.createElement('button'),next=document.createElement('button'),count=document.createElement('span');previous.textContent='‹';next.textContent='›';previous.setAttribute('aria-label','上一页字幕');next.setAttribute('aria-label','下一页字幕');
    const turn=(delta:number)=>{pageIndex=(pageIndex+delta+pageCount)%pageCount;pageAt=Date.now();render();scheduleMenuAutoHide();};
    previous.onclick=e=>{blurMouseClick(e);turn(-1);};next.onclick=e=>{blurMouseClick(e);turn(1);};pager.append(previous,count,next);
    const quickBar=document.createElement('div');quickBar.className='pages';
    quickOriginalBtn=document.createElement('button');quickOriginalBtn.type='button';quickOriginalBtn.textContent='原文';quickOriginalBtn.title='切换同时显示原文';
    quickOriginalBtn.onclick=e=>{blurMouseClick(e);quickPatch({showOriginal:!layout.showOriginal});scheduleMenuAutoHide();};
    const fontDown=document.createElement('button'),fontUp=document.createElement('button');
    fontDown.type='button';fontDown.textContent='A-';fontDown.setAttribute('aria-label','减小字号');fontDown.onclick=e=>{blurMouseClick(e);quickPatch({fontSize:clamp(layout.fontSize-2,14,40)});scheduleMenuAutoHide();};
    fontUp.type='button';fontUp.textContent='A+';fontUp.setAttribute('aria-label','增大字号');fontUp.onclick=e=>{blurMouseClick(e);quickPatch({fontSize:clamp(layout.fontSize+2,14,40)});scheduleMenuAutoHide();};
    quickLockBtn=document.createElement('button');quickLockBtn.type='button';quickLockBtn.textContent='锁定';quickLockBtn.title='锁定位置和尺寸';
    quickLockBtn.onclick=e=>{blurMouseClick(e);quickPatch({locked:!layout.locked});scheduleMenuAutoHide();};
    quickBar.append(quickOriginalBtn,fontDown,fontUp,quickLockBtn);
    menu.append(pager,liveTools,quickBar);
    menuToggle.onclick=e=>{blurMouseClick(e);menuOpen=!menuOpen;render();if(menuOpen)scheduleMenuAutoHide();else if(menuHideTimer){clearTimeout(menuHideTimer);menuHideTimer=undefined;}};
    card.addEventListener('pointerenter',()=>{hoveringOverlay=true;if(menuHideTimer){clearTimeout(menuHideTimer);menuHideTimer=undefined;}});
    card.addEventListener('pointerleave',()=>{hoveringOverlay=false;scheduleMenuAutoHide();});
    const outsideClose=(e:PointerEvent)=>{if(menuOpen&&host&&!e.composedPath().includes(host)){menuOpen=false;if(menuHideTimer){clearTimeout(menuHideTimer);menuHideTimer=undefined;}render();}};
    document.addEventListener('pointerdown',outsideClose,{capture:true,passive:true});
    disposers.push(()=>document.removeEventListener('pointerdown',outsideClose,{capture:true}));
    card.onpointerdown=e=>{if(!(e.target instanceof Element)||e.target.closest('button,a,input,select,textarea,.menu'))return;beginGesture(e);};
    card.onpointermove=e=>moveGesture(e);card.onpointerup=e=>{if(e.pointerId===drag?.pointerId)finishGesture();};card.onpointercancel=e=>{if(e.pointerId===drag?.pointerId)finishGesture(true);};
    card.onlostpointercapture=()=>finishGesture(true);
    const escapeGesture=(e:KeyboardEvent)=>{if(e.key!=='Escape')return;if(drag){e.preventDefault();e.stopPropagation();finishGesture(true);return;}if(menuOpen){e.preventDefault();e.stopPropagation();menuOpen=false;render();}};
    window.addEventListener('keydown',escapeGesture,true);disposers.push(()=>window.removeEventListener('keydown',escapeGesture,true));
    card.tabIndex=0;card.setAttribute('role','group');card.setAttribute('aria-label','字幕，方向键可移动');
    card.onkeydown=e=>{const moves:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(!moves[e.key]||layout.locked||e.target!==card)return;e.preventDefault();e.stopPropagation();const full=!!document.fullscreenElement,key=full?'fullscreen':'normal',p=layout[key]??{x:.5,y:.85},d=e.shiftKey ? .08 : .02;layout[key]={x:clamp(p.x+moves[e.key][0]*d,0,1),y:clamp(p.y+moves[e.key][1]*d,0,1)};render();savePosition(full);};
    content=document.createElement('div');content.className='content';content.append(previousLine,original,translated);card.append(menuToggle,menu,content);
    for(const [corner,label] of [['nw','左上角'],['ne','右上角'],['sw','左下角'],['se','右下角']] as const){
      const grip=document.createElement('button');grip.className='resize '+corner;grip.setAttribute('aria-label',label+'缩放字幕');grip.title=label+'缩放字幕（方向键微调）';grip.onpointerdown=e=>beginGesture(e,corner);
      grip.onkeydown=e=>{const moves:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(!moves[e.key]||layout.locked)return;e.preventDefault();e.stopPropagation();beginGesture(new PointerEvent('pointerdown',{button:0,pointerId:-1,clientX:0,clientY:0}),corner);if(drag){const step=e.shiftKey?24:8;moveGesture(new PointerEvent('pointermove',{pointerId:-1,clientX:moves[e.key][0]*step,clientY:moves[e.key][1]*step}));finishGesture();}};
      card.append(grip);
    }
    shadow.append(style,card);document.documentElement.append(host);
    listen(window,'resize',()=>{finishGesture(true);render();});
    const run=generation,epoch=layoutEpoch;void rpc<CaptionLayout>({type:'caption:get'}).then(s=>{if(run!==generation||epoch!==layoutEpoch)return;useLayout(s);render();}).catch(()=>{});
  }
  function beginGesture(e:PointerEvent,corner?:CaptionCorner){
    if(layout.locked||e.button!==0||drag||!host||!card)return;e.preventDefault();e.stopPropagation();
    const box=host.getBoundingClientRect(),full=!!document.fullscreenElement,r=video?.getBoundingClientRect()??new DOMRect(0,0,innerWidth,innerHeight),b=captionBounds(r,innerWidth,innerHeight,layout,box.height,full);
    drag={x:e.clientX,y:e.clientY,pointerId:e.pointerId,box:{left:box.left,top:box.top,width:box.width,height:box.height},area:{left:b.originX,top:b.originY,width:b.areaWidth,height:b.areaHeight},before:structuredClone(layout),full,corner,minHeight:(content?.getBoundingClientRect().height??32)+16,moved:false};
    if(e.pointerId>=0)card.setPointerCapture(e.pointerId);
  }
  function moveGesture(e:PointerEvent){
    if(!drag||!host||e.pointerId!==drag.pointerId)return;e.preventDefault();
    const d=drag,dx=e.clientX-d.x,dy=e.clientY-d.y;if(!d.moved&&Math.hypot(dx,dy)<3)return;d.moved=true;
    layout=captionGestureLayout(d.before,{full:d.full,corner:d.corner,box:d.box,area:d.area,dx,dy,minHeight:d.minHeight});
    render();
  }
  function finishGesture(cancelled=false){
    if(!drag)return;const d=drag;drag=undefined;
    if(card?.hasPointerCapture(d.pointerId))card.releasePointerCapture(d.pointerId);
    if(cancelled)layout=d.before;
    const key=d.full?'fullscreen':'normal',position=layout[key],size=layout[d.full?'fullscreenSize':'normalSize'],fontSize=d.corner?layout.fontSize:undefined;
    if(pendingLayout){layout=pendingLayout;pendingLayout=undefined;}status.bilingual=layout.showOriginal;render();
    if(cancelled||!d.moved)return;
    const run=generation,epoch=layoutEpoch;void rpc<CaptionLayout>({type:'caption:geometry',context:key,position,size,...(fontSize!==undefined?{fontSize}:{})}).then(s=>{if(run===generation&&epoch===layoutEpoch&&!drag){useLayout(s);render();}}).catch(()=>{});
  }
  function useLayout(next:CaptionLayout){layout=next;status.bilingual=layout.showOriginal;}
  async function ensureLayout(){const run=generation,epoch=layoutEpoch;try{const stored=(await chrome.storage.local.get('captionLayout')).captionLayout;if(run!==generation||epoch!==layoutEpoch)return;useLayout(normalizeCaption(stored));}catch{status.bilingual=layout.showOriginal;}}
  function savePosition(full:boolean){void rpc({type:'caption:position',context:full?'fullscreen':'normal',position:layout[full?'fullscreen':'normal']}).catch(()=>{});}
  function videoSourceChanged(){
    if(!video)return false;
    if(mediaSource&&video.currentSrc&&video.currentSrc!==mediaSource)return true;
    return youtube&&new URL(location.href).searchParams.get('v')!==videoId;
  }
  function placeHost(){
    if(!host||!card)return;
    const full=document.fullscreenElement,parent=full&&video?.isConnected&&full.contains(video)&&full.tagName!=='VIDEO'?full:document.documentElement;
    if(host.parentElement!==parent)parent.append(host);
    const rect=video?.isConnected?video.getBoundingClientRect():new DOMRect(0,0,innerWidth,innerHeight);
    const bounds=captionBounds(rect,innerWidth,innerHeight,layout,0,!!full);host.style.width=`${bounds.width}px`;card.style.fontSize=`${layout.fontSize}px`;applyCardAppearance();
    const positioned=captionBounds(rect,innerWidth,innerHeight,layout,host.getBoundingClientRect().height,!!full);host.style.left=`${positioned.left}px`;host.style.top=`${positioned.top}px`;card.classList.toggle('menu-below',positioned.top<120);
  }
  function paintRestartHint(){
    if(!host||!translated)return;
    host.hidden=false;if(original)original.textContent='';translated.textContent=restartHint;translated.setAttribute('aria-live','polite');
    if(previousLine)previousLine.hidden=true;if(pager)pager.hidden=true;if(liveTools)liveTools.hidden=true;if(menu)menu.hidden=true;if(menuToggle)menuToggle.hidden=true;placeHost();
  }
  function armRestartHint(text:string){
    restartHint=text.slice(0,200);ending=true;status={...status,state:'stopped',message:restartHint};paintRestartHint();
    if(restartTimer)clearTimeout(restartTimer);
    restartTimer=setTimeout(()=>{restartHint='';stop('实时语音字幕已停止。');},7000);
  }
  function adoptHint(text:string){
    endedSession=liveSession||endedSession;liveSession='';if(timer)clearInterval(timer);timer=undefined;
    for(const dispose of disposers.splice(0))dispose();armRestartHint(text);
  }
  function interrupt(cause:'seek'|'video'){
    if(!liveSession||ending)return;ending=true;endedSession=liveSession;const sessionId=liveSession;
    armRestartHint(liveInterruptHint(cause));void rpc({type:'speech:stop',sessionId,cause}).catch(()=>{});
  }
  function resetLiveText(){reader.reset();painted.clear();livePreview='';entries.clear();current=[];pageKey='';liveShownAt=0;render();}
  function render(){
    status.bilingual=layout.showOriginal;
    if(restartHint&&host&&translated){paintRestartHint();return;}
    if(translated)translated.removeAttribute('aria-live');
    if(!host||!original||!translated||!card||!menu||!menuToggle||!pager||!liveTools||(!video&&!liveSession))return;
    const full=document.fullscreenElement,parent=full&&video&&full.contains(video)&&full.tagName!=='VIDEO'?full:document.documentElement;
    if(host.parentElement!==parent)parent.append(host);
    if(liveSession)reader.tick(Date.now(),layout.readingMode??'balanced');
    const active=reader.current,rect=video?.getBoundingClientRect()??new DOMRect(0,0,innerWidth,innerHeight);
    const ytDisplay=!liveSession&&youtube?ytTracker.display():undefined;
    const source=liveSession?(active?.source??livePreview):ytDisplay?ytDisplay.source:current.map(c=>c.text).join('\n');
    const texts=liveSession?(active?.text??''):ytDisplay?(ytDisplay.translation||ytStreamText):current.map(c=>entries.get(c.id)?.text??'').filter(Boolean).join('\n');
    if(drag&&drag.full!==!!full)finishGesture(true);
    const bounds=captionBounds(rect,innerWidth,innerHeight,layout,0,!!full);host.style.width=`${bounds.width}px`;card.style.minHeight=bounds.height?`${Math.min(bounds.height,bounds.areaHeight)}px`:'';card.style.fontSize=`${layout.fontSize}px`;applyCardAppearance();card.classList.toggle('locked',layout.locked);card.classList.toggle('moving',!!drag?.moved);card.tabIndex=layout.locked?-1:0;
    if(quickOriginalBtn)quickOriginalBtn.setAttribute('aria-pressed',String(layout.showOriginal));
    if(quickLockBtn){quickLockBtn.setAttribute('aria-pressed',String(layout.locked));quickLockBtn.textContent=layout.locked?'已锁定':'锁定';}
    const limit=Math.max(12,Math.floor((bounds.width-28)/layout.fontSize)*3),targets=captionPages(texts,limit),sources=captionPages(layout.showOriginal||!texts?source:'',Math.floor(limit/ .78));
    pageCount=Math.max(targets.length,sources.length);const key=(liveSession?active?.id??'preview':source+'\0'+texts)+'\0'+limit;
    if(key!==pageKey){pageKey=key;pageIndex=0;pageAt=Date.now();}
    if(liveSession&&active&&!active.final&&!reader.paused&&!drag){pageIndex=pageCount-1;pageAt=Date.now();}
    else if(!drag&&(!liveSession||!reader.paused)&&pageCount>1&&Date.now()-pageAt>Math.max(2500,Math.min(6000,limit*90))){pageIndex=(pageIndex+1)%pageCount;pageAt=Date.now();}
    pageIndex=Math.min(pageIndex,pageCount-1);original.textContent=sources[Math.min(sources.length-1,Math.floor(pageIndex*sources.length/pageCount))];translated.textContent=targets[Math.min(targets.length-1,Math.floor(pageIndex*targets.length/pageCount))];
    const chrome=captionChrome(menuOpen,!!liveSession,pageCount);menuOpen=chrome.menu;menuToggle.hidden=!chrome.toggle;menuToggle.setAttribute('aria-expanded',chrome.menu?'true':'false');menu.hidden=!chrome.menu;pager.hidden=!chrome.pager;liveTools.hidden=!chrome.tools;pager.children[1].textContent=`${pageIndex+1} / ${pageCount}`;
    if(liveSession){
      // Only show incoming ASR draft when waiting for the first translation; keep source aligned with the visible translation.
      if(!reader.paused&&layout.showOriginal&&livePreview&&(!active||(!active.text&&!active.final)))original.textContent='识别中：'+captionPages(livePreview,Math.floor(limit/.78)).at(-1);
      const previous=reader.previous;previousLine!.hidden=!previous;previousLine!.textContent=previous?'上一条：'+captionPages(previous.text,limit).at(-1):'';
      holdButton!.textContent=reader.paused?'继续字幕':'暂停字幕滚动';liveHint!.textContent=[active&&!active.final?'生成中':'',reader.paused?'已暂停':reader.pending?`待显示 ${reader.pending}`:''].filter(Boolean).join(' · ');
    }
    const unsupported=full?.tagName==='VIDEO'||document.pictureInPictureElement===video;
    host.hidden=!source||(layout.mode==='video'&&(rect.bottom<0||rect.top>innerHeight||rect.width<40))||unsupported;
    if(unsupported)status.message='原生视频全屏和画中画暂不支持叠加字幕，请使用网页播放器全屏。';
    const positioned=captionBounds(rect,innerWidth,innerHeight,layout,host.getBoundingClientRect().height,!!full);host.style.left=`${positioned.left}px`;host.style.top=`${positioned.top}px`;card.classList.toggle('menu-below',positioned.top<120);
    if(liveSession){for(const cue of reader.dropped.splice(0))if(cue.traceId)void rpc({type:'speech:paint',sessionId:liveSession,traceId:cue.traceId,skipped:true}).catch(()=>{});
      if(active?.traceId&&!painted.has(active.traceId)&&!host.hidden&&!paintScheduled&&document.visibilityState==='visible'){
        paintScheduled=true;const run=generation,cue=active;requestAnimationFrame(()=>requestAnimationFrame(()=>{paintScheduled=false;if(run!==generation||reader.current?.version!==cue.version||host?.hidden||document.visibilityState!=='visible')return;painted.add(cue.traceId!);if(painted.size>100)painted.delete(painted.values().next().value!);void rpc({type:'speech:paint',sessionId:liveSession,traceId:cue.traceId,at:Date.now(),arrivedAt:cue.arrivedAt,sourceEndAt:cue.sourceEndAt}).catch(()=>{});}));
      }
    }
  }
  function nativeCue(cue:TextTrackCue,index:number):SubtitleCue|undefined{
    if(!(cue instanceof VTTCue)||!track)return;
    const text=subtitleText(cue.getCueAsHTML().textContent??'');if(!text)return;
    const previous:string[]=[];for(let i=Math.max(0,index-2);i<index;i++){const c=track.cues?.[i];if(c instanceof VTTCue)previous.push(subtitleText(c.getCueAsHTML().textContent??''));}
    return {id:`track-${index}-${cue.startTime}-${cue.endTime}-${text}`,start:cue.startTime,end:cue.endTime,text,context:previous.join(' ').slice(-800)};
  }
  function add(cue:SubtitleCue){
    if(!entries.has(cue.id))entries.set(cue.id,{cue,state:'pending'});
    // Timeline data stays in the browser track; only a bounded working set retains translations.
    while(entries.size>240){const oldest=entries.keys().next().value!;entries.delete(oldest);}
  }
  function joinSegments(parts:string[]){
    let out='';
    for(const raw of parts){
      if(!raw)continue;
      if(!out)out=raw;
      else if(/[A-Za-z0-9]$/.test(out)&&/^[A-Za-z0-9]/.test(raw))out+=` ${raw}`;
      else out+=raw;
    }
    return subtitleText(out);
  }
  function readYouTubeLines(container:Element|null){
    if(!container)return [];
    const isVisible=(e:Element)=>{const rects=e.getClientRects();return rects.length>0&&getComputedStyle(e).visibility==='visible';};
    const visualLines=[...container.querySelectorAll('.caption-visual-line')].filter(isVisible);
    if(visualLines.length){
      return visualLines.map(line=>joinSegments([...line.querySelectorAll('.ytp-caption-segment')].filter(isVisible).map(e=>e.textContent??''))).filter(Boolean);
    }
    const segments=[...container.querySelectorAll('.ytp-caption-segment')].filter(isVisible);
    if(!segments.length)return [];
    const lines:string[]=[];let group:string[]=[],lastTop=Number.NaN,lastHeight=0;
    for(const seg of segments){
      const rect=seg.getBoundingClientRect(),text=seg.textContent??'';
      if(Number.isFinite(lastTop)&&Math.abs(rect.top-lastTop)>Math.max(8,lastHeight*0.6)){
        const merged=joinSegments(group);if(merged)lines.push(merged);
        group=[text];
      }else group.push(text);
      lastTop=rect.top;lastHeight=rect.height;
    }
    const tail=joinSegments(group);if(tail)lines.push(tail);
    return lines;
  }
  function tick(){
    if(liveSession){render();return;}
    if(!video||status.state!=='active')return;
    if(!video.isConnected||(mediaSource&&video.currentSrc!==mediaSource)||(youtube&&new URL(location.href).searchParams.get('v')!==videoId)){stop('视频已切换，请重新开启字幕翻译。');return;}
    const time=video.currentTime;
    if(Math.abs(time-lastTime)>3){cancel();current=[];if(youtube)ytTracker.update([],Date.now());}lastTime=time;
    if(youtube){
      const container=video.closest('#movie_player');
      const lines=readYouTubeLines(container);
      ytTracker.update(lines,Date.now());
      if(!lines.length&&!lastError)status.message='等待播放器字幕。请在 YouTube 中开启字幕。';
    }else if(track){
      const cues=track.cues;
      if(!cues?.length){status.message='等待字幕轨道加载；若没有字幕，请先在播放器开启字幕。';current=[];render();return;}
      const available:SubtitleCue[]=[],seen=new Set<string>();
      const addCue=(cue:TextTrackCue,index:number)=>{const c=nativeCue(cue,index);if(c&&!seen.has(c.id)){seen.add(c.id);available.push(c);add(c);}};
      const activeSet=new Set(Array.from(track.activeCues??[]));
      const index=cueIndex(cues,time),horizon=time+Math.min(90,30*Math.max(1,video.playbackRate));
      for(let i=Math.max(0,index-1),count=0;i<cues.length&&count<12;i++,count++){const c=cues[i];if(c.startTime>horizon&&!activeSet.has(c))break;if(c.endTime>time||activeSet.has(c)){addCue(c,i);activeSet.delete(c);}}
      for(const c of activeSet){const idx=cueIndex(cues,c.startTime);addCue(c,idx);}
      current=activeSubtitle(available,time);if(!lastError)status.message='按播放进度显示译文，已加载字幕可提前翻译。';
    }
    render();void pump();
  }
  async function pump(){
    if(working||!config||!video||status.state!=='active')return;
    if(youtube){
      const pending=ytTracker.readyToTranslate(Date.now());
      if(!pending.length)return;
      ytTracker.markDispatched();
      working=true;const run=generation,thisTask=task;
      const requestId=crypto.randomUUID();ytStreamRequestId=pending.length===1?requestId:'';ytStreamText='';
      const timeout=setTimeout(()=>{if(run===generation){cancel();ytStreamRequestId='';ytStreamText='';ytTracker.markFailed(pending.map(p=>p.text));lastError=status.message='字幕翻译超时，保留原文。可点击重试。';render();}},15000);
      try{
        const result=await rpc<TranslationResult>({type:'translate',input:{kind:'subtitle',taskId:thisTask,requestId,profileId:config.profileId,target:config.target,
          blocks:pending.map((p,i)=>({id:`yt-${i}`,context:p.context,segments:[{id:`yt-seg-${i}`,text:p.text}]}))}});
        if(run!==generation||status.state!=='active')return;
        ytStreamRequestId='';ytStreamText='';
        const output=new Map(result.segments.map(s=>[s.id,s.text]));
        const resolved:Array<{source:string;translation:string}>=[],failedSources:string[]=[];
        pending.forEach((p,i)=>{const text=output.get(`yt-seg-${i}`);if(text){resolved.push({source:p.text,translation:text});status.completed++;}else failedSources.push(p.text);});
        if(resolved.length)ytTracker.applyTranslations(resolved,Date.now());
        if(failedSources.length)ytTracker.markFailed(failedSources);
        lastError='';status.message='正在翻译播放器显示的字幕。';render();
      }catch(error){if(run===generation){ytStreamRequestId='';ytStreamText='';ytTracker.markFailed(pending.map(p=>p.text));lastError=status.message=(error instanceof Error?error.message:'字幕翻译失败。')+' 可点击重试，原文仍保留。';render();}}
      finally{clearTimeout(timeout);if(run===generation){ytStreamRequestId='';working=false;void pump();}}
      return;
    }
    const now=video.currentTime,horizon=now+Math.min(90,30*Math.max(1,video.playbackRate));
    const selected=[...entries.values()].filter(e=>e.state==='pending'&&e.cue.end>now&&e.cue.start<=horizon).slice(0,6);
    if(!selected.length)return;
    working=true;const run=generation,thisTask=task;selected.forEach(e=>e.state='running');
    const requestId=crypto.randomUUID(),timeout=setTimeout(()=>{if(run===generation){cancel();selected.forEach(e=>e.state='failed');lastError=status.message='字幕翻译超时，保留原文。可点击重试。';render();}},15000);
    try{
      const result=await rpc<TranslationResult>({type:'translate',input:{kind:'subtitle',taskId:thisTask,requestId,profileId:config.profileId,target:config.target,
        blocks:selected.map((e,i)=>({id:`cue-${i}`,context:e.cue.context,segments:[{id:`caption-${i}`,text:e.cue.text}]}))}});
      if(run!==generation||status.state!=='active')return;
      const output=new Map(result.segments.map(s=>[s.id,s.text]));
      selected.forEach((e,i)=>{e.text=output.get(`caption-${i}`);e.state=e.text?'done':'failed';if(e.text)status.completed++;});
      lastError='';status.message='已提前翻译附近字幕。';render();
    }catch(error){if(run===generation){selected.forEach(e=>e.state='failed');lastError=status.message=(error instanceof Error?error.message:'字幕翻译失败。')+' 可点击重试，原文仍保留。';render();}}
    finally{clearTimeout(timeout);if(run===generation){working=false;void pump();}}
  }
  async function start(next:PublicConfig){
    stop();const run=generation;await ensureLayout();if(run!==generation)return;
    status={state:'loading',source:'',completed:0,message:'正在寻找视频字幕…',bilingual:layout.showOriginal};config=next;
    video=findVideo();if(!video){status.state='error';status.message='没有找到当前页面可访问的视频；嵌入其他网站的播放器暂不支持。';return;}
    youtube=(location.hostname==='youtube.com'||location.hostname.endsWith('.youtube.com'))&&!!video.closest('#movie_player');
    const tracks=Array.from(video.textTracks).filter(t=>['subtitles','captions'].includes(t.kind));
    const candidateTrack=tracks.find(t=>t.mode==='showing')??tracks[0];
    // On YouTube, ignore empty/unloaded TextTracks so visible player captions stay active.
    track=youtube&&(!candidateTrack?.cues||candidateTrack.cues.length===0)?undefined:candidateTrack;
    if(!track&&!youtube){video=undefined;status.state='error';status.message=NO_VIDEO_CAPTION_MESSAGE;return;}
    originalMode=track?.mode;if(track){track.mode='hidden';status.source=track.label||track.language||'视频字幕轨道';youtube=false;}else status.source='YouTube 当前字幕';
    mediaSource=video.currentSrc;videoId=new URL(location.href).searchParams.get('v')??'';lastTime=video.currentTime;ytTracker.reset();
    overlay();status.state='active';status.message=youtube?'请在 YouTube 播放器中开启字幕；仅翻译当前显示的内容。':'正在读取字幕…';
    const resync=()=>{cancel();current=[];ytTracker.update([],Date.now());lastTime=video?.currentTime??0;render();tick();};
    listen(video,'seeking',resync);listen(video,'seeked',tick);listen(video,'ratechange',tick);listen(video,'pause',tick);listen(video,'play',tick);
    listen(video,'emptied',()=>stop('视频已更换，请重新开启字幕翻译。'));listen(document,'fullscreenchange',render);
    if(track){listen(track,'cuechange',tick);listen(video.textTracks,'change',()=>{if(video&&Array.from(video.textTracks).some(t=>t!==track&&t.mode==='showing'))stop('字幕语言已切换，请重新开启字幕翻译。');});}
    timer=setInterval(tick,200);tick();
    loadingTimer=setTimeout(()=>{if(status.state==='active'&&!entries.size&&!ytTracker.hasContent)status.message='未读到字幕。请开启播放器字幕，或检查轨道是否加载成功。';},6000);
  }
  chrome.runtime.onMessage.addListener((m,sender,respond)=>{
    if(sender.id!==chrome.runtime.id||!m?.type?.startsWith('video:'))return;
    if(m.type==='video:layout'){layoutEpoch++;if(drag){pendingLayout=m.layout;if(m.layout.locked)finishGesture(true);}else{useLayout(m.layout);render();}respond(true);return;}
    if(m.type==='video:subtitle-progress'){if(!liveSession&&youtube&&m.requestId&&m.requestId===ytStreamRequestId&&typeof m.text==='string'){ytStreamText=m.text;render();}respond(true);return;}
    if(m.type==='video:get-status'){status.bilingual=layout.showOriginal;respond(status);return;}
    if(m.type==='video:player-status'){respond({state:liveSession?'stopped':status.state,message:liveSession?'':status.message});return;}
    if(m.type==='video:live-start'){
      const sessionId=String(m.sessionId??'');stop();liveSession=sessionId;recognitionId=m.recognitionId;liveShownAt=0;video=findVideo();const run=generation;
      void (async()=>{
        await ensureLayout();if(run!==generation||liveSession!==sessionId){respond(true);return;}
        status={state:'active',source:'标签页音频',message:'实时语音字幕已开启。',completed:0,bilingual:layout.showOriginal};overlay();
        youtube=!!video&&(location.hostname==='youtube.com'||location.hostname.endsWith('.youtube.com'))&&!!video.closest('#movie_player');
        mediaSource=video?.currentSrc??'';videoId=new URL(location.href).searchParams.get('v')??'';
        const seekGuard=new LiveSeekGuard();
        const bindVideo=()=>{if(video){
          seekGuard.note(video.currentTime,video.seeking);
          const remember=()=>{if(video)seekGuard.note(video.currentTime,video.seeking);};
          listen(video,'timeupdate',remember);
          listen(video,'seeking',()=>{
            if(!video||!liveSession||ending)return;
            if(seekTimer)clearTimeout(seekTimer);seekTimer=undefined;
            if(seekPaused||!seekGuard.onSeeking(video.duration,video.currentTime))return;
            seekPaused=true;resyncing=true;resetLiveText();void rpc({type:'speech:resync',sessionId,phase:'begin'}).catch(()=>{});
          });
          listen(video,'seeked',()=>{
            if(!resyncing||!liveSession||ending)return;
            if(seekTimer)clearTimeout(seekTimer);
            seekTimer=setTimeout(()=>{seekTimer=undefined;seekPaused=false;if(liveSession===sessionId)void rpc({type:'speech:resync',sessionId,phase:'end'}).catch(()=>{});},200);
          });
          // A refreshed SPA may attach its first media source after document load.
          listen(video,'loadedmetadata',()=>{if(!mediaSource)mediaSource=video?.currentSrc??'';});
          listen(video,'emptied',()=>{if(mediaSource)interrupt('video');});
        }};bindVideo();
        listen(document,'fullscreenchange',render);
        timer=setInterval(()=>{if(ending){render();return;}if(!video){video=findVideo();if(video){mediaSource=video.currentSrc;bindVideo();}}if(liveSession&&video&&(!video.isConnected||videoSourceChanged()))interrupt('video');else{if(video)seekGuard.note(video.currentTime,video.seeking);render();}},250);render();respond(true);
      })().catch(()=>{try{respond(false);}catch{}});
      return true;
    }
    if(m.type==='video:live-caption'){
      if(m.sessionId!==liveSession&&m.sessionId!==endedSession){respond(false);return;}
      if(m.stop){if(typeof m.hint==='string'&&m.hint)adoptHint(m.hint);else stop();respond(true);return;}
      if(ending){respond(true);return;}
      if(m.reset){recognitionId=m.recognitionId;resyncing=true;resetLiveText();respond(true);return;}
      if(m.recognitionId!==recognitionId){respond(false);return;}
      if(m.resumed){if(!seekPaused)resyncing=false;respond(true);return;}
      if(resyncing){respond(true);return;}
      if(m.resetProvisional){for(const cue of [...reader.items])if(!cue.final)reader.withdraw(cue.id,cue.version,Date.now());render();respond(true);return;}
      if(m.preview){livePreview=String(m.source??'').slice(0,2000);render();respond(true);return;}
      if(m.failed){reader.withdraw(String(m.pieceId??'live'),String(m.version??''),Date.now());render();respond(true);return;}
      const cue:SubtitleCue={id:'live',text:String(m.source??'').slice(0,2000),start:0,end:Infinity,context:''};current=[cue];entries.set('live',{cue,state:'done',text:m.preview?'':String(m.translation??'').slice(0,6000)});
      reader.receive({id:String(m.pieceId??'live'),version:String(m.version??''),source:cue.text,text:entries.get('live')?.text??'',final:!m.partial,traceId:m.traceId,sourceEndAt:m.sourceEndAt,arrivedAt:Date.now()},Date.now(),layout.readingMode??'balanced');
      if(!m.partial){liveShownAt=Date.now();status.completed++;}render();respond(true);return;
    }
    if(m.type==='video:stop'){stop();respond(status);return;}
    if(m.type==='video:display'){layoutEpoch++;const showOriginal=m.bilingual!==false;useLayout({...layout,showOriginal});if(pendingLayout)pendingLayout={...pendingLayout,showOriginal};render();respond(status);return;}
    if(m.type==='video:retry'){lastError='';for(const e of entries.values())if(e.state==='failed')e.state='pending';if(youtube)ytTracker.retry(Date.now());tick();respond(status);return;}
    if(m.type==='video:start'){void start(m.config).then(()=>{notifyPlayer();respond(status);},error=>{stop();status.state='error';status.message=error instanceof Error?error.message:'无法开启字幕翻译。';notifyPlayer();respond(status);});return true;}
  });
  // The background owns navigation: a same-page refresh preserves the existing capture.
  window.addEventListener('pagehide',()=>stop());
}
