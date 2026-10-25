import {LIVE_CONTEXT_CHARS} from './live-translate';
export interface SpeechPiece {id:string;order:number;text:string;final:boolean;at:number;context?:string;traceId?:string;sourceEndAt?:number;parts?:SpeechPiece[]}
interface Item {text:string;final:boolean;lastAt:number;emitted:Map<number,string>;base:number}
interface Chunk {text:string;complete:boolean}
// Confirmed prefixes only. Draft suffixes never trigger translation.
export const UTTERANCE_CHUNK_CHARS=36;
export const UTTERANCE_TAIL_CHARS=12;
export const UTTERANCE_TAIL_HOLD_MS=800;
export const UTTERANCE_ITEM_LIMIT=32;
export class Utterances {
  private items=new Map<string,Item>();private order=0;
  reset(){this.items.clear();this.order=0;}
  get size(){return this.items.size;}
  get emittedCount(){let n=0;for(const item of this.items.values())n+=item.emitted.size;return n;}
  update(id:string,text:string,final:boolean,now=Date.now()):SpeechPiece[]{
    id=id||'unknown';text=text.trim();let item=this.items.get(id);
    if(!item){item={text:'',final:false,lastAt:now,emitted:new Map(),base:this.order++*10000};this.items.set(id,item);}
    if(item.final&&!final)return [];
    if(item.text===text&&item.final===final)return this.pieces(id,item,now);
    item.text=text;item.final=final;return this.pieces(id,item,now);
  }
  flush(now=Date.now()){const result:SpeechPiece[]=[];for(const [id,item] of this.items)if(!item.final)result.push(...this.pieces(id,item,now));return result;}
  // Absolute time when a long-enough unfinished tail may flush. Later partials do not move it.
  nextTailFlushAt():number|undefined{
    let due:number|undefined;
    for(const item of this.items.values()){
      if(item.final)continue;
      const at=this.tailHoldUntil(item);if(at===undefined)continue;
      due=due===undefined?at:Math.min(due,at);
    }
    return due;
  }
  private tailHoldUntil(item:Item){
    const chunks=this.chunks(item.text);
    for(let i=0;i<chunks.length;i++){
      const c=chunks[i];if(!c.text||item.emitted.get(i)===c.text)continue;
      if(i<Math.max(-1,...item.emitted.keys()))continue;
      if(c.complete||c.text.length<UTTERANCE_TAIL_CHARS)continue;
      return item.lastAt+UTTERANCE_TAIL_HOLD_MS;
    }
    return undefined;
  }
  private chunks(text:string){
    const chars=Array.from(text),chunks:Chunk[]=[];let start=0;
    while(start<chars.length){let end=start,complete=false;
      while(end<chars.length&&end-start<UTTERANCE_CHUNK_CHARS){const c=chars[end++];if(/[。！？!?]/.test(c)||c==='.'&&(!chars[end]||/\s/.test(chars[end]))){while(end<chars.length&&end-start<UTTERANCE_CHUNK_CHARS&&/[」』）”’]/.test(chars[end]))end++;complete=true;break;}}
      if(!complete&&end<chars.length){let boundary=-1;for(let i=end;i>start+16;i--)if(/[、，,；;\s]/.test(chars[i-1])){boundary=i;break;}
        if(boundary>start)end=boundary;else {while(end>start+27&&/[のをにがはとでへやも]/.test(chars[end-1]))end--;}
        complete=true;
      }
      chunks.push({text:chars.slice(start,end).join('').trim(),complete});start=end;
    }
    return chunks;
  }
  private pieces(id:string,item:Item,now:number){
    const chunks=this.chunks(item.text),result:SpeechPiece[]=[];
    for(let i=0;i<chunks.length;i++){
      const c=chunks[i];if(!c.text||item.emitted.get(i)===c.text)continue;
      // Do not rewrite historical chunks when a final ASR revision changes earlier words.
      if(i<Math.max(-1,...item.emitted.keys()))continue;
      if(!item.final&&!c.complete&&(c.text.length<UTTERANCE_TAIL_CHARS||now-item.lastAt<UTTERANCE_TAIL_HOLD_MS))continue;
      result.push({id:`${id}:${i}`,order:item.base+i,text:c.text,final:item.final||c.complete,at:now,context:chunks.slice(0,i).map(c=>c.text).join('').slice(-LIVE_CONTEXT_CHARS)});item.emitted.set(i,c.text);
    }
    if(result.length)item.lastAt=now;
    while(this.items.size>UTTERANCE_ITEM_LIMIT)this.items.delete(this.items.keys().next().value!);
    return result;
  }
}
export const LIVE_QUEUE_LIMIT=3;
// Fragments already bounded by one utterance chunk can share a request. The queue still keeps
// LIVE_QUEUE_LIMIT entries afterwards. A merged entry is timed from its earliest fragment, and
// fragments more than LIVE_MERGE_SPAN_MS apart stay separate so a fresh line is not expired with an older neighbor.
export const LIVE_MERGE_CHARS=UTTERANCE_CHUNK_CHARS;
export const LIVE_MERGED_CHARS=UTTERANCE_CHUNK_CHARS*2;
export const LIVE_MERGE_SPAN_MS=3000;
export function pieceParts(piece:SpeechPiece):SpeechPiece[]{return piece.parts?.length?piece.parts:[piece];}
export function pieceTraceIds(piece:SpeechPiece):string[]{
  const ids:string[]=[];
  for(const part of pieceParts(piece))if(part.traceId&&!ids.includes(part.traceId))ids.push(part.traceId);
  if(piece.traceId&&!ids.includes(piece.traceId))ids.unshift(piece.traceId);
  return ids;
}
function pieceChars(text:string){return Array.from(text).length;}
function joinPieceText(parts:{text:string}[]){
  let out='';
  for(const part of parts){if(out&&/[A-Za-z0-9]$/.test(out)&&/^[A-Za-z0-9]/.test(part.text))out+=' ';out+=part.text;}
  return out;
}
function flattenPieces(queue:SpeechPiece[]){
  const flat:SpeechPiece[]=[];
  for(const piece of queue){
    if(piece.parts?.length)for(const part of piece.parts)flat.push({...part,parts:undefined});
    else flat.push({...piece,parts:undefined});
  }
  return flat;
}
function mergeParts(parts:SpeechPiece[]):SpeechPiece{
  const first=parts[0],last=parts[parts.length-1],sourceEndAt=[...parts].reverse().find(part=>part.sourceEndAt!==undefined)?.sourceEndAt;
  // order is the last fragment so a displayed group moves the cursor past every included line.
  return {id:first.id,order:last.order,text:joinPieceText(parts),final:parts.every(part=>part.final),at:Math.min(...parts.map(part=>part.at)),context:first.context,traceId:first.traceId,...(sourceEndAt!==undefined?{sourceEndAt}:{}),parts:parts.map(part=>({...part,parts:undefined}))};
}
function canAppend(group:SpeechPiece[],piece:SpeechPiece){
  const last=group[group.length-1],newest=Math.max(piece.at,...group.map(part=>part.at)),oldest=Math.min(piece.at,...group.map(part=>part.at));
  if(pieceChars(piece.text)>LIVE_MERGE_CHARS||piece.order<=last.order||newest-oldest>LIVE_MERGE_SPAN_MS)return false;
  return pieceChars(joinPieceText([...group,piece]))<=LIVE_MERGED_CHARS;
}
export function coalesceShortPieces(pieces:SpeechPiece[]){
  const sorted=[...pieces].sort((a,b)=>a.order-b.order||a.at-b.at),out:SpeechPiece[]=[];let group:SpeechPiece[]=[];
  const flush=()=>{if(group.length===1)out.push(group[0]);else if(group.length>1)out.push(mergeParts(group));group=[];};
  for(const piece of sorted){
    if(group.length&&!canAppend(group,piece))flush();
    if(pieceChars(piece.text)<=LIVE_MERGE_CHARS)group.push(piece);else{flush();out.push(piece);}
  }
  flush();return out;
}
export function enqueuePiece(queue:SpeechPiece[],piece:SpeechPiece){
  const flat=flattenPieces(queue),index=flat.findIndex(item=>item.id===piece.id);
  if(index>=0)flat[index]={...piece,parts:undefined};else flat.push({...piece,parts:undefined});
  return coalesceShortPieces(flat).slice(-LIVE_QUEUE_LIMIT);
}
