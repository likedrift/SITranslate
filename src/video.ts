import {EMPTY_VIDEO_STATUS,NO_VIDEO_CAPTION_MESSAGE,type PublicConfig,type TranslationResult,type VideoStatus} from './core/types';
import {cueIndex,activeSubtitle,subtitleText,type SubtitleCue} from './core/subtitles';
import {DEFAULT_CAPTION,normalizeCaption,captionBounds,captionPages,clamp,resizeCaptionBox,type CaptionLayout,type CaptionBox,type CaptionCorner} from './core/caption-layout';
import {LiveReader} from './core/live-reader';
import {PAUSE_SCROLL_NOTE,liveInterruptHint} from './core/live-hints';

// Loaded only after an explicit video action; ordinary pages do not load this module.
const scope=globalThis as typeof globalThis&{__siVideoTranslate?:boolean};
if(!scope.__siVideoTranslate){scope.__siVideoTranslate=true;boot();}
function boot(){
  interface Entry {cue:SubtitleCue;state:'pending'|'running'|'done'|'failed';text?:string}
  let status:VideoStatus={...EMPTY_VIDEO_STATUS};
  let video:HTMLVideoElement|undefined,track:TextTrack|undefined,originalMode:TextTrackMode|undefined;
  let config:PublicConfig|undefined,host:HTMLDivElement|undefined,original:HTMLDivElement|undefined,translated:HTMLDivElement|undefined;
  let task='',generation=0,timer:ReturnType<typeof setInterval>|undefined,loadingTimer:ReturnType<typeof setTimeout>|undefined;
  let entries=new Map<string,Entry>(),current:SubtitleCue[]=[],working=false,sequence=0;
  let youtube=false,videoId='',mediaSource='',captionText='',lastTime=0,lastSource='',lastError='';
  let captionChangedAt=0;
  let liveSession='',liveShownAt=0,endedSession='',restartHint='',ending=false,restartTimer:ReturnType<typeof setTimeout>|undefined;
  const reader=new LiveReader();let livePreview='',previousLine:HTMLDivElement|undefined,liveTools:HTMLDivElement|undefined,holdButton:HTMLButtonElement|undefined,liveHint:HTMLSpanElement|undefined;
  const painted=new Set<string>();let paintScheduled=false;
  let layout:CaptionLayout=structuredClone(DEFAULT_CAPTION),layoutEpoch=0,card:HTMLDivElement|undefined,handle:HTMLButtonElement|undefined,pager:HTMLDivElement|undefined;
  let content:HTMLDivElement|undefined,pendingLayout:CaptionLayout|undefined;
  let pageIndex=0,pageKey='',pageAt=0,pageCount=1;
  let drag:{x:number;y:number;pointerId:number;box:CaptionBox;area:CaptionBox;before:CaptionLayout;full:boolean;corner?:CaptionCorner;minHeight:number;moved:boolean}|undefined;
  const disposers:(()=>void)[]=[];
  async function rpc<T=unknown>(value:unknown):Promise<T>{const r=await chrome.runtime.sendMessage(value);if(!r?.ok)throw new Error(r?.error??'扩展连接中断。');return r.data;}
  function cancel(){if(task)void rpc({type:'task:cancel',taskId:task}).catch(()=>{});task=`subtitle-${crypto.randomUUID()}`;generation++;working=false;for(const e of entries.values())if(e.state==='running')e.state='pending';}
  function listen(target:EventTarget,event:string,fn:()=>void){target.addEventListener(event,fn);disposers.push(()=>target.removeEventListener(event,fn));}
  function stop(message='字幕翻译已停止。'){
    liveSession='';endedSession='';restartHint='';ending=false;if(restartTimer)clearTimeout(restartTimer);restartTimer=undefined;
    reader.reset();painted.clear();livePreview='';previousLine=undefined;liveTools=undefined;paintScheduled=false;
    cancel();if(timer)clearInterval(timer);if(loadingTimer)clearTimeout(loadingTimer);timer=undefined;loadingTimer=undefined;
    for(const dispose of disposers.splice(0))dispose();
    if(track&&originalMode&&track.mode==='hidden')track.mode=originalMode;
    host?.remove();host=undefined;original=undefined;translated=undefined;card=undefined;handle=undefined;pager=undefined;content=undefined;drag=undefined;pendingLayout=undefined;pageKey='';video=undefined;track=undefined;entries.clear();current=[];
    lastError='';status={...status,state:'stopped',message};
  }
  function findVideo(){
    const videos=[...document.querySelectorAll('video')].filter(v=>{const r=v.getBoundingClientRect();return r.width>40&&r.height>30;});
    return videos.sort((a,b)=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return y.width*y.height-x.width*x.height;})[0];
  }
  function overlay(){
    host=document.createElement('div');host.dataset.siOwned='video';host.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;';
    const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style');
    for(const type of ['click','keydown','pointerdown'])shadow.addEventListener(type,e=>e.stopPropagation());
    style.textContent=':host{all:initial;pointer-events:none}:host([hidden]){display:none!important}[hidden]{display:none!important}.caption{box-sizing:border-box;font:600 22px/1.45 system-ui,sans-serif;text-align:center;color:#fff;overflow-wrap:anywhere;white-space:pre-line;text-shadow:0 1px 3px #000;padding:8px 14px;border-radius:10px}.source{font-size:.78em;font-weight:400;opacity:.88}.target{margin-top:3px}.target:empty{display:none}button{pointer-events:auto;font:12px system-ui,sans-serif;color:#fff;background:#252a36e8;border:1px solid #ffffff40;border-radius:6px;padding:3px 9px;cursor:pointer}button:focus-visible{outline:2px solid #bdc6ff;outline-offset:2px}.handle{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);cursor:grab;touch-action:none;user-select:none;opacity:.55;white-space:nowrap}.handle:hover,.handle:focus-visible{opacity:1}.pages{font:12px system-ui,sans-serif;margin-top:4px;display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:8px 10px}.note{font-weight:400;opacity:.88}';
    style.textContent+='.caption{position:relative;display:flex;align-items:center;justify-content:center}.content{width:100%;min-width:0}.caption:not(.locked){pointer-events:auto;cursor:grab;touch-action:none;user-select:none}.caption.moving{cursor:grabbing}.resize{position:absolute;width:18px;height:18px;padding:0;border:0;background:transparent;touch-action:none;opacity:.55}.resize:after{content:"";position:absolute;inset:4px;border:solid #dce0ff;border-width:0 2px 2px 0;border-radius:1px}.resize:hover,.resize:focus-visible{opacity:1;background:#ffffff20}.nw{top:0;left:0;cursor:nwse-resize}.ne{top:0;right:0;cursor:nesw-resize}.sw{bottom:0;left:0;cursor:nesw-resize}.se{bottom:0;right:0;cursor:nwse-resize}.nw:after{transform:rotate(180deg)}.ne:after{transform:rotate(270deg)}.sw:after{transform:rotate(90deg)}.locked .resize{display:none}';
    card=document.createElement('div');card.className='caption';original=document.createElement('div');original.className='source';translated=document.createElement('div');translated.className='target';
    previousLine=document.createElement('div');previousLine.style.cssText='font-size:.78em;font-weight:400;opacity:.72;margin-bottom:6px';previousLine.hidden=true;
    liveTools=document.createElement('div');liveTools.className='pages';liveTools.hidden=true;
    const back=document.createElement('button'),forward=document.createElement('button'),latestButton=document.createElement('button');holdButton=document.createElement('button');liveHint=document.createElement('span');
    back.textContent='‹';back.setAttribute('aria-label','上一条译文');back.onclick=()=>{reader.back(Date.now());pageKey='';render();};forward.textContent='›';forward.setAttribute('aria-label','下一条译文');forward.onclick=()=>{reader.forward(Date.now());pageKey='';render();};
    holdButton.onclick=()=>{reader.paused=!reader.paused;render();};const pauseNote=document.createElement('span');pauseNote.className='note';pauseNote.textContent=PAUSE_SCROLL_NOTE;latestButton.textContent='回到最新';latestButton.onclick=()=>{reader.latest(Date.now());pageKey='';render();};liveTools.append(back,holdButton,pauseNote,forward,latestButton,liveHint);
    handle=document.createElement('button');handle.className='handle';handle.textContent='⠿ 拖动字幕';handle.setAttribute('aria-label','拖动字幕位置，方向键可移动');
    pager=document.createElement('div');pager.className='pages';
    const previous=document.createElement('button'),next=document.createElement('button'),count=document.createElement('span');previous.textContent='‹';next.textContent='›';previous.setAttribute('aria-label','上一页字幕');next.setAttribute('aria-label','下一页字幕');
    const turn=(delta:number)=>{pageIndex=(pageIndex+delta+pageCount)%pageCount;pageAt=Date.now();render();};previous.onclick=()=>turn(-1);next.onclick=()=>turn(1);pager.append(previous,count,next);
    handle.onpointerdown=e=>beginGesture(e);
    card.onpointerdown=e=>{if(!(e.target instanceof Element)||e.target.closest('button,a,input,select,textarea'))return;beginGesture(e);};
    card.onpointermove=e=>moveGesture(e);card.onpointerup=e=>{if(e.pointerId===drag?.pointerId)finishGesture();};card.onpointercancel=e=>{if(e.pointerId===drag?.pointerId)finishGesture(true);};
    card.onlostpointercapture=()=>finishGesture(true);
    const escapeGesture=(e:KeyboardEvent)=>{if(e.key==='Escape'&&drag){e.preventDefault();e.stopPropagation();finishGesture(true);}};
    window.addEventListener('keydown',escapeGesture,true);disposers.push(()=>window.removeEventListener('keydown',escapeGesture,true));
    handle.onkeydown=e=>{const moves:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(!moves[e.key]||layout.locked)return;e.preventDefault();e.stopPropagation();const full=!!document.fullscreenElement,key=full?'fullscreen':'normal',p=layout[key]??{x:.5,y:.85},d=e.shiftKey ? .08 : .02;layout[key]={x:clamp(p.x+moves[e.key][0]*d,0,1),y:clamp(p.y+moves[e.key][1]*d,0,1)};render();savePosition(full);};
    content=document.createElement('div');content.className='content';content.append(previousLine,original,translated,pager,liveTools);card.append(content);
    for(const [corner,label] of [['nw','左上角'],['ne','右上角'],['sw','左下角'],['se','右下角']] as const){
      const grip=document.createElement('button');grip.className='resize '+corner;grip.setAttribute('aria-label',label+'缩放字幕');grip.title=label+'缩放字幕（方向键微调）';grip.onpointerdown=e=>beginGesture(e,corner);
      grip.onkeydown=e=>{const moves:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(!moves[e.key]||layout.locked)return;e.preventDefault();e.stopPropagation();beginGesture(new PointerEvent('pointerdown',{button:0,pointerId:-1,clientX:0,clientY:0}),corner);if(drag){const step=e.shiftKey?24:8;moveGesture(new PointerEvent('pointermove',{pointerId:-1,clientX:moves[e.key][0]*step,clientY:moves[e.key][1]*step}));finishGesture();}};
      card.append(grip);
    }
    shadow.append(style,handle,card);document.documentElement.append(host);
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
    const b=d.corner?resizeCaptionBox(d.box,d.area,d.corner,dx,dy,240,d.minHeight):{...d.box,left:clamp(d.box.left+dx,d.area.left,d.area.left+Math.max(0,d.area.width-d.box.width)),top:clamp(d.box.top+dy,d.area.top,d.area.top+Math.max(0,d.area.height-d.box.height))};
    const key=d.full?'fullscreen':'normal';layout[key]={x:clamp((b.left-d.area.left)/Math.max(1,d.area.width-b.width),0,1),y:clamp((b.top-d.area.top)/Math.max(1,d.area.height-b.height),0,1)};
    if(d.corner)layout[d.full?'fullscreenSize':'normalSize']={width:clamp(b.width/d.area.width,.001,1),height:clamp(b.height/d.area.height,.001,1)};
    render();
  }
  function finishGesture(cancelled=false){
    if(!drag)return;const d=drag;drag=undefined;
    if(card?.hasPointerCapture(d.pointerId))card.releasePointerCapture(d.pointerId);
    if(cancelled)layout=d.before;
    const key=d.full?'fullscreen':'normal',position=layout[key],size=layout[d.full?'fullscreenSize':'normalSize'];
    if(pendingLayout){layout=pendingLayout;pendingLayout=undefined;}status.bilingual=layout.showOriginal;render();
    if(cancelled||!d.moved)return;
    const run=generation,epoch=layoutEpoch;void rpc<CaptionLayout>({type:'caption:geometry',context:key,position,size}).then(s=>{if(run===generation&&epoch===layoutEpoch&&!drag){useLayout(s);render();}}).catch(()=>{});
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
    const bounds=captionBounds(rect,innerWidth,innerHeight,layout,0,!!full);host.style.width=`${bounds.width}px`;card.style.fontSize=`${layout.fontSize}px`;card.style.background=`rgba(21,25,35,${layout.opacity})`;
    const positioned=captionBounds(rect,innerWidth,innerHeight,layout,host.getBoundingClientRect().height,!!full);host.style.left=`${positioned.left}px`;host.style.top=`${positioned.top}px`;
  }
  function paintRestartHint(){
    if(!host||!translated)return;
    host.hidden=false;if(original)original.textContent='';translated.textContent=restartHint;translated.setAttribute('aria-live','polite');
    if(previousLine)previousLine.hidden=true;if(pager)pager.hidden=true;if(liveTools)liveTools.hidden=true;placeHost();
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
  function render(){
    status.bilingual=layout.showOriginal;
    if(restartHint&&host&&translated){paintRestartHint();return;}
    if(translated)translated.removeAttribute('aria-live');
    if(!host||!original||!translated||!card||!handle||!pager||(!video&&!liveSession))return;
    const full=document.fullscreenElement,parent=full&&video&&full.contains(video)&&full.tagName!=='VIDEO'?full:document.documentElement;
    if(host.parentElement!==parent)parent.append(host);
    if(liveSession)reader.tick(Date.now(),layout.readingMode??'balanced');
    const active=reader.current,rect=video?.getBoundingClientRect()??new DOMRect(0,0,innerWidth,innerHeight),source=liveSession?(active?.source??livePreview):current.map(c=>c.text).join('\n');
    const texts=liveSession?(active?.text??''):current.map(c=>entries.get(c.id)?.text??'').filter(Boolean).join('\n');
    if(drag&&drag.full!==!!full)finishGesture(true);
    const bounds=captionBounds(rect,innerWidth,innerHeight,layout,0,!!full);host.style.width=`${bounds.width}px`;card.style.minHeight=bounds.height?`${Math.min(bounds.height,bounds.areaHeight)}px`:'';card.style.fontSize=`${layout.fontSize}px`;card.style.background=`rgba(21,25,35,${layout.opacity})`;card.classList.toggle('locked',layout.locked);card.classList.toggle('moving',!!drag?.moved);handle.hidden=layout.locked;
    const limit=Math.max(12,Math.floor((bounds.width-28)/layout.fontSize)*2),targets=captionPages(texts,limit),sources=captionPages(layout.showOriginal||!texts?source:'',Math.floor(limit/ .78));
    pageCount=Math.max(targets.length,sources.length);const key=(liveSession?active?.id??'preview':source+'\0'+texts)+'\0'+limit;
    if(key!==pageKey){pageKey=key;pageIndex=0;pageAt=Date.now();}
    if(!drag&&(!liveSession||!reader.paused)&&pageCount>1&&Date.now()-pageAt>Math.max(2500,Math.min(6000,limit*90))){pageIndex=(pageIndex+1)%pageCount;pageAt=Date.now();}
    pageIndex=Math.min(pageIndex,pageCount-1);original.textContent=sources[Math.min(sources.length-1,Math.floor(pageIndex*sources.length/pageCount))];translated.textContent=targets[Math.min(targets.length-1,Math.floor(pageIndex*targets.length/pageCount))];
    pager.hidden=pageCount<=1;pager.children[1].textContent=`${pageIndex+1} / ${pageCount}`;
    if(liveSession){
      if(!reader.paused&&layout.showOriginal&&livePreview&&livePreview!==source)original.textContent='识别中：'+captionPages(livePreview,Math.floor(limit/.78)).at(-1);
      const previous=reader.previous;previousLine!.hidden=!previous;previousLine!.textContent=previous?'上一条：'+captionPages(previous.text,limit).at(-1):'';
      liveTools!.hidden=false;holdButton!.textContent=reader.paused?'继续字幕':'暂停字幕滚动';liveHint!.textContent=[active&&!active.final?'生成中':'',reader.paused?'已暂停':reader.pending?`待显示 ${reader.pending}`:''].filter(Boolean).join(' · ');
    }
    const unsupported=full?.tagName==='VIDEO'||document.pictureInPictureElement===video;
    host.hidden=!source||(layout.mode==='video'&&(rect.bottom<0||rect.top>innerHeight||rect.width<40))||unsupported;
    if(unsupported)status.message='原生视频全屏和画中画暂不支持叠加字幕，请使用网页播放器全屏。';
    const positioned=captionBounds(rect,innerWidth,innerHeight,layout,host.getBoundingClientRect().height,!!full);host.style.left=`${positioned.left}px`;host.style.top=`${positioned.top}px`;
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
  function tick(){
    if(liveSession){render();return;}
    if(!video||status.state!=='active')return;
    if(!video.isConnected||(mediaSource&&video.currentSrc!==mediaSource)||(youtube&&new URL(location.href).searchParams.get('v')!==videoId)){stop('视频已切换，请重新开启字幕翻译。');return;}
    const time=video.currentTime;
    if(Math.abs(time-lastTime)>3){cancel();captionText='';current=[];}lastTime=time;
    if(youtube){
      const container=video.closest('#movie_player');
      const text=subtitleText([...container?.querySelectorAll('.ytp-caption-segment')??[]].filter(e=>e.getClientRects().length>0&&getComputedStyle(e).visibility==='visible').map(e=>e.textContent??'').join(' '));
      if(text&&text!==captionText){
        const cue:SubtitleCue={id:`youtube-${++sequence}`,start:time,end:time+10,text,context:lastSource.slice(-800)};
        current=[cue];add(cue);lastSource=text;captionChangedAt=Date.now();
      }else if(!text)current=[];
      else if(current[0])current[0].end=time+3;
      captionText=text;
      if(!text&&!lastError)status.message='等待播放器字幕。请在 YouTube 中开启字幕。';
    }else if(track){
      const cues=track.cues;
      if(!cues?.length){status.message='等待字幕轨道加载；若没有字幕，请先在播放器开启字幕。';current=[];render();return;}
      const available:SubtitleCue[]=[],seen=new Set<string>();
      const addCue=(cue:TextTrackCue,index:number)=>{const c=nativeCue(cue,index);if(c&&!seen.has(c.id)){seen.add(c.id);available.push(c);add(c);}};
      for(const c of [...Array.from(track.activeCues??[])]){const index=cueIndex(cues,c.startTime);addCue(c,index);}
      const index=cueIndex(cues,time),horizon=time+Math.min(90,30*Math.max(1,video.playbackRate));
      for(let i=Math.max(0,index-1),count=0;i<cues.length&&count<12;i++,count++){const c=cues[i];if(c.startTime>horizon)break;if(c.endTime>time)addCue(c,i);}
      current=activeSubtitle(available,time);if(!lastError)status.message='按播放进度显示译文，已加载字幕可提前翻译。';
    }
    render();void pump();
  }
  async function pump(){
    if(working||!config||!video||status.state!=='active')return;
    if(youtube&&Date.now()-captionChangedAt<350)return;
    const now=video.currentTime,horizon=now+Math.min(90,30*Math.max(1,video.playbackRate));
    const selected=[...entries.values()].filter(e=>e.state==='pending'&&e.cue.end>now&&e.cue.start<=horizon&&(!youtube||current.some(c=>c.id===e.cue.id))).slice(0,6);
    if(!selected.length)return;
    working=true;const run=generation,thisTask=task;selected.forEach(e=>e.state='running');
    const requestId=crypto.randomUUID(),timeout=setTimeout(()=>{if(run===generation){cancel();selected.forEach(e=>e.state='failed');lastError=status.message='字幕翻译超时，保留原文。可点击重试。';render();}},15000);
    try{
      const result=await rpc<TranslationResult>({type:'translate',input:{kind:'subtitle',taskId:thisTask,requestId,profileId:config.profileId,target:config.target,
        blocks:selected.map((e,i)=>({id:`cue-${i}`,context:e.cue.context,segments:[{id:`caption-${i}`,text:e.cue.text}]}))}});
      if(run!==generation||status.state!=='active')return;
      const output=new Map(result.segments.map(s=>[s.id,s.text]));
      selected.forEach((e,i)=>{e.text=output.get(`caption-${i}`);e.state=e.text?'done':'failed';if(e.text)status.completed++;});
      lastError='';status.message=youtube?'正在翻译播放器显示的字幕。':'已提前翻译附近字幕。';render();
    }catch(error){if(run===generation){selected.forEach(e=>e.state='failed');lastError=status.message=(error instanceof Error?error.message:'字幕翻译失败。')+' 可点击重试，原文仍保留。';render();}}
    finally{clearTimeout(timeout);if(run===generation){working=false;void pump();}}
  }
  async function start(next:PublicConfig){
    stop();const run=generation;await ensureLayout();if(run!==generation)return;
    status={state:'loading',source:'',completed:0,message:'正在寻找视频字幕…',bilingual:layout.showOriginal};config=next;
    video=findVideo();if(!video){status.state='error';status.message='没有找到当前页面可访问的视频；嵌入其他网站的播放器暂不支持。';return;}
    youtube=(location.hostname==='youtube.com'||location.hostname.endsWith('.youtube.com'))&&!!video.closest('#movie_player');
    const tracks=Array.from(video.textTracks).filter(t=>['subtitles','captions'].includes(t.kind));
    track=tracks.find(t=>t.mode==='showing')??tracks[0];
    if(!track&&!youtube){video=undefined;status.state='error';status.message=NO_VIDEO_CAPTION_MESSAGE;return;}
    originalMode=track?.mode;if(track){track.mode='hidden';status.source=track.label||track.language||'视频字幕轨道';youtube=false;}else status.source='YouTube 当前字幕';
    mediaSource=video.currentSrc;videoId=new URL(location.href).searchParams.get('v')??'';captionText='';lastSource='';lastTime=video.currentTime;
    overlay();status.state='active';status.message=youtube?'请在 YouTube 播放器中开启字幕；仅翻译当前显示的内容。':'正在读取字幕…';
    const resync=()=>{cancel();current=[];captionText='';lastSource='';lastTime=video?.currentTime??0;render();tick();};
    listen(video,'seeking',resync);listen(video,'seeked',tick);listen(video,'ratechange',tick);listen(video,'pause',tick);listen(video,'play',tick);
    listen(video,'emptied',()=>stop('视频已更换，请重新开启字幕翻译。'));listen(document,'fullscreenchange',render);
    if(track){listen(track,'cuechange',tick);listen(video.textTracks,'change',()=>{if(video&&Array.from(video.textTracks).some(t=>t!==track&&t.mode==='showing'))stop('字幕语言已切换，请重新开启字幕翻译。');});}
    timer=setInterval(tick,200);tick();
    loadingTimer=setTimeout(()=>{if(status.state==='active'&&!entries.size)status.message='未读到字幕。请开启播放器字幕，或检查轨道是否加载成功。';},6000);
  }
  chrome.runtime.onMessage.addListener((m,sender,respond)=>{
    if(sender.id!==chrome.runtime.id||!m?.type?.startsWith('video:'))return;
    if(m.type==='video:layout'){layoutEpoch++;if(drag){pendingLayout=m.layout;if(m.layout.locked)finishGesture(true);}else{useLayout(m.layout);render();}respond(true);return;}
    if(m.type==='video:get-status'){status.bilingual=layout.showOriginal;respond(status);return;}
    if(m.type==='video:live-start'){
      const sessionId=String(m.sessionId??'');stop();liveSession=sessionId;liveShownAt=0;video=findVideo();const run=generation;
      void (async()=>{
        await ensureLayout();if(run!==generation||liveSession!==sessionId){respond(true);return;}
        status={state:'active',source:'标签页音频',message:'实时语音字幕已开启。',completed:0,bilingual:layout.showOriginal};overlay();
        youtube=!!video&&(location.hostname==='youtube.com'||location.hostname.endsWith('.youtube.com'))&&!!video.closest('#movie_player');
        mediaSource=video?.currentSrc??'';videoId=new URL(location.href).searchParams.get('v')??'';
        if(video){listen(video,'seeking',()=>interrupt('seek'));listen(video,'emptied',()=>interrupt('video'));}listen(document,'fullscreenchange',render);
        timer=setInterval(()=>{if(ending){render();return;}if(liveSession&&video&&(!video.isConnected||videoSourceChanged()))interrupt('video');else render();},250);render();respond(true);
      })().catch(()=>{try{respond(false);}catch{}});
      return true;
    }
    if(m.type==='video:live-caption'){
      if(m.sessionId!==liveSession&&m.sessionId!==endedSession){respond(false);return;}
      if(m.stop){if(typeof m.hint==='string'&&m.hint)adoptHint(m.hint);else stop();respond(true);return;}
      if(ending){respond(true);return;}
      if(m.resetProvisional){for(const cue of [...reader.items])if(!cue.final)reader.withdraw(cue.id,cue.version,Date.now());render();respond(true);return;}
      if(m.preview){livePreview=String(m.source??'').slice(0,2000);render();respond(true);return;}
      if(m.failed){reader.withdraw(String(m.pieceId??'live'),String(m.version??''),Date.now());render();respond(true);return;}
      const cue:SubtitleCue={id:'live',text:String(m.source??'').slice(0,2000),start:0,end:Infinity,context:''};current=[cue];entries.set('live',{cue,state:'done',text:m.preview?'':String(m.translation??'').slice(0,6000)});
      reader.receive({id:String(m.pieceId??'live'),version:String(m.version??''),source:cue.text,text:entries.get('live')?.text??'',final:!m.partial,traceId:m.traceId,sourceEndAt:m.sourceEndAt,arrivedAt:Date.now()},Date.now(),layout.readingMode??'balanced');
      if(!m.partial){liveShownAt=Date.now();status.completed++;}render();respond(true);return;
    }
    if(m.type==='video:stop'){stop();respond(status);return;}
    if(m.type==='video:display'){layoutEpoch++;const showOriginal=m.bilingual!==false;useLayout({...layout,showOriginal});if(pendingLayout)pendingLayout={...pendingLayout,showOriginal};render();respond(status);return;}
    if(m.type==='video:retry'){lastError='';for(const e of entries.values())if(e.state==='failed')e.state='pending';tick();respond(status);return;}
    if(m.type==='video:start'){void start(m.config).then(()=>respond(status),error=>{stop();status.state='error';status.message=error instanceof Error?error.message:'无法开启字幕翻译。';respond(status);});return true;}
  });
  window.addEventListener('pagehide',()=>{if(liveSession)void rpc({type:'speech:stop',sessionId:liveSession,cause:'leave'}).catch(()=>{});stop();});
}
