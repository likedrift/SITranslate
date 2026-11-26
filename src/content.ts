import {EMPTY_STATUS, LANGUAGES, type PublicConfig, type PageStatus, type TextBlock, type TranslationResult, type DisplayMode} from './core/types';
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
  let selectionEnabled=false,panelDragged=false,panelPinned=false,selectionTarget='',copyResetTimer:ReturnType<typeof setTimeout>|undefined;
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
  const bilingualBlockTags=new Set(['P','H1','H2','H3','H4','H5','H6','LI','BLOCKQUOTE','FIGCAPTION','DT','DD','TD','TH']);
  function isStandaloneBlockText(node:Text){
    const parent=node.parentElement;
    if(!parent||!bilingualBlockTags.has(parent.tagName))return false;
    for(const sibling of parent.childNodes){
      if(sibling===node)continue;
      if(sibling instanceof Element&&sibling.hasAttribute('data-si-owned'))continue;
      if(sibling.nodeType===Node.TEXT_NODE&&!sibling.textContent?.trim())continue;
      return false;
    }
    return true;
  }
  function renderRecord(record:Record,display:DisplayMode){
    if(!same(record,record.version)||record.texts.size!==record.ids.length)return;
    const translation=translatedValue(record);
    mutedWrite(()=>{
      record.annotation?.remove();record.annotation=undefined;
      if(display==='replace'){record.node.data=translation;record.applied=translation;}
      else {
        record.node.data=record.source;record.applied=record.source;
        const clean=translation.trim();
        const block=isStandaloneBlockText(record.node);
        const span=document.createElement('span');span.dataset.siOwned='translation';span.lang=config?.target??'zh-Hans';
        if(block){
          span.textContent=clean;
          span.style.cssText='display:block;margin-top:.32em;padding:.1em 0 .1em .65em;border-inline-start:2px solid color-mix(in srgb,currentColor 26%,transparent);color:inherit;opacity:.82;font-size:.93em;line-height:1.55;font-weight:400;overflow-wrap:anywhere;';
        }else{
          span.textContent=` ${clean}`;
          span.style.cssText='color:inherit;opacity:.78;margin-inline-start:.3em;font-size:.93em;overflow-wrap:anywhere;';
        }
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

  const panelCss=`:host{all:initial;color-scheme:light dark;position:fixed;z-index:2147483647;font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;font-size:13px;color:#141518;line-height:1.5;-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}
    @keyframes si-pop{from{opacity:0;transform:translateY(3px) scale(.985)}to{opacity:1;transform:none}}
    @keyframes si-pulse{0%,80%,100%{opacity:.28;transform:scale(.85)}40%{opacity:1;transform:scale(1)}}
    button{font:inherit;cursor:pointer;border:1px solid transparent;border-radius:7px;height:28px;padding:0 10px;background:#f2f3f5;color:#141518;font-size:12px;font-weight:500;display:inline-flex;align-items:center;justify-content:center;gap:4px;transition:background-color .15s ease,border-color .15s ease,color .15s ease,transform .1s ease}
    button:hover{background:#e8eaee;color:#141518}
    button:active{transform:scale(.97)}
    button:focus-visible{outline:2px solid #2b5ce0;outline-offset:1px}
    .trigger{border-radius:9px;width:34px;height:34px;padding:0;background:#2b5ce0;color:#fff;box-shadow:0 4px 12px rgba(17,18,20,.22),0 1px 2px rgba(17,18,20,.14),inset 0 1px 0 rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.14);display:grid;place-items:center;transition:background-color .15s ease,transform .15s ease,box-shadow .15s ease}
    .trigger:hover{background:#2149c4;color:#fff;transform:scale(1.06);box-shadow:0 6px 16px rgba(17,18,20,.26),0 2px 4px rgba(17,18,20,.14)}
    .trigger:active{transform:scale(.95)}
    .trigger svg{display:block;pointer-events:none}
    .card{width:min(352px,calc(100vw - 24px));background:rgba(255,255,255,.97);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(17,18,20,.09);box-shadow:0 14px 36px -8px rgba(17,18,20,.16),0 3px 10px -2px rgba(17,18,20,.07);border-radius:12px;padding:12px 14px}
    .card.enter{animation:si-pop .14s ease-out}
    header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:-4px -4px 8px;padding:4px;border-radius:8px;font-size:12px;font-weight:600;color:#5c606b;cursor:grab;user-select:none;touch-action:none}
    header.dragging{cursor:grabbing}
    .title-wrap{display:flex;align-items:center;gap:6px;min-width:0}
    .head-tools{display:flex;align-items:center;gap:4px;flex-shrink:0}
    .lang-select{appearance:none;-webkit-appearance:none;font:inherit;font-size:11.5px;font-weight:500;color:#5c606b;background:#f2f3f5 url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%235c606b' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>") no-repeat right 6px center / 12px 12px;border:0;border-radius:6px;padding:0 22px 0 8px;height:24px;max-width:96px;cursor:pointer;transition:background-color .15s ease,color .15s ease}
    .lang-select:hover{background-color:#e8eaee;color:#141518}
    .lang-select:focus-visible{outline:2px solid #2b5ce0;outline-offset:1px}
    .pin,.close{padding:0;width:24px;height:24px;border:0;background:transparent;border-radius:6px;color:#8b909a;display:grid;place-items:center;flex-shrink:0}
    .pin:hover,.close:hover{background:rgba(17,18,20,.06);color:#141518}
    .pin[aria-pressed=true]{background:rgba(43,92,224,.12);color:#2b5ce0}
    .mini-mark{display:grid;place-items:center;width:16px;height:16px;border-radius:4px;background:#2b5ce0;color:#fff;flex-shrink:0}
    .mini-mark svg{display:block}
    .loading-dots{display:inline-flex;align-items:center;gap:3px;margin-left:2px}
    .loading-dots i{width:4px;height:4px;border-radius:50%;background:#2b5ce0;display:block;animation:si-pulse 1.1s infinite ease-in-out}
    .loading-dots i:nth-child(2){animation-delay:.16s}
    .loading-dots i:nth-child(3){animation-delay:.32s}
    .actions{display:flex;align-items:center;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(17,18,20,.07);flex-wrap:wrap}
    .actions .copied{background:rgba(22,163,74,.11);color:#15803d}
    .result{white-space:pre-wrap;overflow-wrap:anywhere;max-height:min(320px,60vh);overflow-y:auto;user-select:text;font-size:13.5px;line-height:1.62;color:#141518;scrollbar-width:thin;scrollbar-color:#cfd4dd transparent}
    .result::-webkit-scrollbar{width:5px}
    .result::-webkit-scrollbar-thumb{background:#cfd4dd;border-radius:999px}
    .error{color:#dc2626}
    .close{font-size:16px}
    .hint{font-size:11.5px;color:#5c606b;margin-top:6px}
    .hint:empty{display:none}
    .sr{position:absolute;width:1px;height:1px;clip-path:inset(50%)}
    @media(prefers-reduced-motion:reduce){.card,.loading-dots i{animation:none!important}*{transition:none!important}}
    @media(prefers-color-scheme:dark){
      :host{color:#ededef}
      .trigger{background:#3b6ad4;box-shadow:0 4px 12px rgba(0,0,0,.44),inset 0 1px 0 rgba(255,255,255,.18)}
      .trigger:hover{background:#4a78df}
      .card{background:rgba(23,24,27,.96);border-color:rgba(255,255,255,.09);box-shadow:0 18px 44px -8px rgba(0,0,0,.62),0 4px 14px rgba(0,0,0,.38)}
      header{color:#9a9fa8}
      .mini-mark{background:#3b6ad4}
      .loading-dots i{background:#6b94f2}
      .result{color:#ededef;scrollbar-color:#32363e transparent}
      .result::-webkit-scrollbar-thumb{background:#32363e}
      .actions{border-top-color:rgba(255,255,255,.07)}
      .actions .copied{background:rgba(52,211,153,.14);color:#6ee7b7}
      button{background:#1f2126;color:#ededef}
      button:hover{background:#282b31;color:#fff}
      .pin,.close{background:transparent;color:#9a9fa8}
      .pin:hover,.close:hover{background:rgba(255,255,255,.08);color:#ededef}
      .pin[aria-pressed=true]{background:rgba(91,135,232,.18);color:#b9cffa}
      .lang-select{background-color:#1f2126;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239a9fa8' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>");color:#9a9fa8}
      .lang-select:hover{background-color:#282b31;color:#ededef}
      .hint{color:#9a9fa8}
      .error{color:#f87171}
    }`;
  function clampPanelPosition(x:number,y:number){
    if(!panelHost)return;
    const rect=panelHost.getBoundingClientRect();
    const width=rect.width||(selectionPhase==='button'?36:Math.min(368,innerWidth-24));
    const height=rect.height||36;
    panelHost.style.left=`${Math.max(12,Math.min(innerWidth-width-12,x))}px`;
    panelHost.style.top=`${Math.max(12,Math.min(innerHeight-height-12,y))}px`;
  }
  function positionPanel(){
    if(!panelHost||!selectionAnchor)return;
    if(panelDragged&&selectionPhase!=='button'){
      const rect=panelHost.getBoundingClientRect();
      clampPanelPosition(rect.left,rect.top);
      return;
    }
    if(selectionRange){const rect=selectionRect(selectionRange);if(rect)selectionAnchor=rect;else if(selectionPhase==='button'){closePanel();return;}}
    const width=selectionPhase==='button'?36:Math.min(368,innerWidth-24);
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
    if(copyResetTimer){clearTimeout(copyResetTimer);copyResetTimer=undefined;}
    if(selectionTask)message({type:'task:cancel',taskId:selectionTask}).catch(()=>{});
    selectionTask='';selectionRequest='';selectionPhase='button';panelDragged=false;panelPinned=false;selectionTarget='';panelHost?.remove();panelHost=undefined;panelRoot=undefined;
  }
  function createPanel(){
    panelHost?.remove();panelDragged=false;panelPinned=false;panelHost=document.createElement('div');panelHost.dataset.siOwned='panel';
    panelRoot=panelHost.attachShadow({mode:'closed'});const style=document.createElement('style');style.textContent=panelCss;panelRoot.append(style);
    document.documentElement.append(panelHost);
    panelHost.addEventListener('pointerdown',event=>event.stopPropagation());
  }
  function button(label:string,fn:(e:MouseEvent)=>void,className=''){const b=document.createElement('button');b.type='button';b.textContent=label;b.className=className;b.addEventListener('click',fn);return b;}
  function bindCardDrag(header:HTMLElement){
    let dragging:{pointerId:number;startX:number;startY:number;left:number;top:number}|undefined;
    header.addEventListener('pointerdown',event=>{
      if(event.button!==0||!panelHost||(event.target instanceof Element&&event.target.closest('button,select')))return;
      event.preventDefault();
      const rect=panelHost.getBoundingClientRect();
      dragging={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,left:rect.left,top:rect.top};
      header.classList.add('dragging');header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove',event=>{
      if(!dragging||event.pointerId!==dragging.pointerId)return;
      panelDragged=true;
      clampPanelPosition(dragging.left+event.clientX-dragging.startX,dragging.top+event.clientY-dragging.startY);
    });
    const end=(event:PointerEvent)=>{
      if(!dragging||event.pointerId!==dragging.pointerId)return;
      if(header.hasPointerCapture(event.pointerId))header.releasePointerCapture(event.pointerId);
      header.classList.remove('dragging');dragging=undefined;
    };
    header.addEventListener('pointerup',end);header.addEventListener('pointercancel',end);
  }
  function brandMiniSvg(){
    return `<span class="mini-mark" aria-hidden="true"><svg width="11" height="11" viewBox="0 0 32 32" fill="none"><rect x="4" y="4" width="16" height="16" rx="4" fill="white" fill-opacity="0.34"/><rect x="12" y="12" width="16" height="16" rx="4" fill="white"/><path d="M20 14.5V17M16 17H24M22 17.8L16.5 24M19 19L23.5 24" stroke="#2b5ce0" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  }
  function trigger(){
    closePanel();selectionPhase='button';createPanel();
    const b=document.createElement('button');b.type='button';b.className='trigger';
    b.setAttribute('aria-label','翻译选中文字');b.title='翻译选中文字（思译）';
    b.innerHTML=`<svg width="18" height="18" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" fill="white" fill-opacity="0.32"/><path d="M9 17L12 9L15 17M10 14.5H14" stroke="white" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><rect x="12" y="12" width="16" height="16" rx="4" fill="white"/><path d="M20 14.5V17M16 17H24M22 17.8L16.5 24M19 19L23.5 24" stroke="#2b5ce0" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    b.addEventListener('click',()=>void translateSelection());
    b.addEventListener('pointerdown',event=>event.preventDefault());panelRoot!.append(b);positionPanel();
  }
  function showResult(text:string,error=false,loading=false){
    if(!panelRoot)return;
    const focused=!!panelRoot.activeElement,existing=panelRoot.querySelector('.card');
    if(loading&&existing){
      existing.querySelector('.result')!.textContent=text;
      existing.querySelector('.result')!.className='result';
      const title=existing.querySelector('.title-text');if(title)title.textContent='思译 · 正在翻译';
      if(!existing.querySelector('.loading-dots')){const dots=document.createElement('span');dots.className='loading-dots';dots.setAttribute('aria-hidden','true');dots.innerHTML='<i></i><i></i><i></i>';existing.querySelector('.title-wrap')?.append(dots);}
      existing.querySelector('.actions')?.remove();existing.querySelector('.hint')?.remove();positionPanel();return;
    }
    for(const child of [...panelRoot.children])if(child.tagName!=='STYLE')child.remove();
    const card=document.createElement('section');card.className=existing?'card':'card enter';card.setAttribute('role','dialog');card.setAttribute('aria-label','选中文字翻译');
    const header=document.createElement('header');header.title='拖动标题栏可移动 · Esc 关闭';
    const titleWrap=document.createElement('span');titleWrap.className='title-wrap';titleWrap.innerHTML=brandMiniSvg();
    const label=document.createElement('span');label.className='title-text';label.textContent=loading?'思译 · 正在翻译':'思译 · 选中文字';titleWrap.append(label);
    if(loading){const dots=document.createElement('span');dots.className='loading-dots';dots.setAttribute('aria-hidden','true');dots.innerHTML='<i></i><i></i><i></i>';titleWrap.append(dots);}
    const closeBtn=button('×',closePanel,'close');closeBtn.setAttribute('aria-label','关闭翻译');
    const pinBtn=document.createElement('button');pinBtn.type='button';pinBtn.className='pin';pinBtn.title=panelPinned?'取消钉住':'钉住窗口';pinBtn.setAttribute('aria-label',panelPinned?'取消钉住':'钉住窗口');pinBtn.setAttribute('aria-pressed',String(panelPinned));
    pinBtn.innerHTML=`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;
    pinBtn.addEventListener('click',()=>{panelPinned=!panelPinned;pinBtn.setAttribute('aria-pressed',String(panelPinned));pinBtn.title=panelPinned?'取消钉住':'钉住窗口';pinBtn.setAttribute('aria-label',pinBtn.title);});
    const langSelect=document.createElement('select');langSelect.className='lang-select';langSelect.setAttribute('aria-label','临时切换目标语言');
    for(const [id,name] of LANGUAGES){const opt=document.createElement('option');opt.value=id;opt.textContent=name;langSelect.append(opt);}
    langSelect.value=selectionTarget||config?.target||'zh-Hans';
    langSelect.addEventListener('change',()=>{selectionTarget=langSelect.value;void translateSelection();});
    const tools=document.createElement('div');tools.className='head-tools';tools.append(langSelect,pinBtn,closeBtn);
    header.append(titleWrap,tools);bindCardDrag(header);
    const result=document.createElement('div');result.className=`result${error?' error':''}`;result.textContent=text;result.setAttribute('aria-live','polite');
    card.append(header,result);
    if(!loading){const actions=document.createElement('div');actions.className='actions';
      if(!error){
        const copyBtn=button('复制',()=>{
          navigator.clipboard.writeText(text).then(()=>{
            copyBtn.textContent='已复制 ✓';copyBtn.classList.add('copied');
            const hint=card.querySelector('.hint');if(hint)hint.textContent='已复制到剪贴板';
            if(copyResetTimer)clearTimeout(copyResetTimer);
            copyResetTimer=setTimeout(()=>{copyBtn.textContent='复制';copyBtn.classList.remove('copied');},1800);
          }).catch(()=>{const hint=card.querySelector('.hint');if(hint)hint.textContent='浏览器未允许复制，请选中译文手动复制。';});
        });
        actions.append(copyBtn);
      }
      actions.append(button('重试',()=>void translateSelection()));
      if(error)actions.append(button('打开设置',event=>{if(event.isTrusted)void message({type:'selection:settings'}).catch(()=>{});}));
      card.append(actions);
      const hint=document.createElement('div');hint.className='hint';hint.textContent=error?'原文未改动 · 可前往扩展设置检查配置':'';card.append(hint);
    }
    panelRoot.append(card);positionPanel();if(focused)closeBtn.focus({preventScroll:true});
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
      const target=selectionTarget||c.target;selectionTarget=target;
      const select=panelRoot?.querySelector<HTMLSelectElement>('.lang-select');if(select)select.value=target;
      heartbeat=setInterval(()=>message({type:'task:heartbeat'}).catch(()=>{}),15000);
      const response=await message<TranslationResult>({type:'translate',input:{kind:'selection',taskId:localTask,requestId,profileId:c.profileId,target,
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
  document.addEventListener('pointerdown',event=>{if(panelHost&&!panelPinned&&!event.composedPath().includes(panelHost)&&selectionPhase!=='button')closePanel();},{passive:true});
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
