import {EMPTY_STATUS, type PublicConfig, type PageStatus, type TextBlock, type TranslationResult, type DisplayMode} from './core/types';
import {estimateOutputTokens} from './core/text';

// Isolated-world singleton: repeated injection must not add listeners or lose restore records.
const scope=globalThis as typeof globalThis & {__siTranslate?:boolean};
if(!scope.__siTranslate){scope.__siTranslate=true;boot();}

function boot(){
  const blocked='script,style,noscript,code,pre,kbd,samp,textarea,input,select,option,svg,math,canvas,video,audio,track,.ytp-caption-window-container,[contenteditable]:not([contenteditable="false"]),[translate="no"],[hidden],[aria-hidden="true"],[data-si-owned]';
  const selectionBlocked='input,textarea,select,[contenteditable]:not([contenteditable="false"]),[data-si-owned]';
  const blockSelector='p,h1,h2,h3,h4,h5,h6,li,td,th,dt,dd,button,label,figcaption,blockquote,summary,caption';
  interface Record {node:Text;source:string;applied:string;ids:string[];texts:Map<string,string>;root:Element;annotation?:HTMLElement;version:number;state:'queued'|'translated'|'failed'}
  interface Work {block:TextBlock;records:Record[];version:number;priority:number;attempted:boolean;tokens:number}
  let config:PublicConfig|undefined,taskId='',generation=0,startToken=0,sequence=0,active=false,processing=false;
  let status:PageStatus={...EMPTY_STATUS},observer:MutationObserver|undefined,muted=0;
  const records=new Map<Text,Record>();let pending:Work[]=[];const failed:Work[]=[];
  const changed=new Set<Node>();let mutationTimer:ReturnType<typeof setTimeout>|undefined,statusTimer:ReturnType<typeof setTimeout>|undefined;
  let observedShadows=new WeakSet<ShadowRoot>();
  const observeOptions:MutationObserverInit={childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['hidden','open','aria-hidden','class','style','translate']};
  let panelHost:HTMLElement|undefined,panelRoot:ShadowRoot|undefined,selectionText='',selectionContext='',selectionTask='',selectionRequest='',selectionAnchor:DOMRect|undefined;
  let selectionRange:Range|undefined,selectionRoots:ShadowRoot[]=[],selectionPoint:{x:number;y:number}|undefined,selectionBackward=false;
  let selectionTimer:ReturnType<typeof setTimeout>|undefined,selectionPhase:'button'|'loading'|'result'='button';
  let selectionEnabled=false;
  async function refreshSelection(){try{const state=await message<{enabled:boolean}>({type:'selection:state'});selectionEnabled=state.enabled;if(!selectionEnabled)closePanel();}catch{selectionEnabled=false;}}

  async function message<T=unknown>(value:unknown):Promise<T>{
    let response;try{response=await chrome.runtime.sendMessage(value);}catch{throw new Error('扩展连接中断，请重新打开页面或点击重试。');}
    if(!response?.ok)throw new Error(response?.error??'翻译连接中断，请重试。');return response.data as T;
  }
  function publish(immediate=false){
    if(statusTimer)clearTimeout(statusTimer);
    const send=()=>{statusTimer=undefined;message({type:'page:status',status}).catch(()=>{});};
    if(immediate)send();else statusTimer=setTimeout(send,180);
  }
  const yieldThread=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
  function isBlocked(element:Element,selector:string){let current:Element|undefined=element;while(current){if(current.closest(selector))return true;const root=current.getRootNode();current=root instanceof ShadowRoot?root.host:undefined;}return false;}
  function mutedWrite(fn:()=>void){muted++;try{fn();}finally{muted--;}}
  function same(record:Record,version:number){return record.node.isConnected&&record.version===version&&record.node.data===record.applied;}
  function split(text:string,max=1000){const pieces:string[]=[];let remaining=text;while(remaining.length>max){let cut=Math.max(remaining.lastIndexOf(' ',max),remaining.lastIndexOf('\n',max));if(cut<max*.6)cut=max;if(/[\uD800-\uDBFF]/.test(remaining.charAt(cut-1)))cut--;pieces.push(remaining.slice(0,cut));remaining=remaining.slice(cut);}if(remaining)pieces.push(remaining);return pieces;}
  function translatedValue(record:Record){
    const sourceParts=split(record.source);
    return record.ids.map((id,i)=>(sourceParts[i].match(/^\s*/)?.[0]??'')+(record.texts.get(id)??'').trim()+(sourceParts[i].match(/\s*$/)?.[0]??'')).join('');
  }
  function renderRecord(record:Record,display:DisplayMode){
    if(!same(record,record.version)||record.texts.size!==record.ids.length)return;
    const translation=translatedValue(record);
    mutedWrite(()=>{
      record.annotation?.remove();record.annotation=undefined;
      if(display==='replace'){record.node.data=translation;record.applied=translation;}
      else {
        record.node.data=record.source;record.applied=record.source;
        const span=document.createElement('span');span.dataset.siOwned='translation';span.lang=config?.target??'zh-Hans';
        span.textContent=`［${translation.trim()}］`;span.style.cssText='color:inherit;opacity:.78;margin-inline-start:.35em;font-size:.94em;overflow-wrap:anywhere;';
        record.node.after(span);record.annotation=span;
      }
    });record.state='translated';
  }
  async function collect(root:Node,run:number){
    const shadowRoots:ShadowRoot[]=[];
    function discover(element:Element){if(element.shadowRoot&&!isBlocked(element,blocked)){shadowRoots.push(element.shadowRoot);if(observer&&!observedShadows.has(element.shadowRoot)){observer.observe(element.shadowRoot,observeOptions);observedShadows.add(element.shadowRoot);}}}
    if(root instanceof Element)discover(root);
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT);let candidate:Node|null=root.nodeType===Node.TEXT_NODE?root:walker.nextNode();
    const groups=new Map<Element,Record[]>(),visibility=new Map<Element,boolean>();let sliceStart=performance.now();
    while(candidate){
      if(run!==generation||!active)return;
      if(candidate instanceof Element){discover(candidate);candidate=walker.nextNode();if(performance.now()-sliceStart>6){await yieldThread();sliceStart=performance.now();}continue;}
      const node=candidate as Text,parent=node.parentElement;
      if(parent&&node.data.trim()&&/\p{L}/u.test(node.data)&&!isBlocked(parent,blocked)&&!records.has(node)){
        const container=parent.closest(blockSelector)??parent;
        let visible=visibility.get(parent);
        if(visible===undefined){const style=getComputedStyle(parent);let hasRect=parent.getClientRects().length>0;
          if(!hasRect&&style.display==='contents'){const range=document.createRange();range.selectNode(node);hasRect=range.getClientRects().length>0;}
          visible=style.visibility==='visible'&&style.display!=='none'&&hasRect;visibility.set(parent,visible);}
        if(visible){
          if(status.chars+node.data.length>config!.maxPageChars){status.limited=true;}
          else {
            const id=++sequence,parts=split(node.data),ids=parts.map((_,i)=>`s${id}_${i}`);
            const record:Record={node,source:node.data,applied:node.data,ids,texts:new Map(),root:container,version:0,state:'queued'};
            records.set(node,record);status.chars+=node.data.length;
            if(!groups.has(container))groups.set(container,[]);groups.get(container)!.push(record);
          }
        }
      }
      candidate=walker.nextNode();
      if(performance.now()-sliceStart>6){await yieldThread();sliceStart=performance.now();}
    }
    for(const [container,list] of groups){
      if(run!==generation||!active)return;
      const rect=container.getBoundingClientRect();const priority=rect.bottom>=0&&rect.top<=innerHeight?0:Math.abs(rect.top)+1000;
      const context=list.map(r=>r.source).join('').slice(0,2500);
      let segments:TextBlock['segments']=[],used:Record[]=[];let chars=0,tokens=0;
      const flush=()=>{if(!segments.length)return;pending.push({block:{id:`b${++sequence}`,context,segments},records:[...new Set(used)],version:0,priority,attempted:false,tokens});status.total++;segments=[];used=[];chars=0;tokens=0;};
      for(const record of list){const parts=split(record.source);for(let i=0;i<parts.length;i++){
        const estimated=estimateOutputTokens(parts[i]);
        if(chars+parts[i].length>6000||segments.length>=64||tokens+estimated>1800)flush();
        segments.push({id:record.ids[i],text:parts[i]});used.push(record);chars+=parts[i].length;tokens+=estimated;
      }}flush();
      if(performance.now()-sliceStart>6){await yieldThread();sliceStart=performance.now();}
    }
    pending.sort((a,b)=>a.priority-b.priority);publish();
    for(const shadow of shadowRoots)await collect(shadow,run);
  }
  async function requestBatch(work:Work[],run:number){
    const thisTask=taskId,requestId=crypto.randomUUID();
    work.forEach(w=>w.attempted=true);
    const keepalive=setInterval(()=>message({type:'task:heartbeat'}).catch(()=>{}),15000);
    try{
      const result=await message<TranslationResult>({type:'translate',input:{kind:'page',requestId,taskId:thisTask,profileId:config!.profileId,target:config!.target,blocks:work.map(w=>w.block)}});
      if(run!==generation||!active)return;
      const output=new Map(result.segments.map(s=>[s.id,s.text]));let start=performance.now();
      for(const item of work){
        for(const record of item.records){
          if(!same(record,item.version))continue;
          for(const id of record.ids){const text=output.get(id);if(text!==undefined)record.texts.set(id,text);}
          renderRecord(record,status.display);
          if(performance.now()-start>6){await yieldThread();start=performance.now();if(run!==generation||!active)return;}
        }
        status.completed++;
      }
    }catch(error){
      if(run!==generation||!active)return;
      for(const w of work){failed.push(w);for(const r of w.records)if(same(r,w.version))r.state='failed';status.failed++;}
      status.message=error instanceof Error?error.message:'部分内容翻译失败。';
    }finally{clearInterval(keepalive);if(run===generation)publish();}
  }
  async function drain(run:number){
    if(processing||run!==generation||!active)return;processing=true;status.state='translating';publish();
    const worker=async()=>{while(active&&run===generation&&pending.length){
      const batch:Work[]=[];let chars=0,contexts=0,count=0,tokens=0;
      while(pending.length){const next=pending[0],size=next.block.segments.reduce((n,s)=>n+s.text.length,0);
        if(batch.length&&(chars+size>9000||contexts+next.block.context.length>10000||count+next.block.segments.length>192||batch.length>=64||tokens+next.tokens>1800))break;
        pending.shift();if(!next.records.some(r=>same(r,next.version)))continue;
        batch.push(next);chars+=size;contexts+=next.block.context.length;count+=next.block.segments.length;tokens+=next.tokens;
      }
      if(batch.length)await requestBatch(batch,run);else await yieldThread();
    }};
    try{await Promise.all([worker(),worker()]);}finally{if(run===generation){processing=false;status.state=active&&config?.dynamic?'watching':active?'done':'stopped';publish(true);}}
    if(run===generation&&pending.length&&active)void drain(run);
  }
  async function processChanges(){
    mutationTimer=undefined;if(!active)return;
    const run=generation,nodes=[...changed];changed.clear();
    let cleanupStart=performance.now();
    for(const [node,record] of records){
      if(!node.isConnected){record.annotation?.remove();records.delete(node);}
      else if(node.data!==record.applied){mutedWrite(()=>record.annotation?.remove());record.version++;records.delete(node);}
      if(performance.now()-cleanupStart>6){await yieldThread();cleanupStart=performance.now();if(run!==generation||!active)return;}
    }
    // Skip descendants if a changed ancestor is already scheduled.
    const roots=nodes.filter(n=>n.isConnected&&!n.parentElement?.closest('[data-si-owned]')&&!nodes.some(other=>other!==n&&other.contains(n)));
    for(const root of roots)await collect(root,run);
    if(run===generation)void drain(run);
  }
  function watch(){
    observedShadows=new WeakSet();
    observer=new MutationObserver(events=>{
      if(muted||!active)return;
      for(const event of events){
        if(event.target instanceof Element&&event.target.closest('[data-si-owned]'))continue;
        if(event.type==='attributes')changed.add(event.target);
        else if(event.type==='characterData'){const record=records.get(event.target as Text);if(record&&event.target.textContent===record.applied)continue;changed.add(event.target);}
        else for(const node of event.addedNodes)if(!(node instanceof Element&&node.hasAttribute('data-si-owned')))changed.add(node);
      }
      if(events.some(e=>[...e.removedNodes].some(n=>!(n instanceof Element&&n.hasAttribute('data-si-owned'))))&&!changed.size)changed.add(document.body);
      if(changed.size){if(mutationTimer)clearTimeout(mutationTimer);mutationTimer=setTimeout(()=>void processChanges(),350);}
    });observer.observe(document.body,observeOptions);
  }
  function stop(invalidateStart=true){
    if(invalidateStart)startToken++;
    const oldTask=taskId;active=false;generation++;processing=false;observer?.disconnect();observer=undefined;
    if(mutationTimer)clearTimeout(mutationTimer);mutationTimer=undefined;changed.clear();pending=[];
    if(oldTask)message({type:'task:cancel',taskId:oldTask}).catch(()=>{});
    status.state='stopped';publish(true);
  }
  async function restore(invalidateStart=true){
    stop(invalidateStart);const run=generation;let start=performance.now();
    for(const record of records.values()){
      if(run!==generation)return;
      if(record.node.isConnected&&record.node.data===record.applied)record.node.data=record.source;
      record.annotation?.remove();
      if(performance.now()-start>6){await yieldThread();start=performance.now();}
    }
    if(run!==generation)return;
    records.clear();failed.length=0;status={...EMPTY_STATUS,display:config?.display??'replace'};publish(true);
  }
  async function start(next:PublicConfig,id:string){
    const token=++startToken;await restore(false);if(token!==startToken)return;
    config=next;taskId=id;active=true;const run=++generation;
    status={...EMPTY_STATUS,state:'scanning',display:next.display};publish(true);
    if(!document.body){status.message='页面尚未加载完成，请稍后重试。';stop();return;}
    // Observe before scanning to catch content added while the initial walk yields.
    if(next.dynamic)watch();
    await collect(document.body,run);if(run===generation&&active)void drain(run);
  }
  async function display(mode:DisplayMode){
    status.display=mode;let start=performance.now();
    for(const record of records.values()){if(record.state==='translated')renderRecord(record,mode);if(performance.now()-start>6){await yieldThread();start=performance.now();}}
    publish(true);
  }
  function retry(id:string){
    if(!taskId||!config)return;
    taskId=id;
    if(!active){active=true;generation++;processing=false;if(config.dynamic)watch();}
    let count=0;for(const work of failed.splice(0)){if(work.records.some(r=>same(r,work.version))){pending.push(work);count++;}}
    status.failed=Math.max(0,status.failed-count);status.message='';void drain(generation);
  }

  const panelCss=`:host{all:initial;color-scheme:light dark;position:fixed;z-index:2147483647;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;color:#1e293b;line-height:1.6}
    *{box-sizing:border-box}
    button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:6px 12px;background:#f1f5f9;color:#334155;font-size:12.5px;font-weight:500;transition:all .15s ease}
    button:hover{background:#e2e8f0;color:#0f172a}
    button:focus-visible{outline:2px solid #3b82f6;outline-offset:1px}
    .trigger{border-radius:11px;width:36px;height:36px;padding:0;background:linear-gradient(135deg,#3b82f6 0%,#2563eb 50%,#4f46e5 100%);color:#fff;box-shadow:0 4px 14px rgba(37,99,235,.38),0 1px 3px rgba(0,0,0,.12);border:1px solid rgba(255,255,255,.28);display:grid;place-items:center;transition:all .2s cubic-bezier(.16,1,.3,1)}
    .trigger:hover{transform:scale(1.12);box-shadow:0 6px 20px rgba(37,99,235,.48),0 2px 6px rgba(0,0,0,.15);filter:brightness(1.08)}
    .trigger:active{transform:scale(.94)}
    .trigger svg{display:block;pointer-events:none}
    .card{width:min(360px,calc(100vw - 24px));background:rgba(255,255,255,0.96);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(226,232,240,0.85);box-shadow:0 16px 40px -8px rgba(15,23,42,0.18),0 4px 12px -2px rgba(15,23,42,0.08);border-radius:16px;padding:14px 16px}
    header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;font-size:12px;font-weight:600;color:#64748b;letter-spacing:0.2px}
    .actions{display:flex;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid #f1f5f9}
    .result{white-space:pre-wrap;overflow-wrap:anywhere;max-height:min(330px,60vh);overflow-y:auto;user-select:text;font-size:14px;line-height:1.6;color:#0f172a}
    .error{color:#dc2626}
    .close{padding:0;width:24px;height:24px;background:transparent;font-size:16px;border-radius:6px;color:#94a3b8;display:grid;place-items:center;transition:all .15s ease}
    .close:hover{background:#f1f5f9;color:#334155}
    .hint{font-size:11.5px;color:#94a3b8;margin-top:8px}
    .dots{color:#2563eb}
    .sr{position:absolute;width:1px;height:1px;clip-path:inset(50%)}
    @media(prefers-color-scheme:dark){
      :host{color:#f8fafc}
      .card{background:rgba(26,28,38,0.96);border-color:rgba(51,65,85,0.6);box-shadow:0 20px 48px -8px rgba(0,0,0,0.55),0 4px 16px rgba(0,0,0,0.35)}
      header{color:#94a3b8}
      .result{color:#f8fafc}
      .actions{border-top-color:#2e3346}
      button{background:#2a2e40;color:#cbd5e1}
      button:hover{background:#383e56;color:#fff}
      .close:hover{background:#2a2e40;color:#f8fafc}
      .hint{color:#64748b}
      .error{color:#f87171}
    }`;
  function positionPanel(){
    if(!panelHost||!selectionAnchor)return;
    if(selectionRange){const rect=selectionRect(selectionRange);if(rect)selectionAnchor=rect;else if(selectionPhase==='button'){closePanel();return;}}
    const width=selectionPhase==='button'?36:Math.min(360,innerWidth-24);
    const height=panelHost.getBoundingClientRect().height||36;
    let x=selectionAnchor.left,y=selectionAnchor.bottom+8;
    if(selectionPhase==='button'){
      x=selectionAnchor.right+8;y=selectionAnchor.top+(selectionAnchor.height-height)/2;
      if(x+width>innerWidth-12){
        if(selectionAnchor.left-width-8>=12)x=selectionAnchor.left-width-8;
        else {x=selectionAnchor.right-width;y=selectionAnchor.bottom+8;}
      }
    }
    if(y+height>innerHeight-12)y=selectionAnchor.top-height-8;
    panelHost.style.left=`${Math.max(12,Math.min(innerWidth-width-12,x))}px`;
    panelHost.style.top=`${Math.max(12,Math.min(innerHeight-height-12,y))}px`;
  }
  function closePanel(){
    if(selectionTask)message({type:'task:cancel',taskId:selectionTask}).catch(()=>{});
    selectionTask='';selectionRequest='';selectionPhase='button';panelHost?.remove();panelHost=undefined;panelRoot=undefined;
  }
  function createPanel(){
    panelHost?.remove();panelHost=document.createElement('div');panelHost.dataset.siOwned='panel';
    panelRoot=panelHost.attachShadow({mode:'closed'});const style=document.createElement('style');style.textContent=panelCss;panelRoot.append(style);
    document.documentElement.append(panelHost);
    panelHost.addEventListener('pointerdown',event=>event.stopPropagation());
  }
  function button(label:string,fn:()=>void,className=''){const b=document.createElement('button');b.type='button';b.textContent=label;b.className=className;b.addEventListener('click',fn);return b;}
  function trigger(){
    closePanel();selectionPhase='button';createPanel();
    const b=document.createElement('button');b.type='button';b.className='trigger';
    b.setAttribute('aria-label','翻译选中文字');b.title='翻译选中文字（思译）';
    b.innerHTML=`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>`;
    b.addEventListener('click',()=>void translateSelection());
    b.addEventListener('pointerdown',event=>event.preventDefault());panelRoot!.append(b);positionPanel();
  }
  function showResult(text:string,error=false,loading=false){
    if(!panelRoot)return;
    const focused=!!panelRoot.activeElement,existing=panelRoot.querySelector('.card');
    if(loading&&existing){existing.querySelector('.result')!.textContent=text;existing.querySelector('.result')!.className='result';existing.querySelector('header span')!.textContent='思译 · 正在翻译';existing.querySelector('.actions')?.remove();existing.querySelector('.hint')?.remove();positionPanel();return;}
    for(const child of [...panelRoot.children])if(child.tagName!=='STYLE')child.remove();
    const card=document.createElement('section');card.className='card';card.setAttribute('role','dialog');card.setAttribute('aria-label','选中文字翻译');
    const header=document.createElement('header'),label=document.createElement('span');label.textContent=loading?'思译 · 正在翻译':'思译 · 选中文字';header.append(label,button('×',closePanel,'close'));header.lastElementChild!.setAttribute('aria-label','关闭翻译');
    const result=document.createElement('div');result.className=`result${error?' error':''}`;result.textContent=text;result.setAttribute('aria-live','polite');
    card.append(header,result);
    if(!loading){const actions=document.createElement('div');actions.className='actions';
      if(!error)actions.append(button('复制',()=>{navigator.clipboard.writeText(text).then(()=>{const hint=card.querySelector('.hint');if(hint)hint.textContent='已复制';}).catch(()=>{const hint=card.querySelector('.hint');if(hint)hint.textContent='浏览器未允许复制，请选中译文手动复制。';});}));
      actions.append(button('重试',()=>void translateSelection()));card.append(actions);
      const hint=document.createElement('div');hint.className='hint';hint.textContent=error?'原文未改动。可在扩展设置中检查配置。':'Esc 关闭 · 译文由所选模型生成';card.append(hint);
    }
    panelRoot.append(card);positionPanel();if(focused)(header.lastElementChild as HTMLButtonElement).focus({preventScroll:true});
  }
  async function translateSelection(next?:PublicConfig){
    if(selectionTask)message({type:'task:cancel',taskId:selectionTask}).catch(()=>{});
    const localTask=`selection-${crypto.randomUUID()}`,requestId=crypto.randomUUID();selectionTask=localTask;selectionRequest=requestId;selectionPhase='loading';
    if(!panelRoot)createPanel();showResult('正在连接模型…',false,true);
    let heartbeat:ReturnType<typeof setInterval>|undefined;
    try{
      const c=next??await message<PublicConfig>({type:'page:config'});
      if(selectionTask!==localTask)return;
      if(!c.ready)throw new Error('请先打开扩展设置，填写 API Key 和模型。');
      if(selectionText.length>5000)throw new Error('选中文字超过 5,000 字符，请缩小选区，或使用整页翻译。');
      heartbeat=setInterval(()=>message({type:'task:heartbeat'}).catch(()=>{}),15000);
      const response=await message<TranslationResult>({type:'translate',input:{kind:'selection',taskId:localTask,requestId,profileId:c.profileId,target:c.target,
        blocks:[{id:'selection',context:c.includeContext?selectionContext.slice(0,2500):'',segments:[{id:'selection-text',text:selectionText}]}]}});
      if(selectionTask!==localTask)return;selectionPhase='result';showResult(response.segments[0].text);
    }catch(error){if(selectionTask===localTask){selectionPhase='result';showResult(error instanceof Error?error.message:'翻译失败，请重试。',true);}}
    finally{if(heartbeat)clearInterval(heartbeat);}
  }
  function selectionRect(range:Range){
    const rects=[...range.getClientRects()].filter(rect=>rect.width>0&&rect.height>0&&rect.bottom>0&&rect.top<innerHeight&&rect.right>0&&rect.left<innerWidth);
    return selectionBackward?rects[0]:rects.at(-1);
  }
  function readSelectionRange(selection:Selection){
    // Discover only roots on the interaction/selection path, never scan the page for shadow trees.
    for(const node of [selection.anchorNode,selection.focusNode]){
      let root=node?.getRootNode();while(root instanceof ShadowRoot&&root.mode==='open'){if(!selectionRoots.includes(root))selectionRoots.push(root);root=root.host.getRootNode();}
    }
    if(typeof selection.getComposedRanges==='function'){
      try{
        const composed=selection.getComposedRanges({shadowRoots:selectionRoots})[0];
        if(composed&&composed.startContainer.getRootNode()===composed.endContainer.getRootNode()){
          const range=document.createRange();range.setStart(composed.startContainer,composed.startOffset);range.setEnd(composed.endContainer,composed.endOffset);
          if(!range.collapsed&&range.toString().trim())return range;
        }
      }catch{/* Older implementations may not support the options form. */}
    }
    // Chromium before getComposedRanges exposes the actual range through the open root.
    for(const root of selectionRoots){
      const local=(root as ShadowRoot&{getSelection?:()=>Selection|null}).getSelection?.();
      if(local?.rangeCount){const range=local.getRangeAt(0);if(!range.collapsed&&range.toString().trim()){
        selectionBackward=local.direction==='backward'||(local.focusNode===range.startContainer&&local.focusOffset===range.startOffset);return range.cloneRange();
      }}
    }
    if(selection.rangeCount){const range=selection.getRangeAt(0);if(!range.collapsed&&range.toString().trim())return range.cloneRange();}
  }
  function rememberSelection(event:Event){
    const roots=event.composedPath().filter((target):target is ShadowRoot=>target instanceof ShadowRoot&&target.mode==='open');
    if(event instanceof PointerEvent){selectionRoots=roots;selectionPoint=event.clientX||event.clientY?{x:event.clientX,y:event.clientY}:undefined;}
    else {if(roots.length)selectionRoots=roots;selectionPoint=undefined;}
  }
  function detectSelection(){
    if(!selectionEnabled)return;
    if(selectionPhase==='loading')return;
    const selection=getSelection(),text=selection?.toString().trim()??'';
    if(!text||!selection){if(selectionPhase==='button')closePanel();return;}
    selectionBackward=selection.direction==='backward';const range=readSelectionRange(selection);
    const start=range?.startContainer??selection.anchorNode,end=range?.endContainer;
    const element=start instanceof Element?start:start?.parentElement,endElement=end instanceof Element?end:end?.parentElement;
    let focused=document.activeElement;while(focused?.shadowRoot?.activeElement)focused=focused.shadowRoot.activeElement;
    if(!element||isBlocked(element,selectionBlocked)||(endElement&&isBlocked(endElement,selectionBlocked))||(focused&&isBlocked(focused,selectionBlocked))){if(selectionPhase==='button')closePanel();return;}
    // Inaccessible roots can use this pointer release; an unknown/zero range must never anchor at (0, 0).
    const anchor=range?selectionRect(range):selectionPoint?new DOMRect(selectionPoint.x,selectionPoint.y,0,0):undefined;
    if(!anchor){if(selectionPhase==='button')closePanel();return;}
    selectionText=text;selectionContext=range?(element.closest(blockSelector)??element).textContent?.slice(0,2500)??'':'';
    selectionRange=range;selectionAnchor=anchor;trigger();
  }
  // No text leaves the page in these selection listeners; only an explicit click invokes translation.
  document.addEventListener('pointerup',event=>{if(panelHost&&event.composedPath().includes(panelHost))return;rememberSelection(event);if(selectionTimer)clearTimeout(selectionTimer);selectionTimer=setTimeout(detectSelection,90);},{passive:true});
  document.addEventListener('keyup',event=>{if(event.key==='Escape'){if(selectionTimer)clearTimeout(selectionTimer);closePanel();return;}if(event.shiftKey||['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){if(panelHost&&event.composedPath().includes(panelHost))return;rememberSelection(event);if(selectionTimer)clearTimeout(selectionTimer);selectionTimer=setTimeout(detectSelection,100);}});
  document.addEventListener('pointerdown',event=>{if(panelHost&&!event.composedPath().includes(panelHost)&&selectionPhase!=='button')closePanel();},{passive:true});
  document.addEventListener('scroll',()=>{if(selectionPhase==='button')closePanel();},{passive:true,capture:true});
  window.addEventListener('resize',positionPanel,{passive:true});
  window.addEventListener('pagehide',()=>{stop();closePanel();});
  chrome.runtime.onMessage.addListener((value,_sender,respond)=>{
    if(value?.type==='selection:refresh'){void refreshSelection();respond(true);return;}
    if(value?.type==='selection:progress'&&value.requestId===selectionRequest&&selectionPhase==='loading'){showResult(value.text,false,true);respond(true);return;}
    if(value?.type==='selection:open'){
      selectionText=String(value.text??'');selectionContext='';selectionRange=undefined;selectionAnchor=new DOMRect(Math.max(12,innerWidth-390),80,1,1);closePanel();createPanel();void translateSelection(value.config);respond(true);return;
    }
    if(!value?.type?.startsWith('page:'))return;
    const operation=async()=>{switch(value.type){
      case 'page:start':void start(value.config,value.taskId);return true;
      case 'page:stop':stop();return true;
      case 'page:restore':await restore();return true;
      case 'page:retry':retry(value.taskId);return true;
      case 'page:display':await display(value.display);return true;
      case 'page:get-status':return status;
    }};
    operation().then(respond,()=>respond(false));return true;
  });
  void refreshSelection();
}
