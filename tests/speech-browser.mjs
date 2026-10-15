import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdir,cp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {mockASR} from './fixtures/mock-asr.mjs';
const results=[],requests=[];let translationDelay=0;
const server=http.createServer(async(req,res)=>{
  if(req.url==='/v1/chat/completions'){let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw),blocks=JSON.parse(input.messages[1].content).blocks;requests.push(blocks);if(translationDelay)await new Promise(r=>setTimeout(r,translationDelay));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({segments:blocks.flatMap(b=>b.segments.map(s=>({id:s.id,text:s.text==='皆さん、こんにちは。'?'大家好。':s.text.startsWith('検証')?'译：'+s.text:'这是直播中文字幕。'})))})}}],usage:{prompt_tokens:10,completion_tokens:10}}));return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Live audio fixture</h1><video style="width:720px;height:405px;background:#202438"></video><button id="tone">Play audio</button><script>document.querySelector("#tone").onclick=async()=>{window.audio=new AudioContext();const osc=audio.createOscillator(),gain=audio.createGain();gain.gain.value=.05;osc.connect(gain);gain.connect(audio.destination);osc.start();await audio.resume();};</script></body></html>');
});
const mock=mockASR(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,ws=origin.replace('http:','ws:')+'/api-ws/v1/realtime';
await mkdir('artifacts',{recursive:true});const extension=path.resolve('artifacts/speech-extension');await cp('dist',extension,{recursive:true});
const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),der=publicKey.export({type:'spki',format:'der'}),id=createHash('sha256').update(der).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.key=der.toString('base64');await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
// Chromium allowlist supplies the toolbar invocation grant in this isolated automated profile only.
const context=await chromium.launchPersistentContext(path.resolve('artifacts',`speech-profile-${Date.now()}`),{channel:'chromium',headless:true,ignoreDefaultArgs:['--mute-audio'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--allowlisted-extension-id=${id}`,'--autoplay-policy=no-user-gesture-required']});
const errors=[];context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
let worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');assert.equal(new URL(worker.url()).host,id);
const ui=await context.newPage();await ui.goto(`chrome-extension://${id}/options.html`);const page=await context.newPage();await page.goto(origin);await page.locator('#tone').click();const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({url:url+'/*'}))[0].id,origin);
const rpc=(type,extra={})=>ui.evaluate(async({type,extra})=>{const r=await chrome.runtime.sendMessage({type,...extra});if(!r?.ok)throw new Error(r?.error??'No response');return r.data;},{type,extra});
const activate=()=>worker.evaluate(id=>chrome.tabs.update(id,{active:true}),tabId);
async function until(fn,timeout=18000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Condition timed out: '+JSON.stringify(await rpc('speech:status')));}
async function step(name,fn){await fn();results.push({name,passed:true});console.log('PASS '+name);}
try{
  await step('Configure independent speech settings via UI without starting capture',async()=>{
    await ui.locator('#speech-key').fill('test-speech-key');await ui.locator('#speech-endpoint').fill(ws);await ui.locator('#speech-language').selectOption('ja');await ui.locator('#speech-save').click();await until(async()=>await ui.locator('#speech-feedback').textContent()==='语音配置已保存。');
    const s=await rpc('settings:get');s.profiles[0]={...s.profiles[0],type:'compatible',baseUrl:origin+'/v1',apiKey:'test-text-key',model:'mock',stream:false};await rpc('settings:save',{settings:s});
    assert.equal(mock.stats.authorized,0);assert.equal((await rpc('speech:status')).state,'idle');
  });
  await step('Connection test verifies websocket authentication and Japanese session without recording audio',async()=>{
    await rpc('speech:test');await until(async()=> {const s=await rpc('speech:status');if(s.state==='error')throw new Error(s.message);return s.state==='stopped';});assert.match((await rpc('speech:status')).message,/连接成功/);assert.equal(mock.stats.config.input_audio_transcription.language,'ja');assert.equal(mock.stats.frames,0);
    assert.equal((await worker.evaluate(()=>chrome.declarativeNetRequest.getSessionRules())).length,0);
  });
  await step('Actual tabCapture and AudioWorklet send nonzero PCM16 and translate Japanese without site captions',async()=>{
    await activate();await rpc('speech:start');await until(async()=> (await rpc('speech:status')).completed>0&&mock.stats.nonzero);const s=await rpc('speech:status');assert.equal(s.state,'active');assert.equal(s.lastTranslation,'大家好。');assert.ok(mock.stats.nonzero);assert.ok(mock.stats.audioBytes>3200);assert.equal(mock.stats.config.sample_rate,16000);
    assert.equal((await worker.evaluate(()=>chrome.tabCapture.getCapturedTabs()))[0].status,'active');assert.ok(requests.some(b=>b[0].segments[0].text==='皆さん、こんにちは。'));
    await page.screenshot({path:'artifacts/live-audio.png'});
  });
  await step('Reopening popup preserves live state and ordinary web pages never receive the speech auth header',async()=>{
    await activate();await popup.reload();await until(async()=>await popup.locator('#speech-start').textContent()==='重新开始');
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
  await step('Slow translation keeps only the latest three pending sentences instead of accumulating a live backlog',async()=>{
    await activate();await rpc('speech:start');await until(async()=> (await rpc('speech:status')).completed>0);translationDelay=1000;const before=requests.length;
    const emit=n=>mock.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'bounded-'+n,transcript:`検証待機${n}。`});emit(1);await until(()=>requests.length>before);
    for(let n=2;n<=6;n++){emit(n);await new Promise(r=>setTimeout(r,25));}
    await until(async()=> (await rpc('speech:status')).lastTranslation==='译：検証待機6。');assert.deepEqual(requests.slice(before).flatMap(b=>b.flatMap(x=>x.segments.map(s=>s.text))),['検証待機1。','検証待機4。','検証待機5。','検証待機6。']);translationDelay=0;await rpc('speech:stop');
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
    await activate();await rpc('speech:start');await until(async()=> (await rpc('speech:status')).state==='active');await page.reload();await until(async()=> (await rpc('speech:status')).state==='stopped');assert.equal((await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}))).length,0);
  });
  await step('Provider error stops recording and clears credentials and exposes a useful message',async()=>{
    await page.locator('#tone').click();await activate();await rpc('speech:start');await until(async()=> (await rpc('speech:status')).state==='active');mock.emit({type:'error',error:{message:'must-not-display-secret'}});await until(async()=> (await rpc('speech:status')).state==='error');assert.ok(!(await rpc('speech:status')).message.includes('must-not-display-secret'));assert.equal((await worker.evaluate(()=>chrome.declarativeNetRequest.getSessionRules())).length,0);
  });
  await step('The video stop control also stops the audio session instead of only hiding its captions',async()=>{
    await activate();await rpc('speech:start');await until(async()=> (await rpc('speech:status')).state==='active');await rpc('video:action',{action:'stop'});assert.equal((await rpc('speech:status')).state,'stopped');assert.equal((await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}))).length,0);
  });
  assert.deepEqual(errors,[]);await writeFile('artifacts/speech-tests.json',JSON.stringify({passed:results.length,tests:results,metrics:{frames:mock.stats.frames,audioBytes:mock.stats.audioBytes,nonzero:mock.stats.nonzero}},null,2));
}catch(error){await writeFile('artifacts/speech-tests.json',JSON.stringify({passed:results.length,tests:results,error:error.stack,state:await rpc('speech:status'),metrics:mock.stats,errors},null,2));throw error;}
finally{await context.close();mock.close();await new Promise(resolve=>server.close(resolve));}
