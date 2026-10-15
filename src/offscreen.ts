import {asrSession,pcm16,type SpeechSettings} from './core/speech';
let stream:MediaStream|undefined,audio:AudioContext|undefined,monitor:AudioContext|undefined,socket:WebSocket|undefined,processor:AudioWorkletNode|undefined;
let sessionId='',generation=0,timer:ReturnType<typeof setInterval>|undefined,connectTimer:ReturnType<typeof setTimeout>|undefined;
let bytes=0,seconds=0,lastSound=0,ready=false,retries=0,settings:SpeechSettings,testing=false;
let connectedAt=0;
const notify=(type:string,data:Record<string,unknown>={})=>chrome.runtime.sendMessage({type,sessionId,...data}).catch(()=>{});
function send(value:unknown){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(value));}
async function cleanup(){generation++;ready=false;if(timer)clearInterval(timer);if(connectTimer)clearTimeout(connectTimer);timer=undefined;connectTimer=undefined;
  if(processor){processor.port.onmessage=null;processor.disconnect();processor=undefined;}
  stream?.getTracks().forEach(t=>t.stop());stream=undefined;
  const old=socket;socket=undefined;if(old){old.onclose=null;old.onerror=null;old.onmessage=null;if(old.readyState===WebSocket.OPEN){old.send(JSON.stringify({type:'session.finish',event_id:crypto.randomUUID()}));}old.close();}
  await audio?.close().catch(()=>{});audio=undefined;await monitor?.close().catch(()=>{});monitor=undefined;
}
async function fail(message:string){void notify('speech:failed',{message});await cleanup();}
function connect(run:number){
  if(run!==generation)return;const url=new URL(settings.endpoint);url.searchParams.set('model',settings.model);
  const ws=new WebSocket(url);socket=ws;ready=false;
  connectTimer=setTimeout(()=>{if(run===generation)void fail('语音服务连接超时，请检查网络、地域、Key 和模型权限。');},12000);
  ws.onopen=()=>{if(run===generation)ws.send(JSON.stringify(asrSession(settings)));};
  ws.onmessage=event=>{
    if(run!==generation||typeof event.data!=='string')return;
    if(event.data.length>64000){void fail('语音服务返回数据过大，已停止。');return;}
    let data:any;try{data=JSON.parse(event.data);}catch{void fail('语音服务返回了无效响应。');return;}
    if(data.type==='session.updated'){if(connectTimer)clearTimeout(connectTimer);connectTimer=undefined;ready=true;connectedAt=Date.now();void notify('speech:ready',{testing});return;}
    if(data.type==='error'){void fail('百炼拒绝了语音请求。请检查 Key 所属地域、余额、模型开通和识别参数。');return;}
    if(data.type==='conversation.item.input_audio_transcription.failed'){void notify('speech:warning',{message:'一段语音识别失败，继续识别后续内容。'});return;}
    const final=data.type==='conversation.item.input_audio_transcription.completed';
    if(final||data.type==='conversation.item.input_audio_transcription.text'){
      const text=final?data.transcript:typeof data.text==='string'?data.text:'';
      if(typeof text==='string')void notify('speech:transcript',{itemId:String(data.item_id??'').slice(0,100),text:text.slice(-2000),preview:final?'':String(data.stash??'').slice(0,2000),final});
    }
  };
  ws.onerror=()=>{};
  ws.onclose=()=>{
    if(run!==generation)return;if(connectTimer)clearTimeout(connectTimer);connectTimer=undefined;
    const wasReady=ready;ready=false;
    if(wasReady&&Date.now()-connectedAt>30000)retries=0;
    if((wasReady||retries>0)&&retries<2&&!testing){retries++;void notify('speech:warning',{reconnecting:true,message:`语音连接中断，正在重连（${retries}/2）；断线期间声音不补传。`});setTimeout(()=>connect(run),retries*1000);}
    else void fail('语音连接失败或已断开。请检查百炼地域、Key、余额或网络，再点击开始。');
  };
}
async function start(m:any){
  await cleanup();sessionId=m.sessionId;settings=m.settings;testing=!!m.testing;bytes=0;seconds=0;lastSound=0;retries=0;const run=generation;
  if(!testing){
    try{stream=await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:m.streamId}} as MediaTrackConstraints,video:false});
      if(run!==generation){stream.getTracks().forEach(t=>t.stop());return;}
      audio=new AudioContext({sampleRate:16000});await audio.resume();
      monitor=new AudioContext();await monitor.resume();monitor.createMediaStreamSource(stream).connect(monitor.destination); // Preserve original playback at the device sample rate.
      const source=audio.createMediaStreamSource(stream);
      await audio.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));if(run!==generation)return;
      processor=new AudioWorkletNode(audio,'si-pcm');const silent=audio.createGain();silent.gain.value=0;source.connect(processor);processor.connect(silent);silent.connect(audio.destination);
      processor.port.onmessage=event=>{if(run!==generation)return;const samples=event.data as Float32Array;seconds+=samples.length/16000;
        if(samples.some(v=>Math.abs(v)>0.002))lastSound=seconds;
        if(!ready||!socket)return;if(socket.bufferedAmount>256000){void fail('网络发送积压超过上限，已停止音频上传。请检查网络后重启。');return;}
        const data=pcm16(samples);let binary='';for(const value of data)binary+=String.fromCharCode(value);send({type:'input_audio_buffer.append',event_id:crypto.randomUUID(),audio:btoa(binary)});bytes+=data.length;
      };
      for(const track of stream.getTracks())track.onended=()=>{if(run===generation)void fail('标签页音频采集已结束，请重新开启。');};
    }catch{await fail('无法采集标签页声音。请重新加载扩展、刷新直播页，播放视频后从工具栏点击开始。');return;}
  }
  if(run!==generation)return;connect(run);
  timer=setInterval(()=>{if(run===generation)void notify('speech:health',{seconds:Math.floor(seconds),sentBytes:bytes,hasAudio:seconds-lastSound<5&&lastSound>0});},1000);
}
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
  if(m?.target!=='speech-offscreen'||sender.id!==chrome.runtime.id)return;
  if(m.action==='stop'){void cleanup().then(()=>respond({ok:true}));return true;}
  if(m.action==='start'){void start(m).then(()=>respond({ok:true}),()=>fail('无法启动音频服务。').then(()=>respond({ok:false})));return true;}
});
