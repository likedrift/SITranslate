import {test} from 'node:test';
import assert from 'node:assert/strict';
import {endpointFor,validateSettings,validateInput,parseSegments} from '../src/core/validation.ts';
import {DEFAULT_SETTINGS,EMPTY_STATUS,EMPTY_VIDEO_STATUS,NO_VIDEO_CAPTION_MESSAGE,isPageStatus,isVideoStatus,pageStatusOrIdle,videoStatusOrEmpty,type TranslationInput} from '../src/core/types.ts';
import {Scheduler} from '../src/core/scheduler.ts';
import {TranslationCache,cacheKey} from '../src/core/cache.ts';
import {CompatibleAdapter,ProviderError,RateLimitError,readSSE,retryDelayMs} from '../src/core/provider.ts';
import {isRateLimitPayload,RATE_LIMIT_BACKOFF_MS,rateLimitBackoffMs,RETRYABLE_BACKOFF_MS} from '../src/core/rate-limit.ts';
import {SharedWork} from '../src/core/shared.ts';
import {estimateOutputTokens} from '../src/core/text.ts';
import {cueIndex,activeSubtitle,subtitleText} from '../src/core/subtitles.ts';
const input:TranslationInput={kind:'page',profileId:'deepseek-default',taskId:'task',requestId:'request',target:'zh-Hans',blocks:[{id:'b1',context:'Read documentation carefully.',segments:[{id:'s1',text:'Read '},{id:'s2',text:'documentation'},{id:'s3',text:' carefully.'}]}]};
test('batch heuristic reserves more output room for CJK and segment identifiers',()=>{
  assert.ok(estimateOutputTokens('日本語'.repeat(300))>estimateOutputTokens('English'.repeat(130)));
  assert.ok(estimateOutputTokens('文'.repeat(1000))<=1800);
});
test('endpoint normalization permits HTTPS and loopback; rejects credentials and insecure remote destinations',()=>{
  assert.equal(endpointFor('https://api.example.com/v1/').url,'https://api.example.com/v1/chat/completions');
  assert.equal(endpointFor('https://api.example.com/v1/chat/completions').url,'https://api.example.com/v1/chat/completions');
  assert.equal(endpointFor('http://127.0.0.1:8123/v1').url,'http://127.0.0.1:8123/v1/chat/completions');
  assert.throws(()=>endpointFor('http://example.com'));assert.throws(()=>endpointFor('https://key:secret@example.com'));assert.throws(()=>endpointFor('https://example.com?key=secret'));
});
test('settings validate active profile and resource bounds',()=>{
  validateSettings(structuredClone(DEFAULT_SETTINGS));
  assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,activeProfileId:'missing'}));
  assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,maxPageChars:Infinity}));
  assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,target:'invalid'}));
  assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,profiles:[DEFAULT_SETTINGS.profiles[0],DEFAULT_SETTINGS.profiles[0]]}));
});
test('model output is mapped by IDs, and missing, duplicate or excessive outputs fail safely',()=>{
  const result=parseSegments(JSON.stringify({segments:[{id:'s3',text:'。'},{id:'s1',text:'仔细阅读'},{id:'s2',text:'文档'}]}),input.blocks);
  assert.deepEqual(result.map(s=>s.id),['s1','s2','s3']);
  assert.throws(()=>parseSegments('{"segments":[{"id":"s1","text":"译文"}]}',input.blocks));
  assert.throws(()=>parseSegments('{"segments":[{"id":"s1","text":"译文"},{"id":"s1","text":"另一译文"}]}',input.blocks));
  assert.throws(()=>parseSegments('not json',input.blocks));
  assert.throws(()=>parseSegments(JSON.stringify({segments:[{id:'s1',text:'x'.repeat(600)},{id:'s2',text:'ok'},{id:'s3',text:'ok'}]}),input.blocks));
});
test('batch input rejects duplicate IDs and unbounded text before network',()=>{
  validateInput(input);
  assert.throws(()=>validateInput({...input,blocks:[...input.blocks,...input.blocks]}));
  assert.throws(()=>validateInput({...input,blocks:[{id:'b',context:'',segments:[{id:'s',text:'x'.repeat(5001)}]}]}));
});
test('cache key includes model, target and context, remaps IDs, and evicts least recently used entries',async()=>{
  const profile=DEFAULT_SETTINGS.profiles[0];const key=await cacheKey(profile,input);
  assert.notEqual(key,await cacheKey({...profile,model:'other'},input));
  assert.notEqual(key,await cacheKey(profile,{...input,target:'ja'}));
  assert.notEqual(key,await cacheKey(profile,{...input,blocks:[{...input.blocks[0],context:'Different meaning'}]}));
  const c=new TranslationCache(110);c.put('one',['first']);c.put('two',['second']);
  assert.equal(c.get('one',{...input,blocks:[{id:'b',context:'',segments:[{id:'new',text:'source'}]}]})?.segments[0].id,'new');
  c.put('three',['third'.repeat(6)]);assert.ok(c.size().bytes<=110);assert.equal(c.get('two',input),undefined);
});
test('paragraph cache survives regrouping and reordering, while changed text and context miss',async()=>{
  const profile=DEFAULT_SETTINGS.profiles[0],cache=new TranslationCache();
  const first=await cache.lookupBlocks(profile,input);
  cache.putBlocks(first.keys,input,{segments:input.blocks[0].segments.map(s=>({id:s.id,text:`translated ${s.text}`})),cached:false,usage:{input:1,output:1,estimatedCost:0}});
  const old={...input.blocks[0],id:'new-block',segments:input.blocks[0].segments.map((s,i)=>({...s,id:`new-${i}`}))};
  const added={id:'added',context:'New paragraph.',segments:[{id:'new-text',text:'New paragraph.'}]};
  const next={...input,blocks:[added,old]};
  const found=await cache.lookupBlocks(profile,next);
  assert.deepEqual(found.missing,[added]);assert.deepEqual(found.segments.map(s=>s.id),old.segments.map(s=>s.id));
  const changed={...old,segments:old.segments.map((s,i)=>i? s:{...s,text:'Changed text'})};
  assert.equal((await cache.lookupBlocks(profile,{...input,blocks:[changed]})).missing.length,1);
  assert.equal((await cache.lookupBlocks(profile,{...input,blocks:[{...old,context:'Changed meaning'}]})).missing.length,1);
  assert.equal((await cache.lookupBlocks(profile,{...input,target:'ja',blocks:[old]})).missing.length,1);
  assert.equal((await cache.lookupBlocks({...profile,model:'another'},input)).missing.length,1);
  const restarted=new TranslationCache();restarted.load(cache.snapshot());
  assert.equal((await restarted.lookupBlocks(profile,{...input,blocks:[old]})).missing.length,0);
});
test('only complete successful blocks enter the cache, preserving earlier successful translations',async()=>{
  const profile=DEFAULT_SETTINGS.profiles[0],cache=new TranslationCache();
  const second={id:'second',context:'',segments:[{id:'second-text',text:'Second paragraph'}]};
  const combined={...input,blocks:[...input.blocks,second]},lookup=await cache.lookupBlocks(profile,combined);
  cache.putBlocks(lookup.keys,combined,{segments:input.blocks[0].segments.map(s=>({id:s.id,text:'译文'})),cached:false,usage:{input:0,output:0,estimatedCost:0}});
  const restored=await cache.lookupBlocks(profile,combined);assert.deepEqual(restored.missing,[second]);
  cache.clear();assert.equal((await cache.lookupBlocks(profile,combined)).missing.length,2);
});
test('scheduler keeps bounded concurrency, prioritizes selections, and cancels queued work',async()=>{
  const scheduler=new Scheduler(1);const events:string[]=[];let release!:()=>void;
  const first=scheduler.enqueue(0,new AbortController().signal,()=>new Promise<string>(resolve=>{release=()=>resolve('first');events.push('first');}));
  await Promise.resolve();
  const cancelled=new AbortController();let ran=false;
  const cancel=scheduler.enqueue(0,cancelled.signal,async()=>{ran=true;return 'cancelled';});const rejected=assert.rejects(cancel,{name:'AbortError'});
  const page=scheduler.enqueue(0,new AbortController().signal,async()=>{events.push('page');return 'page';});
  const selection=scheduler.enqueue(10,new AbortController().signal,async()=>{events.push('selection');return 'selection';});
  cancelled.abort();release();await Promise.all([first,page,selection,rejected]);assert.equal(ran,false);assert.deepEqual(events,['first','selection','page']);
});
const flushScheduler=()=>new Promise(resolve=>setTimeout(resolve,0));
test('live requests enter while page jobs hold both shared slots',async()=>{
  const scheduler=new Scheduler(2);
  let releasePages!:()=>void;
  const held=new Promise<string>(resolve=>{releasePages=()=>resolve('page');});
  const pages=[0,1].map(()=>scheduler.enqueue(0,new AbortController().signal,()=>held));
  await flushScheduler();
  const shared:string[]=[];
  const video=scheduler.enqueue(10,new AbortController().signal,async()=>{shared.push('video');return 'video';});
  const selection=scheduler.enqueue(20,new AbortController().signal,async()=>{shared.push('selection');return 'selection';});
  const started=performance.now();
  let entered=0;
  const live=scheduler.enqueue(10,new AbortController().signal,async()=>{entered=performance.now();return 'live';},'live');
  assert.equal(await live,'live');
  const schedulerMs=entered-started;
  assert.ok(schedulerMs>=0&&schedulerMs<50,`schedulerMs ${schedulerMs}`);
  assert.deepEqual(shared,[]);
  releasePages();
  assert.equal(await selection,'selection');
  assert.equal(await video,'video');
  await Promise.all(pages);
  assert.deepEqual(shared,['selection','video']);
});
test('live lane stays ordered behind its own in-flight request and does not widen the shared pool',async()=>{
  const scheduler=new Scheduler(2);
  let active=0,maxActive=0;let releaseShared!:()=>void;
  const sharedGate=new Promise<void>(resolve=>{releaseShared=resolve;});
  const track=()=>async()=>{active++;maxActive=Math.max(maxActive,active);await sharedGate;active--;return 'shared';};
  const pages=[0,1,2].map(()=>scheduler.enqueue(0,new AbortController().signal,track()));
  await flushScheduler();
  const order:string[]=[];
  let releaseFirst!:(value:string)=>void;
  const first=scheduler.enqueue(0,new AbortController().signal,()=>{order.push('first');active++;maxActive=Math.max(maxActive,active);return new Promise<string>(resolve=>{releaseFirst=value=>{active--;resolve(value);};});},'live');
  await flushScheduler();
  assert.equal(active,3);assert.equal(maxActive,3);assert.deepEqual(order,['first']);
  const earlier=scheduler.enqueue(0,new AbortController().signal,async()=>{order.push('earlier');return 'earlier';},'live');
  const later=scheduler.enqueue(100,new AbortController().signal,async()=>{order.push('later');return 'later';},'live');
  await flushScheduler();
  assert.deepEqual(order,['first']);assert.equal(maxActive,3);
  releaseFirst('first');
  assert.equal(await first,'first');
  assert.equal(await earlier,'earlier');
  assert.equal(await later,'later');
  assert.deepEqual(order,['first','earlier','later']);
  releaseShared();
  await Promise.all(pages);
  assert.equal(active,0);assert.equal(maxActive,3);
});
test('cancelling or aborting a live request frees only the live slot',async()=>{
  const scheduler=new Scheduler(1);
  let releasePage!:()=>void;
  const page=scheduler.enqueue(0,new AbortController().signal,()=>new Promise<string>(resolve=>{releasePage=()=>resolve('page');}));
  await flushScheduler();
  const already=new AbortController();already.abort();let skipped=false;
  await assert.rejects(scheduler.enqueue(10,already.signal,async()=>{skipped=true;return 'no';},'live'),{name:'AbortError'});
  assert.equal(skipped,false);
  let releaseFirst!:(value:string)=>void;
  const first=scheduler.enqueue(10,new AbortController().signal,()=>new Promise<string>(resolve=>{releaseFirst=resolve;}),'live');
  await flushScheduler();
  const cancelled=new AbortController();let queuedRan=false;
  const queued=scheduler.enqueue(10,cancelled.signal,async()=>{queuedRan=true;return 'queued';},'live');
  const queuedRejected=assert.rejects(queued,{name:'AbortError'});
  cancelled.abort();
  releaseFirst('first');
  assert.equal(await first,'first');
  await queuedRejected;
  assert.equal(queuedRan,false);
  const running=new AbortController();
  const inflight=scheduler.enqueue(10,running.signal,()=>new Promise((_resolve,reject)=>{running.signal.addEventListener('abort',()=>reject(new DOMException('已取消','AbortError')));}),'live');
  const inflightRejected=assert.rejects(inflight,{name:'AbortError'});
  await flushScheduler();
  running.abort();
  await inflightRejected;
  const started=performance.now();let entered=0;
  const next=scheduler.enqueue(10,new AbortController().signal,async()=>{entered=performance.now();return 'next';},'live');
  assert.equal(await next,'next');
  assert.ok(entered-started<50,`schedulerMs ${entered-started}`);
  releasePage();
  assert.equal(await page,'page');
});
test('SSE survives arbitrary byte boundaries, UTF-8 text, CRLF, and usage-only frames',async()=>{
  const content='{"segments":[{"id":"s","text":"你好🌏"}]}';
  const wire=`data: ${JSON.stringify({choices:[{delta:{content}}]})}\r\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8}}\n\ndata: [DONE]\n\n`;
  const bytes=new TextEncoder().encode(wire);const stream=new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close();}});
  const result=await readSSE(new Response(stream),new AbortController().signal);assert.equal(result.content,content);assert.equal(result.usage.prompt_tokens,12);
});
test('identical requests share work, and cancelling one page does not cancel another subscriber',async()=>{
  const shared=new SharedWork<string>(),first=new AbortController(),second=new AbortController();let calls=0,networkAborted=false,release!:()=>void;
  const run=(signal:AbortSignal)=>{calls++;signal.addEventListener('abort',()=>networkAborted=true);return new Promise<string>(resolve=>{release=()=>resolve('translation');});};
  const a=shared.run('same',first.signal,run),b=shared.run('same',second.signal,run);const rejected=assert.rejects(a,{name:'AbortError'});await Promise.resolve();first.abort();release();
  const result=await b;await rejected;assert.equal(calls,1);assert.equal(networkAborted,false);assert.equal(result.value,'translation');assert.equal(result.shared,true);
});
test('cancelling every subscriber aborts the shared network request',async()=>{
  const shared=new SharedWork<string>(),controller=new AbortController();let network:AbortSignal|undefined;
  const promise=shared.run('work',controller.signal,signal=>{network=signal;return new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')));});});
  const rejected=assert.rejects(promise,{name:'AbortError'});await Promise.resolve();controller.abort();await rejected;assert.equal(network?.aborted,true);
});
test('provider uses configured endpoint and parameters and never returns reasoning as translation',async()=>{
  const original=globalThis.fetch;let request:any;
  globalThis.fetch=(async(url,options)=>{request={url,options};return new Response(JSON.stringify({choices:[{message:{reasoning_content:'private thoughts',content:JSON.stringify({segments:input.blocks[0].segments.map(s=>({id:s.id,text:'译文'}))})}}],usage:{prompt_tokens:100,completion_tokens:20}}),{headers:{'content-type':'application/json'}});})as typeof fetch;
  try{const result=await new CompatibleAdapter().translate({...DEFAULT_SETTINGS.profiles[0],apiKey:'test-only',stream:false,inputPrice:1,outputPrice:2},input,new AbortController().signal);
    assert.equal(result.segments.length,3);assert.equal(result.usage.estimatedCost,0.00014);assert.equal(request.url,'https://api.deepseek.com/chat/completions');assert.equal(request.options.credentials,'omit');assert.equal(request.options.redirect,'error');const body=JSON.parse(request.options.body);assert.deepEqual(body.thinking,{type:'disabled'});assert.match(body.messages[0].content,/untrusted data/);
  }finally{globalThis.fetch=original;}
});
test('authentication failure is actionable, non-retryable, and does not expose provider response or key',async()=>{
  const original=globalThis.fetch;globalThis.fetch=(async()=>new Response('secret-provider-diagnostic',{status:401}))as typeof fetch;
  try{await assert.rejects(new CompatibleAdapter().translate({...DEFAULT_SETTINGS.profiles[0],apiKey:'secret'},input,new AbortController().signal),error=>error instanceof Error&&/API Key/.test(error.message)&&!error.message.includes('secret-provider'));
  }finally{globalThis.fetch=original;}
});
test('429 and equivalent rate-limit bodies back off once, without echoing the provider payload',async()=>{
  assert.equal(isRateLimitPayload(429,''),true);
  assert.equal(isRateLimitPayload(401,'rate limit secret'),false);
  assert.equal(isRateLimitPayload(402,'{"error":{"code":"insufficient_quota"}}'),false);
  assert.equal(isRateLimitPayload(400,'{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded"}}'),true);
  assert.equal(isRateLimitPayload(503,'{"code":"Throttling.RateQuota","message":"Requests rate limit exceeded"}'),true);
  assert.equal(isRateLimitPayload(500,'upstream unavailable'),false);
  assert.equal(retryDelayMs(new RateLimitError(),0),RATE_LIMIT_BACKOFF_MS);
  assert.equal(retryDelayMs(new RateLimitError(),1),undefined);
  assert.equal(retryDelayMs(new ProviderError('模型服务暂不可用（503）。',true),0),RETRYABLE_BACKOFF_MS);
  assert.equal(retryDelayMs(new ProviderError('API Key 无效，请在设置中更新。'),0),undefined);
  assert.equal(rateLimitBackoffMs(0),2000);assert.equal(rateLimitBackoffMs(1),4000);assert.equal(rateLimitBackoffMs(4),8000);
  const original=globalThis.fetch;
  const profile={...DEFAULT_SETTINGS.profiles[0],apiKey:'secret',stream:false};
  const hidden=(error:unknown)=>error instanceof RateLimitError&&error.retryable&&error.rateLimited&&error.message==='请求过于频繁，请稍后再试。'&&!/secret|sk-live/.test(error.message);
  try{
    globalThis.fetch=(async()=>new Response('{"error":{"message":"secret sk-live rate limit"}}',{status:429}))as typeof fetch;
    await assert.rejects(new CompatibleAdapter().translate(profile,input,new AbortController().signal),hidden);
    globalThis.fetch=(async()=>new Response('{"code":"Throttling.RateQuota","message":"secret sk-live"}',{status:503}))as typeof fetch;
    await assert.rejects(new CompatibleAdapter().translate(profile,input,new AbortController().signal),hidden);
    globalThis.fetch=(async()=>new Response('bad gateway',{status:502}))as typeof fetch;
    await assert.rejects(new CompatibleAdapter().translate(profile,input,new AbortController().signal),error=>error instanceof ProviderError&&!(error instanceof RateLimitError)&&error.retryable);
    const wire='data: {"error":{"message":"secret sk-live","type":"rate_limit_error","code":"rate_limit_exceeded"}}\n\n';
    await assert.rejects(readSSE(new Response(wire),new AbortController().signal),hidden);
    await assert.rejects(readSSE(new Response('data: {"error":{"message":"secret model missing"}}\n\n'),new AbortController().signal),error=>error instanceof ProviderError&&!(error instanceof RateLimitError)&&!error.retryable&&!String(error.message).includes('secret'));
  }finally{globalThis.fetch=original;}
});
test('subtitle timeline handles seeking, overlapping cues and exclusive end boundaries',()=>{
  const cues=[{id:'one',start:0,end:5,text:'one',context:''},{id:'two',start:3,end:8,text:'two',context:''}];
  assert.deepEqual(activeSubtitle(cues,4).map(c=>c.id),['one','two']);assert.deepEqual(activeSubtitle(cues,5).map(c=>c.id),['two']);
  assert.deepEqual(activeSubtitle(cues,8),[]);assert.equal(cueIndex([{startTime:0},{startTime:3},{startTime:8}],4),2);
  assert.equal(subtitleText(' one\n  two '),'one two');assert.equal(subtitleText('a'.repeat(3000)).length,2000);
});
test('truncated output splits into bounded smaller requests and accounts for all received usage',async()=>{
  const original=globalThis.fetch,requests:any[]=[];
  globalThis.fetch=(async(_url,options)=>{
    const body=JSON.parse(String(options?.body));requests.push(body);const segments=JSON.parse(body.messages[1].content).blocks.flatMap((b:any)=>b.segments);
    const truncated=segments.length>1;
    return new Response(JSON.stringify({choices:[{finish_reason:truncated?'length':'stop',message:{content:truncated?'{"segments":[':JSON.stringify({segments:segments.map((s:any)=>({id:s.id,text:'译文'}))})}}],usage:{prompt_tokens:10,completion_tokens:5}}));
  }) as typeof fetch;
  try{
    const result=await new CompatibleAdapter().translate({...DEFAULT_SETTINGS.profiles[0],stream:false},input,new AbortController().signal);
    assert.deepEqual(result.segments.map(s=>s.id),['s1','s2','s3']);assert.equal(requests.length,5);assert.equal(result.usage.input,50);assert.equal(result.usage.requests,5);
    assert.ok(requests.every(r=>r.max_tokens>=1024&&r.max_tokens<=8192));
  }finally{globalThis.fetch=original;}
});
test('malformed responses stop after bounded subdivision and authentication is never subdivided',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=(async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:'{bad json'}}]}));}) as typeof fetch;
  try{
    await assert.rejects(new CompatibleAdapter().translate({...DEFAULT_SETTINGS.profiles[0],stream:false},input,new AbortController().signal),/不完整/);assert.ok(calls<=3);
    calls=0;globalThis.fetch=(async()=>{calls++;return new Response('',{status:401});}) as typeof fetch;
    await assert.rejects(new CompatibleAdapter().translate(DEFAULT_SETTINGS.profiles[0],input,new AbortController().signal),/API Key/);assert.equal(calls,1);
  }finally{globalThis.fetch=original;}
});
test('empty or invalid status replies become idle and valid replies stay unchanged',()=>{
  const live={state:'translating' as const,total:4,completed:2,failed:0,chars:20,limited:false,message:'正在翻译',display:'bilingual' as const};
  const stored={state:'done' as const,total:5,completed:4,failed:1,chars:80,limited:true,message:'已完成',display:'replace' as const};
  assert.equal(isPageStatus(live),true);
  assert.equal(pageStatusOrIdle(live,stored),live);
  assert.equal(isPageStatus({...live,message:'长'.repeat(401)}),true);
  const idle=pageStatusOrIdle(undefined,stored);
  assert.deepEqual(idle,{...stored,state:'idle',message:''});
  assert.equal(pageStatusOrIdle(null,{total:4,completed:2}).total,4);
  assert.equal(pageStatusOrIdle(false,{total:-1,completed:1}).total,0);
  for(const empty of [undefined,null,false,true,0,'',{},{state:'idle'},{state:'translating',total:1},{...live,state:'nope'}]){
    const page=pageStatusOrIdle(empty);
    assert.equal(page.state,'idle');assert.equal(page.message,'');assert.equal(page.total,0);
  }
  const fresh=pageStatusOrIdle(undefined);fresh.total=9;assert.equal(pageStatusOrIdle(null).total,0);
  assert.deepEqual(pageStatusOrIdle({...EMPTY_STATUS,state:'scanning'}),{...EMPTY_STATUS,state:'scanning'});
  const video={state:'error' as const,source:'',completed:0,message:NO_VIDEO_CAPTION_MESSAGE,bilingual:true};
  assert.equal(isVideoStatus(video),true);assert.equal(videoStatusOrEmpty(video),video);
  const active={state:'active' as const,source:'YouTube 当前字幕',completed:3,message:'请在 YouTube 播放器中开启字幕；仅翻译当前显示的内容。',bilingual:false};
  assert.equal(videoStatusOrEmpty(active),active);
  for(const empty of [undefined,null,false,true,{},{state:'active'},{...active,bilingual:'yes'}]){
    const status=videoStatusOrEmpty(empty);
    assert.equal(status.state,'idle');assert.equal(status.message,EMPTY_VIDEO_STATUS.message);assert.equal(status.completed,0);assert.equal(status.bilingual,true);
  }
  const blank=videoStatusOrEmpty(undefined);blank.state='active';assert.equal(videoStatusOrEmpty(null).state,'idle');
});
test('SSE retains length termination even when usage arrives in a separate frame',async()=>{
  const wire='data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":5}}\n\ndata: [DONE]\n\n';
  const result=await readSSE(new Response(wire),new AbortController().signal);assert.equal(result.finishReason,'length');assert.equal(result.usage.prompt_tokens,5);
});
