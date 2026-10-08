import {EMPTY_VIDEO_STATUS,type PublicConfig,type TranslationResult,type VideoStatus} from './core/types';
import {cueIndex,activeSubtitle,subtitleText,type SubtitleCue} from './core/subtitles';

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
  const disposers:(()=>void)[]=[];
  async function rpc<T=unknown>(value:unknown):Promise<T>{const r=await chrome.runtime.sendMessage(value);if(!r?.ok)throw new Error(r?.error??'扩展连接中断。');return r.data;}
  function cancel(){if(task)void rpc({type:'task:cancel',taskId:task}).catch(()=>{});task=`subtitle-${crypto.randomUUID()}`;generation++;working=false;for(const e of entries.values())if(e.state==='running')e.state='pending';}
  function listen(target:EventTarget,event:string,fn:()=>void){target.addEventListener(event,fn);disposers.push(()=>target.removeEventListener(event,fn));}
  function stop(message='字幕翻译已停止。'){
    cancel();if(timer)clearInterval(timer);if(loadingTimer)clearTimeout(loadingTimer);timer=undefined;loadingTimer=undefined;
    for(const dispose of disposers.splice(0))dispose();
    if(track&&originalMode&&track.mode==='hidden')track.mode=originalMode;
    host?.remove();host=undefined;original=undefined;translated=undefined;video=undefined;track=undefined;entries.clear();current=[];
    lastError='';status={...status,state:'stopped',message};
  }
  function findVideo(){
    const videos=[...document.querySelectorAll('video')].filter(v=>{const r=v.getBoundingClientRect();return r.width>40&&r.height>30;});
    return videos.sort((a,b)=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return y.width*y.height-x.width*x.height;})[0];
  }
  function overlay(){
    host=document.createElement('div');host.dataset.siOwned='video';host.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;';
    const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style');
    style.textContent=':host{all:initial;pointer-events:none}:host([hidden]){display:none!important}.caption{font:600 clamp(15px,2vw,24px)/1.45 system-ui,sans-serif;text-align:center;color:#fff;overflow-wrap:anywhere;white-space:pre-line;text-shadow:0 1px 3px #000;padding:6px 14px;background:#151923db;border-radius:10px;max-height:150px;overflow:hidden}.source{font-size:.78em;font-weight:400;opacity:.88}.target{margin-top:3px}.target:empty{display:none}';
    const card=document.createElement('div');card.className='caption';original=document.createElement('div');original.className='source';translated=document.createElement('div');translated.className='target';
    card.append(original,translated);shadow.append(style,card);document.documentElement.append(host);
  }
  function render(){
    if(!video||!host||!original||!translated)return;
    const full=document.fullscreenElement,parent=full&&full.contains(video)&&full.tagName!=='VIDEO'?full:document.documentElement;
    if(host.parentElement!==parent)parent.append(host);
    const rect=video.getBoundingClientRect(),source=current.map(c=>c.text).join('\n');
    const texts=current.map(c=>entries.get(c.id)?.text??'').filter(Boolean).join('\n');
    // Source remains readable while translation is in progress or has failed.
    original.textContent=status.bilingual||!texts?source:'';translated.textContent=texts;
    const unsupported=full?.tagName==='VIDEO'||document.pictureInPictureElement===video;
    host.hidden=!source||rect.bottom<0||rect.top>innerHeight||rect.width<40||unsupported;
    if(unsupported)status.message='原生视频全屏和画中画暂不支持叠加字幕，请使用网页播放器全屏。';
    host.style.left=`${Math.max(8,rect.left+rect.width*.08)}px`;host.style.width=`${Math.min(innerWidth-16,rect.width*.84)}px`;
    host.style.top=`${Math.max(8,rect.bottom-Math.max(60,rect.height*.12)-host.getBoundingClientRect().height)}px`;
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
  async function start(next:PublicConfig,bilingual:boolean){
    stop();status={state:'loading',source:'',completed:0,message:'正在寻找视频字幕…',bilingual};config=next;
    video=findVideo();if(!video){status.state='error';status.message='没有找到当前页面可访问的视频；嵌入其他网站的播放器暂不支持。';return;}
    youtube=(location.hostname==='youtube.com'||location.hostname.endsWith('.youtube.com'))&&!!video.closest('#movie_player');
    const tracks=Array.from(video.textTracks).filter(t=>['subtitles','captions'].includes(t.kind));
    track=tracks.find(t=>t.mode==='showing')??tracks[0];
    if(!track&&!youtube){video=undefined;status.state='error';status.message='这个视频没有可读取的字幕。语音识别将在后续版本提供。';return;}
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
    if(m.type==='video:get-status'){respond(status);return;}
    if(m.type==='video:stop'){stop();respond(status);return;}
    if(m.type==='video:display'){status.bilingual=m.bilingual!==false;render();respond(status);return;}
    if(m.type==='video:retry'){lastError='';for(const e of entries.values())if(e.state==='failed')e.state='pending';tick();respond(status);return;}
    if(m.type==='video:start'){void start(m.config,m.bilingual!==false).then(()=>respond(status),error=>{stop();status.state='error';status.message=error instanceof Error?error.message:'无法开启字幕翻译。';respond(status);});return true;}
  });
  window.addEventListener('pagehide',()=>stop());
}
