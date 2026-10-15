export interface CaptionPosition {x:number;y:number}
export interface CaptionLayout {fontSize:number;width:number;opacity:number;mode:'video'|'screen';locked:boolean;showOriginal:boolean;readingMode?:'balanced'|'live';normal?:CaptionPosition;fullscreen?:CaptionPosition}
export const DEFAULT_CAPTION:CaptionLayout={fontSize:22,width:68,opacity:.78,mode:'video',locked:false,showOriginal:true};
export function validateCaption(s:CaptionLayout){
  if(s?.readingMode!==undefined&&!['balanced','live'].includes(s.readingMode))throw new Error('字幕阅读模式无效。');
  if(!s||!Number.isFinite(s.fontSize)||s.fontSize<14||s.fontSize>40||!Number.isFinite(s.width)||s.width<35||s.width>95||!Number.isFinite(s.opacity)||s.opacity<.1||s.opacity>1||!['video','screen'].includes(s.mode)||typeof s.locked!=='boolean'||typeof s.showOriginal!=='boolean')throw new Error('字幕显示设置无效。');
  for(const p of [s.normal,s.fullscreen])if(p!==undefined&&(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.x>1||p.y<0||p.y>1))throw new Error('字幕位置无效。');
}
export const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
export function captionBounds(rect:{left:number;top:number;right:number;bottom:number;width:number;height:number},vw:number,vh:number,layout:CaptionLayout,height:number,full=false){
  const screen=layout.mode==='screen',left=screen?8:clamp(rect.left+8,8,Math.max(8,vw-40)),right=screen?vw-8:clamp(rect.right-8,left+24,vw-8);
  const top=screen?32:clamp(rect.top+28,32,Math.max(32,vh-height-8)),bottom=screen?vh-8:clamp(rect.bottom-8,Math.min(vh-8,top+height),vh-8);
  const width=clamp((screen?vw:rect.width)*layout.width/100,Math.min(240,right-left),right-left),rangeX=Math.max(0,right-left-width),rangeY=Math.max(0,bottom-top-height);
  const p=full?layout.fullscreen:layout.normal;
  return {width,left:left+rangeX*(p?.x??.5),top:top+rangeY*(p?.y??.85),originX:left,originY:top,rangeX,rangeY};
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
