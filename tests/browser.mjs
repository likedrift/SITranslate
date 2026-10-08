import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';

const root=process.cwd(),results=[],requests=[];
let behavior='normal',delay=0;
const fixture=await readFile('tests/fixtures/article.html','utf8');
const videoFixture=await readFile('tests/fixtures/video.html','utf8');
const silence=Buffer.alloc(44+120*8000*2);silence.write('RIFF');silence.writeUInt32LE(silence.length-8,4);silence.write('WAVEfmt ',8);silence.writeUInt32LE(16,16);silence.writeUInt16LE(1,20);silence.writeUInt16LE(1,22);silence.writeUInt32LE(8000,24);silence.writeUInt32LE(16000,28);silence.writeUInt16LE(2,32);silence.writeUInt16LE(16,34);silence.write('data',36);silence.writeUInt32LE(silence.length-44,40);
const vtt='WEBVTT\n\n00:00.000 --> 00:05.000\nHello world.\n\n00:05.000 --> 00:10.000\nSecond subtitle.\n\n00:10.000 --> 00:15.000\nEnglish and 日本語 mixed.\n\n01:00.000 --> 01:05.000\nA late subtitle.\n';
const dictionary={'Hello world.':'你好，世界。','English and 日本語 mixed.':'英语和日语混合。','This is the selected sentence.':'这是选中的句子。','Original content.':'原始内容。','New dynamic content.':'动态新增内容。','Updated by the website.':'网站更新了内容。','Read ':'阅读','documentation':'文档',' carefully.':'时请仔细。'};
const server=http.createServer(async(req,res)=>{
  if(req.url==='/silence.wav'){res.setHeader('Content-Type','audio/wav');res.setHeader('Accept-Ranges','bytes');const match=req.headers.range?.match(/bytes=(\d+)-(\d*)/);if(match){const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),silence.length-1):silence.length-1;res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${silence.length}`,'Content-Length':end-start+1});res.end(silence.subarray(start,end+1));}else res.end(silence);return;}
  if(req.url==='/subtitles.vtt'){res.setHeader('Content-Type','text/vtt; charset=utf-8');res.end(vtt);return;}
  if(req.url==='/v1/chat/completions'){
    let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);const blocks=JSON.parse(input.messages[1].content).blocks;requests.push({input,blocks,at:Date.now()});
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    if(behavior==='auth'){res.writeHead(401);res.end('private diagnostic');return;}
    let segments=blocks.flatMap(b=>b.segments).map(s=>({id:s.id,text:dictionary[s.text]??(behavior==='html'?'<img src=x onerror="window.hacked=true">':'译：'+s.text)}));
    if(behavior==='invalid')segments=segments.slice(1);
    const truncated=behavior==='truncate'&&segments.length>6;
    const content=truncated?'{"segments":[':JSON.stringify({segments});
    if(input.stream){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
      for(let i=0;i<content.length;i+=17){res.write(`data: ${JSON.stringify({choices:[{delta:{content:content.slice(i,i+17)}}]})}\n\n`);}
      res.end(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:truncated?'length':'stop'}]})}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\ndata: [DONE]\n\n`);
    }else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content}}],usage:{prompt_tokens:100,completion_tokens:50}}));}
    return;
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.url?.startsWith('/video')?videoFixture:fixture);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
await mkdir('artifacts',{recursive:true});
// Load a copy of the production extension in an isolated profile; all fixtures and API calls stay on loopback.
const testExtension=path.join(root,'artifacts','test-extension');await cp('dist',testExtension,{recursive:true});
const context=await chromium.launchPersistentContext(path.join(root,'artifacts',`browser-profile-${Date.now()}`),{
  channel:'chromium',headless:true,viewport:{width:1280,height:900},args:[`--disable-extensions-except=${testExtension}`,`--load-extension=${testExtension}`]
});
const browserErrors=[];context.on('page',page=>page.on('pageerror',error=>browserErrors.push(error.message)));
let worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const extensionId=new URL(worker.url()).host;
const ui=await context.newPage();await ui.goto(`chrome-extension://${extensionId}/options.html`);
const page=await context.newPage();await page.goto(`${origin}/article`);
const popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId}/popup.html`);
const tabId=await worker.evaluate(async(url)=>(await chrome.tabs.query({url:url+'/*'}))[0].id,origin);
async function rpc(type,extra={}){return ui.evaluate(async({type,extra})=>{const result=await chrome.runtime.sendMessage({type,...extra});if(!result.ok)throw new Error(result.error);return result.data;},{type,extra});}
async function activate(){await worker.evaluate(id=>chrome.tabs.update(id,{active:true}),tabId);}
async function isInjected(){const result=await worker.evaluate(id=>chrome.scripting.executeScript({target:{tabId:id},func:()=>!!globalThis.__siTranslate}),tabId);return result[0]?.result;}
async function act(action){await activate();return rpc('tab:action',{action});}
async function status(){return worker.evaluate(id=>chrome.tabs.sendMessage(id,{type:'page:get-status'},{frameId:0}),tabId);}
async function until(predicate,timeout=12000){const start=performance.now();while(performance.now()-start<timeout){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,60));}throw new Error('Condition timed out');}
async function complete(){await until(async()=>['watching','done'].includes((await status()).state));}
async function step(name,fn){const start=performance.now();await fn();results.push({name,passed:true,ms:Math.round(performance.now()-start)});console.log(`PASS ${name}`);}
try{
  await step('Configure provider through the actual settings UI',async()=>{
    await ui.locator('#profile-type').selectOption('compatible');await ui.locator('#base-url').fill(origin+'/v1');await ui.locator('#api-key').fill('test-key-not-a-real-secret');await ui.locator('#model').fill('mock-translator');
    await ui.locator('#settings-form').evaluate(form=>form.requestSubmit());await until(async()=>await ui.locator('#feedback').textContent()==='设置已保存。');
    const settings=await rpc('settings:get');assert.equal(settings.profiles[0].baseUrl,origin+'/v1');
    await activate();await popup.reload();await ui.screenshot({path:'artifacts/settings-light.png',fullPage:true});await popup.setViewportSize({width:360,height:640});await popup.screenshot({path:'artifacts/popup-light.png'});
    await ui.emulateMedia({colorScheme:'dark'});await ui.screenshot({path:'artifacts/settings-dark.png',fullPage:true});await ui.emulateMedia({colorScheme:'light'});
  });
  await step('Selection is on by default, reopening popup restores state, and disabling updates the current page',async()=>{
    await until(isInjected);assert.deepEqual(await rpc('selection:origins'),['https://*/*','http://*/*']);
    await activate();await popup.reload();await until(async()=>await popup.locator('#grant-site').textContent()==='划词已开启 · 管理网站');
    const before=requests.length;
    await page.locator('#selection').evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(range);el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));});
    await page.locator('[data-si-owned=panel]').waitFor();assert.equal(requests.length,before);
    await rpc('selection:save',{origins:[]});await until(async()=>await page.locator('[data-si-owned=panel]').count()===0);
    await until(async()=>await popup.locator('#grant-site').textContent()==='开启所有网站划词');
    await page.locator('#selection').evaluate(el=>el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})));await new Promise(resolve=>setTimeout(resolve,200));assert.equal(await page.locator('[data-si-owned=panel]').count(),0);
    await rpc('selection:save',{origins:['http://127.0.0.1/*']});await activate();await popup.reload();await until(async()=>await popup.locator('#grant-site').textContent()==='划词已开启 · 管理网站');
    await rpc('selection:save',{origins:['https://*/*','http://*/*']});await page.keyboard.press('Escape');
  });
  await step('Whole-page translation preserves links, listeners, inputs, code and protected text',async()=>{
    await act('start');await complete();
    assert.equal(await page.locator('#plain').textContent(),'你好，世界。');assert.equal(await page.locator('#mixed').textContent(),'英语和日语混合。');
    assert.equal(await page.locator('#link').getAttribute('href'),'#details');assert.equal(await page.locator('#link').textContent(),'文档');
    await page.locator('#button').click();assert.equal(await page.locator('#click-count').textContent(),'1');
    assert.equal(await page.locator('#input').inputValue(),'Do not translate my input');assert.equal(await page.locator('#editable').textContent(),'Editable content');assert.match(await page.locator('#code').textContent(),/Do not translate code/);
    assert.equal(await page.locator('#hidden').textContent(),'Hidden content');assert.equal(await page.locator('#protected').textContent(),'Protected content');
    const strings=requests.flatMap(r=>r.blocks.flatMap(b=>b.segments.map(s=>s.text))).join('\n');assert.ok(!strings.includes('Do not translate my input'));assert.ok(!strings.includes('Do not translate code'));assert.ok(!strings.includes('Hidden content'));
    await page.screenshot({path:'artifacts/translated-page.png'});
  });
  await step('Dynamic additions translate once and translation writes do not loop',async()=>{
    const before=requests.length;await page.locator('#dynamic').evaluate(el=>{const p=document.createElement('p');p.id='added';p.textContent='New dynamic content.';el.append(p);});
    await until(async()=>await page.locator('#added').textContent()==='动态新增内容。');await new Promise(resolve=>setTimeout(resolve,800));assert.equal(requests.length,before+1);
  });
  await step('Open Shadow DOM and newly revealed text translate without exposing closed roots',async()=>{
    await page.evaluate(()=>{const host=document.createElement('article-card');host.id='shadow-card';host.attachShadow({mode:'open'}).innerHTML='<p>Shadow article text.</p>';document.body.append(host);const closed=document.createElement('closed-card');closed.attachShadow({mode:'closed'}).innerHTML='<p>Closed hidden text.</p>';document.body.append(closed);document.querySelector('#hidden').style.display='block';});
    await until(async()=>await page.locator('#shadow-card p').textContent()==='译：Shadow article text.');
    await until(async()=>await page.locator('#hidden').textContent()==='译：Hidden content');
    assert.ok(!requests.some(r=>r.blocks.some(b=>b.segments.some(s=>s.text==='Closed hidden text.'))));
  });
  await step('Display switch and restore keep website updates',async()=>{
    const settings=await rpc('settings:get');await rpc('preferences:save',{target:settings.target,display:'bilingual',profileId:settings.activeProfileId});await act('display');
    assert.equal(await page.locator('#plain').evaluate(el=>el.firstChild.textContent),'Hello world.');assert.equal(await page.locator('#plain [data-si-owned=translation]').textContent(),'［你好，世界。］');
    await page.locator('#changing').evaluate(el=>{el.textContent='Updated by the website.';});await act('restore');
    assert.equal(await page.locator('#plain').textContent(),'Hello world.');assert.equal(await page.locator('#changing').textContent(),'Updated by the website.');assert.equal(await page.locator('[data-si-owned=translation]').count(),0);
    await rpc('preferences:save',{target:settings.target,display:'replace',profileId:settings.activeProfileId});
  });
  await step('Selection makes no network call before explicit click and then streams a floating result',async()=>{
    const before=requests.length;await page.locator('#selection').evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));});
    await page.locator('[data-si-owned=panel]').waitFor();await new Promise(resolve=>setTimeout(resolve,250));assert.equal(requests.length,before);
    const box=await page.locator('[data-si-owned=panel]').boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
    await until(()=>requests.length===before+1);assert.equal(requests.at(-1).blocks[0].context,'');assert.equal(requests.at(-1).blocks[0].segments[0].text,'This is the selected sentence.');
    const cdp=await context.newCDPSession(page);await until(async()=>{const tree=await cdp.send('Accessibility.getFullAXTree');return tree.nodes.some(n=>n.name?.value==='这是选中的句子。');});await cdp.detach();
    await page.screenshot({path:'artifacts/selection-result.png'});await page.keyboard.press('Escape');assert.equal(await page.locator('[data-si-owned=panel]').count(),0);
  });
  await step('Optional selection permission persists a lightweight listener for fresh pages',async()=>{
    await rpc('selection:save',{origins:['http://127.0.0.1/*']});
    await page.goto(`${origin}/article?fresh`);await until(isInjected);
    const injected=await worker.evaluate(()=>chrome.scripting.getRegisteredContentScripts());assert.equal(injected[0].id,'selection-listener');
  });
  await step('Invalid model output leaves original text, exposes failure and retries only failed batches',async()=>{
    await rpc('cache:clear');behavior='invalid';await act('start');await complete();assert.equal(await page.locator('#plain').textContent(),'Hello world.');assert.ok((await status()).failed>0);
    behavior='normal';await act('retry');await complete();assert.equal(await page.locator('#plain').textContent(),'你好，世界。');assert.equal((await status()).failed,0);await act('restore');
  });
  await step('Late response cannot overwrite newer website content',async()=>{
    await rpc('cache:clear');delay=500;await act('start');await until(()=>requests.at(-1)?.blocks.some(b=>b.segments.some(s=>s.text==='Original content.')));
    await page.locator('#changing').evaluate(el=>{el.textContent='Updated by the website.';});await complete();await until(async()=>await page.locator('#changing').textContent()==='网站更新了内容。');
    await act('restore');assert.equal(await page.locator('#changing').textContent(),'Updated by the website.');delay=0;
  });
  await step('Output truncation automatically subdivides without writing incomplete translations',async()=>{
    await rpc('cache:clear');behavior='truncate';await act('start');await complete();assert.equal((await status()).failed,0);assert.equal(await page.locator('#plain').textContent(),'你好，世界。');await act('restore');behavior='normal';
  });
  await step('Stop cancels requests and prevents later DOM writes',async()=>{
    await rpc('cache:clear');delay=700;const before=requests.length;await act('start');await until(()=>requests.length>before);await act('stop');await new Promise(resolve=>setTimeout(resolve,900));assert.equal((await status()).state,'stopped');assert.equal(await page.locator('#plain').textContent(),'Hello world.');await act('restore');delay=0;
  });
  await step('Model markup is inserted as plain text and never executes',async()=>{
    await rpc('cache:clear');behavior='html';await act('start');await complete();assert.equal(await page.locator('img').count(),0);assert.equal(await page.evaluate(()=>globalThis.hacked),undefined);assert.match(await page.locator('h1').textContent(),/<img/);await act('restore');behavior='normal';
  });
  await step('API authentication error is visible and preserves page',async()=>{
    await rpc('cache:clear');behavior='auth';await act('start');await complete();assert.match((await status()).message,/API Key/);assert.equal(await page.locator('#plain').textContent(),'Hello world.');await act('restore');behavior='normal';
  });
  await step('Cache prevents repeated successful requests and contains no API key',async()=>{
    await rpc('cache:clear');await act('start');await complete();await act('restore');const before=requests.length;await act('start');await complete();assert.equal(requests.length,before);
    const cached=await worker.evaluate(()=>chrome.storage.session.get('translationCache'));assert.ok(!JSON.stringify(cached).includes('test-key-not-a-real-secret'));await act('restore');
  });
  await step('Restored pages reuse paragraphs after scrolling, reordering, additions and edits',async()=>{
    const before=requests.length;
    await page.evaluate(()=>{
      const p=document.createElement('p');p.id='cache-added';p.textContent='A newly added cache paragraph.';document.body.prepend(p);
      document.body.append(document.querySelector('#plain'));
      document.querySelector('#changing').textContent='A changed cache paragraph.';
      window.scrollTo(0,document.body.scrollHeight);
    });
    await act('start');await complete();
    const texts=requests.slice(before).flatMap(r=>r.blocks.flatMap(b=>b.segments.map(s=>s.text)));
    assert.deepEqual(texts.sort(),['A newly added cache paragraph.','A changed cache paragraph.'].sort());
    assert.equal(await page.locator('#plain').textContent(),'你好，世界。');
    assert.equal(await page.locator('#cache-added').textContent(),'译：A newly added cache paragraph.');
    await act('restore');await page.evaluate(()=>window.scrollTo(0,0));
    const repeat=requests.length;await act('start');await complete();assert.equal(requests.length,repeat);await act('restore');
  });
  await step('Content script cannot read API configuration storage',async()=>{
    const result=await worker.evaluate(async(id)=>await chrome.scripting.executeScript({target:{tabId:id},func:async()=>{try{return await chrome.storage.local.get('settings');}catch{return 'denied';}}}),tabId);
    assert.ok(result[0].result==='denied'||!result[0].result.settings);
  });
  await step('Background suspension preserves settings and cache without requiring a permanently alive worker',async()=>{
    const session=await context.newCDPSession(ui),versions=new Map();
    session.on('ServiceWorker.workerVersionUpdated',event=>{for(const v of event.versions)versions.set(v.versionId,v);});await session.send('ServiceWorker.enable');
    await until(()=>[...versions.values()].some(v=>v.scriptURL===worker.url()));const version=[...versions.values()].find(v=>v.scriptURL===worker.url());
    const backgroundUrl=worker.url();await worker.evaluate(()=>chrome.storage.session.set({jobHistory:{'forced-interruption':{state:'running',time:Date.now()}}}));
    await session.send('ServiceWorker.stopWorker',{versionId:version.versionId});await until(()=>versions.get(version.versionId).runningStatus==='stopped');
    const config=await rpc('settings:get');await until(()=>versions.get(version.versionId).runningStatus==='running');worker=context.serviceWorkers().find(w=>w.url()===backgroundUrl)??worker;assert.equal(config.profiles[0].model,'mock-translator');
    const metadata=await worker.evaluate(()=>chrome.storage.session.get('jobHistory'));assert.equal(metadata.jobHistory['forced-interruption'].state,'interrupted');
    const before=requests.length;await act('start');await complete();assert.equal(requests.length,before);await act('restore');await session.detach();
  });
  await step('100K-character page scan and render remain responsive with bounded script footprint',async()=>{
    await page.goto(`${origin}/article?performance`);await until(isInjected);
    await page.evaluate(()=>{document.body.replaceChildren();for(let i=0;i<1800;i++){const p=document.createElement('p');p.textContent=`Paragraph ${i}: Clear language makes a better reading experience.`;document.body.append(p);}globalThis.longTasks=[];new PerformanceObserver(list=>globalThis.longTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:false});});
    const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
    await cdp.send('HeapProfiler.collectGarbage');const baseline=await metrics(),before=requests.length;
    const loadedChars=await page.evaluate(()=>{globalThis.longTasks=[];globalThis.firstTranslationMs=0;globalThis.translationStarted=performance.now();const p=document.querySelector('p');const first=new MutationObserver(()=>{globalThis.firstTranslationMs=performance.now()-globalThis.translationStarted;first.disconnect();});first.observe(p,{characterData:true,subtree:true});return document.body.textContent.length;});
    const start=performance.now();await act('start');await complete();const durationMs=Math.round(performance.now()-start),tasks=await page.evaluate(()=>globalThis.longTasks),firstTranslationMs=await page.evaluate(()=>globalThis.firstTranslationMs);
    await cdp.send('HeapProfiler.collectGarbage');const after=await metrics();
    const data={loadedChars,sourceChars:(await status()).chars,durationMs,firstTranslationMs:Math.round(firstTranslationMs),baselineHeapBytes:Math.round(baseline.JSHeapUsedSize),translatedHeapBytes:Math.round(after.JSHeapUsedSize),heapDeltaBytes:Math.round(after.JSHeapUsedSize-baseline.JSHeapUsedSize),longTasks:tasks,maxLongTaskMs:Math.round(Math.max(0,...tasks)),requests:requests.length-before};
    await writeFile('artifacts/performance.json',JSON.stringify(data,null,2));assert.ok((await status()).limited);assert.ok((await status()).chars<=100000);assert.equal(tasks.length,0,'No added main-thread task over 50 ms');assert.ok(data.requests<=40,'Short paragraphs must be batched to control API overhead');await act('restore');await cdp.detach();
  });
  async function videoAct(action,bilingual=true){await activate();return rpc('video:action',{action,bilingual});}
  async function captionText(){const session=await context.newCDPSession(page);try{const tree=await session.send('Accessibility.getFullAXTree');return tree.nodes.filter(n=>n.role?.value==='StaticText').map(n=>n.name?.value??'').join('\n');}finally{await session.detach();}}
  await step('Video captions load only on click, prefetch native VTT and preserve subtitle modes',async()=>{
    await page.goto(`${origin}/video`);await until(async()=>await page.locator('video').evaluate(v=>Number.isFinite(v.duration)));
    const before=requests.length;await new Promise(resolve=>setTimeout(resolve,300));assert.equal(requests.length,before);
    assert.equal(await page.evaluate(()=>!!globalThis.__siVideoTranslate),false);await activate();assert.equal((await rpc('video:status')).state,'idle');
    await activate();await popup.reload();await popup.locator('#video-start').click();
    await until(async()=> (await captionText()).includes('你好，世界。'));
    const texts=requests.slice(before).flatMap(r=>r.blocks.flatMap(b=>b.segments.map(s=>s.text)));
    assert.ok(texts.includes('Second subtitle.'));assert.ok(!texts.includes('A late subtitle.'));
    assert.equal(await page.locator('video').evaluate(v=>v.textTracks[0].mode),'hidden');
    await activate();await popup.reload();await until(async()=>await popup.locator('#video-start').textContent()==='重新开始');
    await page.screenshot({path:'artifacts/video-bilingual.png'});
  });
  await step('Fullscreen containers preserve caption overlays and page translation does not stop the video session',async()=>{
    await page.locator('#fullscreen').click();await until(async()=>await page.evaluate(()=>document.fullscreenElement?.id==='movie_player'));
    await until(async()=>await page.locator('#movie_player [data-si-owned=video]').count()===1);
    assert.ok((await captionText()).includes('你好，世界。'));
    await page.evaluate(()=>document.exitFullscreen());await act('start');await complete();assert.equal((await rpc('video:status')).state,'active');await act('restore');
  });
  await step('Video caption seek, pause, speed, bilingual switch and replay cache stay synchronized',async()=>{
    await page.locator('video').evaluate(async v=>{v.currentTime=4.8;await v.play();});await until(async()=>await page.locator('video').evaluate(v=>v.currentTime>=5.1));
    await page.locator('video').evaluate(v=>v.pause());await until(async()=> (await captionText()).includes('译：Second subtitle.'));
    await page.locator('video').evaluate(v=>v.currentTime=6);await until(async()=> (await captionText()).includes('译：Second subtitle.'));
    await page.locator('video').evaluate(v=>{v.playbackRate=2;v.pause();});const stable=await captionText();await new Promise(resolve=>setTimeout(resolve,350));assert.equal(await captionText(),stable);
    await videoAct('display',false);await until(async()=>!(await captionText()).split('\n').includes('Second subtitle.'));
    const before=requests.length;await page.locator('video').evaluate(v=>v.currentTime=1);await until(async()=> (await captionText()).includes('你好，世界。'));assert.equal(requests.length,before);
    await page.locator('video').evaluate(v=>v.currentTime=61);await until(async()=> (await captionText()).includes('译：A late subtitle.'));
    assert.ok(!((await captionText()).includes('你好，世界。')));
    await videoAct('stop');assert.equal(await page.locator('[data-si-owned=video]').count(),0);assert.equal(await page.locator('video').evaluate(v=>v.textTracks[0].mode),'disabled');
    const stopped=requests.length;await new Promise(resolve=>setTimeout(resolve,350));assert.equal(requests.length,stopped);
    await videoAct('start');await until(async()=> (await captionText()).includes('译：A late subtitle.'));assert.equal(requests.length,stopped);await videoAct('stop');
  });
  await step('Seeking and stopping drop late subtitle responses; failures retain readable source',async()=>{
    await rpc('cache:clear');await page.locator('video').evaluate(v=>{v.playbackRate=1;v.currentTime=1;});delay=500;
    const before=requests.length;await videoAct('start');await until(()=>requests.length>before);
    await page.locator('video').evaluate(v=>v.currentTime=61);await until(async()=> (await captionText()).includes('译：A late subtitle.'));
    assert.ok(!(await captionText()).includes('你好，世界。'));await videoAct('stop');delay=0;
    await rpc('cache:clear');behavior='auth';await videoAct('start');await until(async()=> (await rpc('video:status')).message.includes('API Key'));
    assert.ok((await captionText()).includes('A late subtitle.'));await new Promise(resolve=>setTimeout(resolve,1100));assert.match((await rpc('video:status')).message,/API Key/);behavior='normal';await videoAct('retry');await until(async()=> (await captionText()).includes('译：A late subtitle.'));await videoAct('stop');
  });
  await step('Unsupported videos explain missing captions and dynamic player removal releases overlays',async()=>{
    await page.locator('video').evaluate(v=>v.querySelector('track').remove());const unsupported=await videoAct('start');assert.equal(unsupported.state,'error');assert.match(unsupported.message,/没有可读取的字幕/);assert.equal(await page.locator('[data-si-owned=video]').count(),0);
    await page.goto(`${origin}/video`);await until(async()=>await page.locator('video').evaluate(v=>Number.isFinite(v.duration)));await videoAct('start');await until(async()=>await page.locator('[data-si-owned=video]').count()===1);
    await page.locator('video').evaluate(v=>v.remove());await until(async()=> (await rpc('video:status')).state==='stopped');assert.equal(await page.locator('[data-si-owned=video]').count(),0);
  });
  await step('YouTube visible-caption adapter translates caption changes and releases on SPA video switch',async()=>{
    const html=videoFixture.replace('src="/silence.wav"',`src="${origin}/silence.wav"`).replace(/<track[^>]*>/,'');
    await context.route('https://www.youtube.com/watch*',route=>route.fulfill({contentType:'text/html',body:html}));
    await page.goto('https://www.youtube.com/watch?v=fixture');await activate();
    const before=requests.length;await videoAct('start');assert.equal(requests.length,before);
    await page.locator('.ytp-caption-segment').evaluate(e=>e.textContent='Hello world.');await until(async()=> (await captionText()).includes('你好，世界。'));
    await act('start');await complete();assert.equal(await page.locator('.ytp-caption-segment').textContent(),'Hello world.');await act('restore');
    await page.locator('.ytp-caption-segment').evaluate(e=>e.textContent='English and 日本語 mixed.');await until(async()=> (await captionText()).includes('英语和日语混合。'));
    await page.locator('.ytp-caption-window-container').evaluate(e=>e.style.display='none');await until(async()=>await page.locator('[data-si-owned=video]').isHidden());
    await page.evaluate(()=>history.pushState({},'','/watch?v=another'));await until(async()=> (await rpc('video:status')).state==='stopped');assert.equal(await page.locator('[data-si-owned=video]').count(),0);
    await context.unroute('https://www.youtube.com/watch*');
  });
  assert.deepEqual(browserErrors,[]);await writeFile('artifacts/browser-tests.json',JSON.stringify({passed:results.length,tests:results},null,2));
  console.log(`${results.length} browser tests passed. Screenshots and performance report: artifacts/`);
}catch(error){await writeFile('artifacts/browser-tests.json',JSON.stringify({passed:results.length,tests:results,error:error.stack,browserErrors},null,2));await page.screenshot({path:'artifacts/failure.png'}).catch(()=>{});throw error;}
finally{await context.close();await new Promise(resolve=>server.close(resolve));}
