export interface CaptionPosition {x:number;y:number}
export interface CaptionSize {width:number;height:number}
export interface CaptionBox {left:number;top:number;width:number;height:number}
export type CaptionCorner='nw'|'ne'|'sw'|'se';
export interface CaptionLayout {fontSize:number;width:number;opacity:number;mode:'video'|'screen';locked:boolean;showOriginal:boolean;readingMode?:'balanced'|'live';normal?:CaptionPosition;fullscreen?:CaptionPosition;normalSize?:CaptionSize;fullscreenSize?:CaptionSize}
export const DEFAULT_CAPTION:CaptionLayout={fontSize:22,width:68,opacity:.78,mode:'video',locked:false,showOriginal:true};
export const CAPTION_FONT_MIN=14,CAPTION_FONT_MAX=40;
// Old captionLayout rows may omit showOriginal or store the overlay flag as bilingual. Map once; leave unrelated invalid rows untouched.
export function migrateCaption(raw:unknown):CaptionLayout|undefined{
  if(!raw||typeof raw!=='object')return;
  const record=raw as Record<string,unknown>;
  if(!('bilingual' in record)&&typeof record.showOriginal==='boolean')return;
  const bilingual=record.bilingual;
  const showOriginal=typeof record.showOriginal==='boolean'?record.showOriginal:typeof bilingual==='boolean'?bilingual:DEFAULT_CAPTION.showOriginal;
  const next={...record,showOriginal} as CaptionLayout&{bilingual?:unknown};
  delete next.bilingual;
  try{validateCaption(next);return next;}catch{return;}
}
export function normalizeCaption(raw:unknown):CaptionLayout{
  const migrated=migrateCaption(raw);
  if(migrated)return migrated;
  try{validateCaption(raw as CaptionLayout);return raw as CaptionLayout;}catch{return structuredClone(DEFAULT_CAPTION);}
}
export function validateCaption(s:CaptionLayout){
  if(s?.readingMode!==undefined&&!['balanced','live'].includes(s.readingMode))throw new Error('字幕阅读模式无效。');
  if(!s||!Number.isFinite(s.fontSize)||s.fontSize<CAPTION_FONT_MIN||s.fontSize>CAPTION_FONT_MAX||!Number.isFinite(s.width)||s.width<35||s.width>95||!Number.isFinite(s.opacity)||s.opacity<.1||s.opacity>1||!['video','screen'].includes(s.mode)||typeof s.locked!=='boolean'||typeof s.showOriginal!=='boolean')throw new Error('字幕显示设置无效。');
  for(const p of [s.normal,s.fullscreen])if(p!==undefined&&(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.x>1||p.y<0||p.y>1))throw new Error('字幕位置无效。');
  for(const size of [s.normalSize,s.fullscreenSize])if(size!==undefined&&(!size||!Number.isFinite(size.width)||!Number.isFinite(size.height)||size.width<=0||size.width>1||size.height<=0||size.height>1))throw new Error('字幕尺寸无效。');
}
export const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
export function captionBounds(rect:{left:number;top:number;right:number;bottom:number;width:number;height:number},vw:number,vh:number,layout:CaptionLayout,height:number,full=false){
  const screen=layout.mode==='screen',left=screen?8:clamp(rect.left+8,8,Math.max(8,vw-40)),right=screen?vw-8:clamp(rect.right-8,left+24,vw-8);
  const top=screen?32:clamp(rect.top+28,32,Math.max(32,vh-height-8)),bottom=screen?vh-8:clamp(rect.bottom-8,Math.min(vh-8,top+height),vh-8);
  const areaWidth=Math.max(1,right-left),areaHeight=Math.max(1,bottom-top),size=full?layout.fullscreenSize:layout.normalSize;
  const width=clamp(size?areaWidth*size.width:(screen?vw:rect.width)*layout.width/100,Math.min(240,areaWidth),areaWidth),rangeX=Math.max(0,areaWidth-width),rangeY=Math.max(0,areaHeight-height);
  const p=full?layout.fullscreen:layout.normal;
  return {width,height:size?areaHeight*size.height:0,left:left+rangeX*(p?.x??.5),top:top+rangeY*(p?.y??.85),originX:left,originY:top,areaWidth,areaHeight,rangeX,rangeY};
}
// Keep the opposite corner fixed, clamp to the available area, and never crop content.
export function resizeCaptionBox(box:CaptionBox,area:CaptionBox,corner:CaptionCorner,dx:number,dy:number,minWidth=240,minHeight=48):CaptionBox{
  const right=box.left+box.width,bottom=box.top+box.height,west=corner.includes('w'),north=corner.includes('n');
  const left=west?clamp(box.left+dx,area.left,right-Math.min(minWidth,box.width)):box.left;
  const top=north?clamp(box.top+dy,area.top,bottom-Math.min(minHeight,box.height)):box.top;
  const endX=west?right:clamp(right+dx,box.left+Math.min(minWidth,box.width),area.left+area.width);
  const endY=north?bottom:clamp(bottom+dy,box.top+Math.min(minHeight,box.height),area.top+area.height);
  return {left,top,width:endX-left,height:endY-top};
}
// Width is the committed box size. Height stays min-height padding so a taller box does not crop or reflow the opposite corner.
export function scaleCaptionFont(baseFont:number,baseWidth:number,nextWidth:number){
  const scale=Number.isFinite(nextWidth)&&nextWidth>0?nextWidth/Math.max(1,baseWidth):1;
  return clamp(Math.round(baseFont*(Number.isFinite(scale)&&scale>0?scale:1)),CAPTION_FONT_MIN,CAPTION_FONT_MAX);
}
export function captionGestureLayout(layout:CaptionLayout,drag:{full:boolean;corner?:CaptionCorner;box:CaptionBox;area:CaptionBox;dx:number;dy:number;minWidth?:number;minHeight:number}):CaptionLayout{
  const minWidth=drag.minWidth??240,b=drag.corner?resizeCaptionBox(drag.box,drag.area,drag.corner,drag.dx,drag.dy,minWidth,drag.minHeight):{...drag.box,left:clamp(drag.box.left+drag.dx,drag.area.left,drag.area.left+Math.max(0,drag.area.width-drag.box.width)),top:clamp(drag.box.top+drag.dy,drag.area.top,drag.area.top+Math.max(0,drag.area.height-drag.box.height))};
  const key=drag.full?'fullscreen':'normal';
  const next:CaptionLayout={...layout,[key]:{x:clamp((b.left-drag.area.left)/Math.max(1,drag.area.width-b.width),0,1),y:clamp((b.top-drag.area.top)/Math.max(1,drag.area.height-b.height),0,1)}};
  if(!drag.corner)return next;
  next[drag.full?'fullscreenSize':'normalSize']={width:clamp(b.width/drag.area.width,.001,1),height:clamp(b.height/drag.area.height,.001,1)};
  next.fontSize=scaleCaptionFont(layout.fontSize,drag.box.width,b.width);
  return next;
}
export function captionGeometryPatch(context:string,position:CaptionPosition|undefined,size:CaptionSize|undefined,fontSize?:number):Partial<CaptionLayout>{
  if(context!=='normal'&&context!=='fullscreen')throw new Error('字幕位置类型无效。');
  const patch:Partial<CaptionLayout>=context==='fullscreen'?{fullscreen:position,fullscreenSize:size}:{normal:position,normalSize:size};
  if(fontSize!==undefined)patch.fontSize=fontSize;
  return patch;
}
// Live tools and page controls stay mounted, but the panel itself is closed until the corner menu is opened.
export function captionChrome(open:boolean,live:boolean,pageCount:number){
  const pager=pageCount>1,tools=live,toggle=pager||tools;
  return {toggle,menu:open&&toggle,pager,tools};
}
export function captionPages(text:string,max=44){
  max=Math.max(1,Math.floor(max));
  const chars=Array.from(text.trim()),pages:string[]=[];let from=0;
  while(from<chars.length){let end=Math.min(chars.length,from+max);
    if(end<chars.length){for(let i=end;i>from+max*.5;i--)if(/[。！？!?、，,；;\s]/.test(chars[i-1])){end=i;break;}}
    pages.push(chars.slice(from,end).join('').trim());from=end;
  }
  return pages.length?pages:[''];
}
