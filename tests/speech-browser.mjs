import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdir,cp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {mockASR} from './fixtures/mock-asr.mjs';
const results=[],requests=[],streamTimings=[];let translationDelay=0;
const translatedText=text=>text==='皆さん、こんにちは。'?'大家好。':text==='閲読一。'?'第一句字幕需要保留足够的时间才能看完。':text==='閲読二。'?'第二句字幕已经到达，前一句也应该可以回看。':text==='検証失敗。'?'需要撤回的临时译文':text.startsWith('検証')?'译：'+text:'这是直播中文字幕。';
const server=http.createServer(async(req,res)=>{
  if(req.url==='/v1/chat/completions'){
    let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw),blocks=JSON.parse(input.messages[1].content).blocks;requests.push(blocks);if(translationDelay)await new Promise(r=>setTimeout(r,translationDelay));const segments=blocks.flatMap(b=>b.segments.map(s=>({id:s.id,text:translatedText(s.text)})));
    if(input.stream){const timing={startedAt:Date.now(),firstAt:0,doneAt:0,cancelled:false};streamTimings.push(timing);res.on('close',()=>{if(!timing.doneAt)timing.cancelled=true;});res.setHeader('Content-Type','text/event-stream');const emit=value=>{if(!res.destroyed)res.write('data: '+JSON.stringify(value)+'\n\n');};const send=content=>emit({choices:[{delta:{content},finish_reason:null}]});
      emit({choices:[{delta:{reasoning_content:'must-not-show-reasoning'},finish_reason:null}]});await new Promise(r=>setTimeout(r,150));timing.firstAt=Date.now();send('{"segments":[{"id":"live","text":"'+segments[0].text.slice(0,2));
      await new Promise(r=>setTimeout(r,180));send(segments[0].text.slice(2,3));await new Promise(r=>setTimeout(r,20));send(segments[0].text.slice(3)+'"}]}');await new Promise(r=>setTimeout(r,700));
      emit({choices:[{delta:{},finish_reason:blocks[0].segments[0].text==='検証失敗。'?'content_filter':'stop'}],usage:{prompt_tokens:10,completion_tokens:10}});timing.doneAt=Date.now();if(!res.destroyed)res.end('data: [DONE]\n\n');return;
    }
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({segments})}}],usage:{prompt_tokens:10,completion_tokens:10}}));return;
  }
  // Keep the capture clock running with digital silence. No oscillator or audible test source.
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Silent capture fixture</h1><video style="width:720px;height:405px;background:#202438"></video><button id="silent-audio">Start silent fixture</button><script>document.querySelector("#silent-audio").onclick=async()=>{window.audio=new AudioContext();const source=audio.createConstantSource();source.offset.value=0;source.connect(audio.destination);source.start();await audio.resume();};</script></body></html>');
});
const mock=mockASR(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,ws=origin.replace('http:','ws:')+'/api-ws/v1/realtime';
await mkdir('artifacts',{recursive:true});const extension=path.resolve('artifacts/speech-extension');await cp('dist',extension,{recursive:true});
const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),der=publicKey.export({type:'spki',format:'der'}),id=createHash('sha256').update(der).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.key=der.toString('base64');await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
// Chromium allowlist supplies the toolbar invocation grant in this isolated automated profile only.
// Mute this isolated browser, including the offscreen playback monitor. Never unmute for a test.
const context=await chromium.launchPersistentContext(path.resolve('artifacts',`speech-profile-${Date.now()}`),{channel:'chromium',headless:true,args:['--mute-audio',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--allowlisted-extension-id=${id}`,'--autoplay-policy=no-user-gesture-required']});
const errors=[];context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
let worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');assert.equal(new URL(worker.url()).host,id);
const ui=await context.newPage();await ui.goto(`chrome-extension://${id}/options.html`);const page=await context.newPage();await page.goto(origin);await page.locator('#silent-audio').click();const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({url:url+'/*'}))[0].id,origin);
const rpc=(type,extra={})=>ui.evaluate(async({type,extra})=>{const r=await chrome.runtime.sendMessage({type,...extra});if(!r?.ok)throw new Error(r?.error??'No response');return r.data;},{type,extra});
const activate=()=>worker.evaluate(id=>chrome.tabs.update(id,{active:true}),tabId);
async function until(fn,timeout=18000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Condition timed out: '+JSON.stringify(await rpc('speech:status')));}
async function step(name,fn){await fn();results.push({name,passed:true});console.log('PASS '+name);}
async function captionTexts(){const cdp=await context.newCDPSession(page);try{return (await cdp.send('Accessibility.getFullAXTree')).nodes.filter(n=>n.role?.value==='StaticText').map(n=>n.name?.value??'');}finally{await cdp.detach();}}
async function captionClick(name){const cdp=await context.newCDPSession(page);try{const node=(await cdp.send('Accessibility.getFullAXTree')).nodes.find(n=>n.role?.value==='button'&&n.name?.value===name);assert.ok(node,'Missing caption control: '+name);const {model}=await cdp.send('DOM.getBoxModel',{backendNodeId:node.backendDOMNodeId});await page.mouse.click((model.content[0]+model.content[2])/2,(model.content[1]+model.content[5])/2);}finally{await cdp.detach();}}
try{
  await step('Offline AudioWorklet resamples and mixes nonzero stereo into 100 ms mono frames without any audio device',async()=>{
    const result=await ui.evaluate(async()=>{
      // OfflineAudioContext never opens a speaker. Exercise the built production worklet.
      const offline=new OfflineAudioContext(1,3200,16000);await offline.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));
      const source=offline.createBufferSource(),buffer=offline.createBuffer(2,9600,48000);buffer.getChannelData(0).fill(.25);buffer.getChannelData(1).fill(.75);source.buffer=buffer;
      const processor=new AudioWorkletNode(offline,'si-pcm'),frames=[];
      let deadline;const received=new Promise((resolve,reject)=>{deadline=setTimeout(()=>reject(new Error('Offline worklet did not produce two frames')),5000);processor.port.onmessage=e=>{frames.push(e.data);if(frames.length===2)resolve();};});
      try{source.connect(processor);processor.connect(offline.destination);source.start();const rendered=await offline.startRendering();await received;return {lengths:frames.map(f=>f.length),nonzero:frames.every(f=>f.some(v=>v>.4)),mixed:frames[0][800],silent:rendered.getChannelData(0).every(v=>v===0)};}
      finally{clearTimeout(deadline);processor.port.onmessage=null;processor.disconnect();source.disconnect();}
    });
    assert.deepEqual(result.lengths,[1600,1600]);assert.ok(result.nonzero);assert.ok(Math.abs(result.mixed-.5)<.001);assert.ok(result.silent);
  });
  await step('Configure independent speech settings via UI without starting capture',async()=>{
    await ui.locator('#speech-key').fill('test-speech-key');await ui.locator('#speech-endpoint').fill(ws);await ui.locator('#speech-language').selectOption('ja');await ui.locator('#speech-save').click();await until(async()=>await ui.locator('#speech-feedback').textContent()==='语音配置已保存。');
    const s=await rpc('settings:get');s.profiles[0]={...s.profiles[0],type:'compatible',baseUrl:origin+'/v1',apiKey:'test-text-key',model:'mock',stream:false};await rpc('settings:save',{settings:s});
    assert.equal(mock.stats.authorized,0);assert.equal((await rpc('speech:status')).state,'idle');
  });
  await step('Connection test verifies websocket authentication and Japanese session without recording audio',async()=>{
    await rpc('speech:test');await until(async()=> {const s=await rpc('speech:status');if(s.state==='error')throw new Error(s.message);return s.state==='stopped';});assert.match((await rpc('speech:status')).message,/连接成功/);assert.equal(mock.stats.config.input_audio_transcription.language,'ja');assert.equal(mock.stats.config.turn_detection.silence_duration_ms,600);assert.equal(mock.stats.frames,0);
    assert.equal((await worker.evaluate(()=>chrome.declarativeNetRequest.getSessionRules())).length,0);
  });
  await step('Advanced VAD silence tiers are stored and sent on the next realtime session',async()=>{
    await ui.locator('#speech-advanced > summary').click();
    await until(async()=>await ui.locator('#speech-vad').isVisible());
    const help=await ui.locator('#speech-vad-help').textContent()??'';
    assert.match(help,/更短更灵敏，句子更碎/);assert.match(help,/更长更稳，延迟更高/);
    for(const ms of ['400','800','600']){
      await ui.locator('#speech-vad').selectOption(ms);
      await ui.locator('#speech-save').click();
      await until(async()=>await ui.locator('#speech-feedback').textContent()==='语音配置已保存。');
      assert.equal((await rpc('speech:settings-get')).silenceDurationMs,Number(ms));
      await rpc('speech:test');
      await until(async()=>{const s=await rpc('speech:status');if(s.state==='error')throw new Error(s.message);return s.state==='stopped';});
      assert.equal(mock.stats.config.turn_detection.silence_duration_ms,Number(ms));
      assert.equal(mock.stats.config.turn_detection.threshold,0.2);
      assert.equal((await rpc('speech:diagnostics')).policy.silenceDurationMs,Number(ms));
    }
    await ui.locator('#speech').screenshot({path:'artifacts/vad-silence-setting.png'});
  });
  await step('Muted tabCapture and AudioWorklet send silent PCM16 frames and translate mock Japanese without site captions',async()=>{
    await activate();await rpc('speech:start');await until(async()=> (await rpc('speech:status')).completed>0&&mock.stats.audioBytes>3200);const s=await rpc('speech:status');assert.equal(s.state,'active');assert.equal(s.lastTranslation,'大家好。');assert.equal(mock.stats.nonzero,false);assert.equal(mock.stats.config.sample_rate,16000);
    const latency=await rpc('speech:diagnostics');assert.ok(latency.metrics.asrMs?.samples>0,'默认模型应能从 audio_end_ms 导出识别延迟');assert.equal(latency.settings?.asrModel,'qwen3-asr-flash-realtime');assert.equal(latency.settings?.language,'ja');assert.ok(latency.outcomes?.completed>=1);assert.equal(latency.policy?.maxQueue,3);assert.equal(latency.policy?.expireAfterMs,15000);assert.equal(latency.policy?.silenceDurationMs,600);
    assert.equal((await worker.evaluate(()=>chrome.tabCapture.getCapturedTabs()))[0].status,'active');assert.ok(requests.some(b=>b[0].segments[0].text==='皆さん、こんにちは。'));
    await page.screenshot({path:'artifacts/live-audio.png'});
  });
  await step('Reopening popup preserves live state and ordinary web pages never receive the speech auth header',async()=>{
    await activate();await popup.reload();await until(async()=>await popup.locator('#speech-start').textContent()==='重新开始');
    assert.equal(await popup.locator('#speech-stream-warning').isVisible(),true);assert.match(await popup.locator('#speech-stream-warning').textContent()??'',/流式响应/);assert.match(await popup.locator('#speech-stream-warning').textContent()??'',/延迟/);
    await page.evaluate(url=>new Promise(resolve=>{const s=new WebSocket(url+'?model=qwen3-asr-flash-realtime');s.onerror=()=>resolve();s.onopen=()=>{s.close();resolve();};}),ws);assert.ok(mock.stats.unauthorized>0);
    const denied=await worker.evaluate(id=>chrome.scripting.executeScript({target:{tabId:id},func:async()=>{try{return await chrome.runtime.sendMessage({type:'speech:settings-get'});}catch{return null;}}}),tabId);assert.equal(denied[0].result?.ok,false);
  });
  await step('Stop releases capture, offscreen document, auth rule and overlay',async()=>{
    await rpc('speech:stop');const before=mock.stats.frames;await new Promise(resolve=>setTimeout(resolve,400));assert.equal(mock.stats.frames,before);assert.equal((await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}))).length,0);assert.equal((await worker.evaluate(()=>chrome.declarativeNetRequest.getSessionRules())).length,0);assert.equal(await page.locator('[data-si-owned=video]').count(),0);
  });
  await step('Growing confirmed sentences are deduplicated, pending revisions coalesce, and stale responses do not replace captions',async()=>{
    await activate();await rpc('speech:start');await until(async()=> (await rpc('speech:status')).completed>0);translationDelay=650;
    const before=requests.length,completed=(await rpc('speech:status')).completed;
    const emit=text=>mock.emit({type:'conversation.item.input_audio_transcription.text',item_id:'coalesce',text,stash:'未確認の語'});
    emit('検証の最初の文です。');await until(()=>requests.length>before);emit('検証の訂正の文です。');emit('検証の最新の文です。');
    mock.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'coalesce',transcript:'検証の最新の文です。'});
    await until(async()=> (await rpc('speech:status')).lastTranslation==='译：検証の最新の文です。');
    assert.deepEqual(requests.slice(before).flatMap(b=>b.flatMap(x=>x.segments.map(s=>s.text))),['検証の最初の文です。','検証の最新の文です。']);assert.equal((await rpc('speech:status')).completed,completed+1);
    const next=requests.length;mock.emit({type:'conversation.item.input_audio_transcription.text',item_id:'prefix',text:'検証の前半です。',stash:'まだ翻訳しない'});await until(()=>requests.length>next);
    mock.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'prefix',transcript:'検証の前半です。検証の後半です。'});await until(async()=> (await rpc('speech:status')).lastTranslation==='译：検証の後半です。');
    assert.deepEqual(requests.slice(next).flatMap(b=>b.flatMap(x=>x.segments.map(s=>s.text))),['検証の前半です。','検証の後半です。']);assert.ok(!requests[next][0].context.includes('前半'));assert.ok(requests[next+1][0].context.includes('前半'));
    await activate();await popup.reload();await until(async()=>await popup.locator('#speech-timing').isVisible());assert.match(await popup.locator('#speech-timing').textContent(),/识别文本确认后/);
    translationDelay=0;await rpc('speech:stop');
  });
  await step('Slow translation merges adjacent short pending sentences instead of dropping them',async()=>{
    await activate();await rpc('speech:start');await until(async()=> (await rpc('speech:status')).completed>0);translationDelay=1000;const before=requests.length;
    const emit=n=>mock.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'bounded-'+n,transcript:`検証待機${n}。`});emit(1);await until(()=>requests.length>before);
    for(let n=2;n<=6;n++){emit(n);await new Promise(r=>setTimeout(r,25));}
    const merged=[2,3,4,5,6].map(n=>`検証待機${n}。`).join('');
    await until(async()=> (await rpc('speech:status')).lastTranslation==='译：'+merged);assert.deepEqual(requests.slice(before).flatMap(b=>b.flatMap(x=>x.segments.map(s=>s.text))),['検証待機1。',merged]);translationDelay=0;await rpc('speech:stop');
  });
  await step('Worker restart keeps the capture session and restores its translation configuration',async()=>{
    await activate();await rpc('speech:start');await until(async()=> (await rpc('speech:status')).state==='active');
    const session=await context.newCDPSession(ui),versions=new Map();session.on('ServiceWorker.workerVersionUpdated',e=>{for(const v of e.versions)versions.set(v.versionId,v);});await session.send('ServiceWorker.enable');await until(()=>[...versions.values()].some(v=>v.scriptURL===worker.url()));const version=[...versions.values()].find(v=>v.scriptURL===worker.url()),backgroundUrl=worker.url();
    await session.send('ServiceWorker.stopWorker',{versionId:version.versionId});await rpc('speech:status');worker=context.serviceWorkers().find(w=>w.url()===backgroundUrl)??worker;
    const before=requests.length;mock.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'after-restart',transcript:'今日は日本語のライブ配信です。'});await until(async()=>requests.length>before&&(await rpc('speech:status')).lastTranslation==='这是直播中文字幕。');await session.detach();await rpc('speech:stop');
  });
  await step('Interrupted websocket reconnects without retaining old audio buffers',async()=>{
    await activate();await rpc('speech:start');await until(async()=> (await rpc('speech:status')).state==='active');const before=mock.stats.authorized,frames=mock.stats.frames;mock.disconnect();await until(()=>mock.stats.authorized>before);await until(async()=>mock.stats.frames>=frames+6&&(await rpc('speech:status')).lastTranslation==='大家好。');mock.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'reconnect',transcript:'接続を再開しました。'});await until(async()=> (await rpc('speech:status')).lastTranslation==='这是直播中文字幕。');await rpc('speech:stop');
  });
  await step('Refresh stops audio and prevents old transcripts returning to a new document',async()=>{
    await activate();await rpc('speech:start');await until(async()=> (await rpc('speech:status')).state==='active');await page.reload();await until(async()=> (await rpc('speech:status')).state==='stopped');assert.match((await rpc('speech:status')).message,/开始实时翻译/);assert.equal((await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}))).length,0);
    await popup.reload();await until(async()=>/开始实时翻译/.test(await popup.locator('#speech-state').textContent()??''));
  });
  await step('Seeking or switching video stops audio and keeps a restart hint until the user starts again',async()=>{
    await page.locator('#silent-audio').click();await activate();await rpc('speech:start');await until(async()=>(await rpc('speech:status')).state==='active'&&(await captionTexts()).some(t=>t.includes('暂停滚动仍在采集和计费')));
    await page.locator('video').evaluate(v=>v.dispatchEvent(new Event('seeking')));await until(async()=>(await rpc('speech:status')).state==='stopped');
    assert.match((await rpc('speech:status')).message,/拖动进度/);assert.match((await rpc('speech:status')).message,/开始实时翻译/);
    await until(async()=>(await captionTexts()).some(t=>t.includes('开始实时翻译')));assert.equal(await page.locator('[data-si-owned=video]').count(),1);assert.equal((await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}))).length,0);
    await rpc('speech:start');await until(async()=>(await rpc('speech:status')).state==='active');await page.locator('video').evaluate(v=>v.remove());
    await until(async()=>(await rpc('speech:status')).state==='stopped'&&/视频已切换/.test((await rpc('speech:status')).message));
    await until(async()=>(await captionTexts()).some(t=>t.includes('开始实时翻译')));assert.equal(await page.locator('[data-si-owned=video]').count(),1);
    await page.evaluate(()=>{const video=document.createElement('video');video.style.cssText='width:720px;height:405px;background:#202438';document.body.prepend(video);});
    await rpc('speech:start');await until(async()=>(await rpc('speech:status')).state==='active');await rpc('speech:stop');await new Promise(r=>setTimeout(r,400));assert.equal(await page.locator('[data-si-owned=video]').count(),0);
  });
  await step('Provider error stops recording and clears credentials and exposes a useful message',async()=>{
    await page.locator('#silent-audio').click();await activate();await rpc('speech:start');await until(async()=> (await rpc('speech:status')).state==='active');mock.emit({type:'error',error:{message:'must-not-display-secret'}});await until(async()=> (await rpc('speech:status')).state==='error');assert.ok(!(await rpc('speech:status')).message.includes('must-not-display-secret'));assert.equal((await worker.evaluate(()=>chrome.declarativeNetRequest.getSessionRules())).length,0);
  });
  await step('The video stop control also stops the audio session instead of only hiding its captions',async()=>{
    await activate();await rpc('speech:start');await until(async()=> (await rpc('speech:status')).state==='active');await rpc('video:action',{action:'stop'});assert.equal((await rpc('speech:status')).state,'stopped');assert.equal((await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}))).length,0);
  });
  await step('Streaming settings generate regional workspace addresses, validate missing workspace, and preserve the key when switching models',async()=>{
    const authorized=mock.stats.authorized;await ui.locator('#speech-endpoint').fill('wss://dashscope.aliyuncs.com/api-ws/v1/realtime');await ui.locator('#speech-endpoint').press('Tab');await ui.locator('#speech-model').fill('qwen-audio-3.1-asr-flash-streaming');await ui.locator('#speech-model').press('Tab');await ui.locator('#speech-save').click();await until(async()=>/Workspace ID/.test(await ui.locator('#speech-feedback').textContent()));assert.equal(mock.stats.authorized,authorized);
    await ui.locator('#speech-region').selectOption('ap-southeast-1');await ui.locator('#speech-workspace').fill('workspace-test');await ui.locator('#speech-workspace').press('Tab');assert.equal(await ui.locator('#speech-endpoint').inputValue(),'wss://workspace-test.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference');
    await ui.locator('#speech-model').fill('qwen3-asr-flash-realtime');await ui.locator('#speech-model').press('Tab');assert.ok((await ui.locator('#speech-endpoint').inputValue()).endsWith('/realtime'));assert.equal(await ui.locator('#speech-key').inputValue(),'test-speech-key');
    await ui.locator('#speech-model').fill('qwen-audio-3.1-asr-flash-streaming');await ui.locator('#speech-model').press('Tab');await ui.locator('#speech-endpoint').fill(origin.replace('http:','ws:')+'/api-ws/v1/inference');await ui.locator('#speech-context').fill('出演者は山田太郎です。');await ui.locator('#speech-save').click();await until(async()=>(await rpc('speech:settings-get')).model==='qwen-audio-3.1-asr-flash-streaming');assert.equal((await rpc('speech:settings-get')).endpoint,origin.replace('http:','ws:')+'/api-ws/v1/inference');assert.equal(mock.stats.authorized,authorized);
    await ui.screenshot({path:'artifacts/streaming-settings.png'});
  });
  await step('Streaming connection test uses run-task and finish-task with exact websocket auth and sends no audio',async()=>{
    mock.setReadyDelay(250);const frames=mock.stats.frames,started=mock.stats.streamingStarts,finished=mock.stats.streamingFinishes;await rpc('speech:test');await until(async()=>(await rpc('speech:status')).state==='stopped');await until(()=>mock.stats.streamingFinishes>finished);
    assert.match((await rpc('speech:status')).message,/连接成功/);assert.equal(mock.stats.frames,frames);assert.equal(mock.stats.streamingStarts,started+1);assert.equal(mock.stats.urls.at(-1),'/api-ws/v1/inference');assert.deepEqual(mock.stats.lastRun.payload.parameters.language_hints,['ja']);assert.equal(mock.stats.lastRun.payload.parameters.max_sentence_silence,600);assert.equal(mock.stats.lastRun.payload.input.context[0].content[0].text,'出演者は山田太郎です。');assert.equal((await worker.evaluate(()=>chrome.declarativeNetRequest.getSessionRules())).length,0);
  });
  await step('Streaming captures real binary PCM only after task-started and exposes timestamps and cumulative usage',async()=>{
    const binary=mock.stats.binaryFrames,legacy=mock.stats.legacyFrames;await activate();await rpc('speech:start');await until(async()=> (await rpc('speech:status')).lastTranslation==='大家好。'&&!!(await rpc('speech:status')).asrUsage);
    assert.ok(mock.stats.binaryFrames>binary);assert.equal(mock.stats.legacyFrames,legacy);assert.equal(mock.stats.prematureFrames,0);assert.equal(mock.stats.protocolErrors,0);assert.deepEqual((await rpc('speech:status')).sourceTime,{beginMs:0,endMs:1800});assert.deepEqual((await rpc('speech:status')).asrUsage,{inputTokens:85,outputTokens:6,totalTokens:91});
    const unauthorized=mock.stats.unauthorized;await page.evaluate(url=>new Promise(resolve=>{const ws=new WebSocket(url);ws.onerror=()=>resolve();ws.onopen=()=>{ws.close();resolve();};}),origin.replace('http:','ws:')+'/api-ws/v1/inference');assert.equal(mock.stats.unauthorized,unauthorized+1);
    mock.emitStreaming({heartbeat:true,sentence_id:0,text:'must-not-display'},{input_tokens:85,output_tokens:6});await new Promise(r=>setTimeout(r,1100));assert.equal((await rpc('speech:status')).lastSource,'皆さん、こんにちは。');assert.equal((await rpc('speech:status')).asrUsage.totalTokens,91);
    await activate();await popup.reload();await until(async()=>await popup.locator('#speech-usage').isVisible());assert.match(await popup.locator('#speech-usage').textContent(),/输入 85/);await page.screenshot({path:'artifacts/streaming-captions.png'});
  });
  await step('Streaming partial snapshots never send draft words and stable prefixes are not retransmitted on sentence completion',async()=>{
    const before=requests.length;mock.emitStreaming({sentence_id:2,begin_time:1900,end_time:null,sentence_end:false,text:'検証の未確認の途中結果です。',words:[{text:'検証の未確認の途中結果です。',fixed:false}]});await new Promise(r=>setTimeout(r,2300));assert.equal(requests.length,before);
    mock.emitStreaming({sentence_id:2,begin_time:1900,end_time:null,sentence_end:false,text:'検証の前半です。未確認の後半',words:[{text:'検証の前半です。',fixed:true},{text:'未確認の後半',fixed:false}]});await until(async()=>(await rpc('speech:status')).lastTranslation==='译：検証の前半です。');
    mock.emitStreaming({sentence_id:2,begin_time:1900,end_time:4300,sentence_end:true,text:'検証の前半です。検証の後半です。'},{input_tokens:500,output_tokens:20});await until(async()=>(await rpc('speech:status')).lastTranslation==='译：検証の後半です。');assert.deepEqual(requests.slice(before).flatMap(b=>b.flatMap(x=>x.segments.map(s=>s.text))),['検証の前半です。','検証の後半です。']);await until(async()=>(await rpc('speech:status')).asrUsage.inputTokens===500);
  });
  await step('Streaming reconnect starts a new task, ignores old task results, and adds cumulative usage without double counting',async()=>{
    const old=mock.stats.lastRun.header.task_id,started=mock.stats.streamingStarts;mock.disconnect();await until(()=>mock.stats.streamingStarts>started);await until(async()=>(await rpc('speech:status')).lastTranslation==='大家好。'&&(await rpc('speech:status')).asrUsage.inputTokens===585);assert.notEqual(mock.stats.lastRun.header.task_id,old);
    mock.emit({header:{task_id:old,event:'task-failed',error_message:'must-not-display-secret'},payload:{}});await new Promise(r=>setTimeout(r,300));assert.equal((await rpc('speech:status')).state,'active');assert.equal(mock.stats.protocolErrors,0);
  });
  await step('Streaming task failure stops audio and removes authorization without exposing provider errors',async()=>{
    mock.emit({header:{task_id:mock.stats.lastRun.header.task_id,event:'task-failed',error_message:'must-not-display-secret'},payload:{}});await until(async()=>(await rpc('speech:status')).state==='error');assert.ok(!(await rpc('speech:status')).message.includes('must-not-display-secret'));assert.equal((await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}))).length,0);assert.equal((await worker.evaluate(()=>chrome.declarativeNetRequest.getSessionRules())).length,0);
  });
  await step('Switching back to the existing model restores its wire protocol and still stops all resources',async()=>{
    const s=await rpc('speech:settings-get');await rpc('speech:settings-save',{settings:{...s,model:'qwen3-asr-flash-realtime'}});assert.equal((await rpc('speech:settings-get')).endpoint,ws);const frames=mock.stats.legacyFrames,binary=mock.stats.binaryFrames;
    await activate();await rpc('speech:start');await until(async()=>(await rpc('speech:status')).lastTranslation==='大家好。');assert.ok(mock.stats.legacyFrames>frames);assert.equal(mock.stats.binaryFrames,binary);await rpc('speech:stop');assert.equal(mock.stats.prematureFrames,0);assert.equal(mock.stats.protocolErrors,0);
  });
  await step('Real translation SSE paints an increasing caption before the final response and records first-text / first-paint timings',async()=>{
    const settings=await rpc('settings:get');settings.profiles[0].stream=true;await rpc('settings:save',{settings});await until(async()=>await popup.locator('#speech-stream-warning').isHidden());const speech=await rpc('speech:settings-get');await rpc('speech:settings-save',{settings:{...speech,model:'qwen-audio-3.1-asr-flash-streaming'}});await rpc('speech:diagnostics-clear');await activate();await page.bringToFront();await rpc('speech:start');
    await until(async()=>(await captionTexts()).includes('大家'));assert.equal((await rpc('speech:status')).completed,0);assert.ok(!(await captionTexts()).join('\n').includes('must-not-show-reasoning'));assert.ok(!streamTimings.at(-1).doneAt);
    await until(async()=>(await captionTexts()).includes('大家好。'));assert.equal((await rpc('speech:status')).completed,0);assert.ok(!streamTimings.at(-1).doneAt,'The final few characters must flush during a pause before the response ends');
    await until(async()=>(await rpc('speech:status')).completed===1);await until(async()=>(await rpc('speech:diagnostics')).metrics.firstPaintMs?.samples>0);const d=await rpc('speech:diagnostics'),row=d.rows[0];assert.ok(row.firstTextMs<row.translationMs-500);assert.ok(row.firstPaintMs<row.translationMs);assert.equal(row.streaming,true);
    await writeFile('artifacts/live-latency.json',JSON.stringify({fixture:'local mock ASR and chunked text API; not real service latency',diagnostics:d,streamTimings},null,2));
  });
  await step('Reading controls preserve the current sentence while new translations arrive and allow reviewing the previous caption',async()=>{
    await page.evaluate(()=>{globalThis.pageClicks=0;document.body.addEventListener('click',()=>globalThis.pageClicks++);});
    const end=mock.stats.audioMs;await new Promise(r=>setTimeout(r,120));mock.emitStreaming({sentence_id:20,begin_time:0,end_time:end,sentence_end:true,text:'閲読一。'});
    await until(async()=>(await captionTexts()).includes(translatedText('閲読一。')));assert.ok((await captionTexts()).some(t=>t.includes('暂停滚动仍在采集和计费')));assert.match(await popup.locator('#caption-pause-note').textContent()??'',/不会停止采集和计费/);await captionClick('暂停字幕滚动');mock.emitStreaming({sentence_id:21,begin_time:end,end_time:mock.stats.audioMs,sentence_end:true,text:'閲読二。'});await until(async()=>(await rpc('speech:status')).lastTranslation===translatedText('閲読二。'));
    assert.ok((await captionTexts()).includes(translatedText('閲読一。')));assert.ok(!(await captionTexts()).includes(translatedText('閲読二。')));await captionClick('回到最新');await until(async()=>(await captionTexts()).includes(translatedText('閲読二。')));assert.ok((await captionTexts()).some(t=>t.startsWith('上一条：')));await captionClick('上一条译文');assert.ok((await captionTexts()).includes(translatedText('閲読一。')));await page.screenshot({path:'artifacts/live-reading-controls.png'});await captionClick('回到最新');
    const d=await rpc('speech:diagnostics');assert.ok(d.metrics.asrMs?.samples>0);assert.ok(d.metrics.displayWaitMs?.samples>0);assert.equal(await page.evaluate(()=>globalThis.pageClicks),0);
  });
  await step('A rejected streamed translation is withdrawn and the previous completed subtitle remains readable',async()=>{
    await rpc('caption:save',{patch:{readingMode:'live'}});mock.emitStreaming({sentence_id:21,begin_time:0,end_time:mock.stats.audioMs,sentence_end:true,text:'検証失敗。'});await until(async()=>(await captionTexts()).some(t=>t.includes('需要撤回')));await until(async()=>(await rpc('speech:status')).message.includes('文字翻译失败'));await until(async()=>!(await captionTexts()).some(t=>t.includes('需要撤回')));assert.ok((await captionTexts()).includes(translatedText('閲読二。')));assert.ok((await rpc('speech:diagnostics')).rows.some(r=>r.outcome==='failed'));
  });
  await step('Worker restart withdraws an interrupted provisional caption and new streamed subtitles can still display',async()=>{
    mock.emitStreaming({sentence_id:24,begin_time:0,end_time:mock.stats.audioMs,sentence_end:true,text:'検証中断。'});await until(async()=>(await captionTexts()).some(t=>t.includes('译：検証')));
    const cdp=await context.newCDPSession(ui),versions=new Map();cdp.on('ServiceWorker.workerVersionUpdated',e=>{for(const v of e.versions)versions.set(v.versionId,v);});await cdp.send('ServiceWorker.enable');await until(()=>[...versions.values()].some(v=>v.scriptURL===worker.url()));const version=[...versions.values()].find(v=>v.scriptURL===worker.url()),backgroundUrl=worker.url();await cdp.send('ServiceWorker.stopWorker',{versionId:version.versionId});await rpc('speech:status');worker=context.serviceWorkers().find(w=>w.url()===backgroundUrl)??worker;
    mock.emitStreaming({sentence_id:25,begin_time:0,end_time:mock.stats.audioMs,sentence_end:true,text:'検証復帰。'});await until(async()=>(await rpc('speech:status')).lastTranslation===translatedText('検証復帰。')&&(await captionTexts()).includes(translatedText('検証復帰。')));await cdp.detach();
  });
  await step('ASR reconnect cancels provisional text so an unfinished caption cannot block all later subtitles',async()=>{
    mock.emitStreaming({sentence_id:26,begin_time:0,end_time:mock.stats.audioMs,sentence_end:true,text:'検証再接続。'});await until(async()=>(await captionTexts()).some(t=>t.includes('译：検証再')));const started=mock.stats.streamingStarts;mock.disconnect();await until(()=>mock.stats.streamingStarts>started);await until(async()=>(await rpc('speech:status')).lastTranslation==='大家好。'&&(await captionTexts()).includes('大家好。'));assert.ok(!(await captionTexts()).some(t=>t.includes('再接続')));assert.ok((await rpc('speech:diagnostics')).rows.some(r=>r.outcome==='cancelled'));
  });
  await step('Local diagnostic export omits all text, audio, credentials and URLs; stopping cancels unfinished streamed captions',async()=>{
    await activate();await popup.reload();await popup.locator('#speech-diagnostics summary').click();await until(async()=>(await popup.locator('#speech-diagnostics-text').textContent()).includes('P50'));const download=popup.waitForEvent('download');await popup.locator('#speech-diagnostics-export').click();const file=await download;await file.saveAs('artifacts/exported-latency.json');const raw=await readFile('artifacts/exported-latency.json','utf8');for(const secret of ['test-speech-key','test-text-key',origin,'皆さん','第一句字幕','sourceEndAt','山田太郎','apiKey','dashscope'])assert.ok(!raw.includes(secret),'Diagnostic leak: '+secret);
    const exported=JSON.parse(raw);assert.equal(typeof exported.outcomes?.completed,'number');assert.equal(exported.settings?.language,'ja');assert.equal(exported.settings?.textStream,true);assert.equal(exported.settings?.readingMode,'live');assert.equal(exported.policy?.skipAfterMs,12000);assert.equal(exported.policy?.silenceDurationMs,600);
    await activate();await page.bringToFront();mock.emitStreaming({sentence_id:23,begin_time:0,end_time:mock.stats.audioMs,sentence_end:true,text:'検証停止。'});await until(async()=>(await captionTexts()).some(t=>t.includes('译：検')));await rpc('speech:stop');await new Promise(r=>setTimeout(r,1300));assert.equal(await page.locator('[data-si-owned=video]').count(),0);assert.ok(streamTimings.some(t=>t.cancelled));await rpc('speech:diagnostics-clear');assert.equal((await rpc('speech:diagnostics')).samples,0);
  });
  assert.equal(mock.stats.nonzero,false);assert.deepEqual(errors,[]);await writeFile('artifacts/speech-tests.json',JSON.stringify({passed:results.length,tests:results,audioVerification:'muted real tabCapture with silent PCM; nonzero processing separately verified in OfflineAudioContext without an output device',metrics:{frames:mock.stats.frames,audioBytes:mock.stats.audioBytes,nonzero:mock.stats.nonzero}},null,2));
}catch(error){await writeFile('artifacts/speech-tests.json',JSON.stringify({passed:results.length,tests:results,error:error.stack,state:await rpc('speech:status'),metrics:mock.stats,errors},null,2));throw error;}
finally{await context.close();mock.close();await new Promise(resolve=>server.close(resolve));}
