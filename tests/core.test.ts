import {test} from 'node:test';
import assert from 'node:assert/strict';
import {endpointFor,validateSettings,validateInput,parseSegments} from '../src/core/validation.ts';
import {DEFAULT_SETTINGS,type TranslationInput} from '../src/core/types.ts';
import {Scheduler} from '../src/core/scheduler.ts';
import {TranslationCache,cacheKey} from '../src/core/cache.ts';
import {CompatibleAdapter,readSSE} from '../src/core/provider.ts';
import {SharedWork} from '../src/core/shared.ts';
import {estimateOutputTokens} from '../src/core/text.ts';
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
