import {LIVE_CONTEXT_CHARS} from './live-translate';
export interface SpeechPiece {id:string;order:number;text:string;final:boolean;at:number;context?:string;traceId?:string;sourceEndAt?:number;parts?:SpeechPiece[]}
interface Emitted {text:string;end:number;confirmed:boolean}
interface Item {text:string;final:boolean;lastAt:number;emitted:Emitted[];base:number}
interface Chunk {text:string;complete:boolean;end:number}
// Confirmed prefixes only. Draft suffixes never trigger translation.
export const UTTERANCE_CHUNK_CHARS=36;
export const UTTERANCE_TAIL_CHARS=16;
export const UTTERANCE_TAIL_HOLD_MS=1400;
export const UTTERANCE_ITEM_LIMIT=32;

const CLAUSE_ENDINGS=['でした','ました','けれど','だけど','です','ます','けど','から','ので','って','ない','ね','よ'];
const DANGLE_PARTICLES=/[のをにがはとでへやも]$/;
const LATIN_WORD=/[A-Za-z0-9]/;
const SOFT_PUNCT=/[、，,；;：:\s]/;

function charWeight(c:string){return c.charCodeAt(0)<128?0.5:1;}
function weightedLength(chars:string[],from=0,to=chars.length){
  let sum=0;for(let i=from;i<to;i++)sum+=charWeight(chars[i]);return sum;
}
function trimIncompleteTail(chars:string[],start:number,end:number,minWeighted:number){
  let cut=end;
  // Never split inside an ASCII/English word.
  if(cut<chars.length&&LATIN_WORD.test(chars[cut-1])&&LATIN_WORD.test(chars[cut])){
    let back=cut;
    while(back>start&&LATIN_WORD.test(chars[back-1]))back--;
    if(weightedLength(chars,start,back)>=minWeighted)cut=back;
  }
  // Avoid leaving a dangling Japanese particle at the cut boundary.
  while(cut>start&&DANGLE_PARTICLES.test(chars[cut-1])&&weightedLength(chars,start,cut-1)>=minWeighted)cut--;
  return cut;
}
function findNaturalBreak(chars:string[],start:number,end:number,minWeighted:number){
  for(let i=end;i>start;i--){
    if(SOFT_PUNCT.test(chars[i-1])&&weightedLength(chars,start,i)>=minWeighted)return i;
  }
  const slice=chars.slice(start,end).join('');
  for(let i=end;i>start;i--){
    if(weightedLength(chars,start,i)<minWeighted)break;
    const prefix=slice.slice(0,i-start);
    const next=chars[i]??'';
    if(/[かよねっ]|けど/.test(next))continue;
    if(CLAUSE_ENDINGS.some(ending=>prefix.endsWith(ending)))return i;
  }
  return -1;
}

export class Utterances {
  private items=new Map<string,Item>();private order=0;
  reset(){this.items.clear();this.order=0;}
  get size(){return this.items.size;}
  get emittedCount(){let n=0;for(const item of this.items.values())n+=item.emitted.length;return n;}
  confirm(pieceId:string,text:string){
    const cut=pieceId.lastIndexOf(':'),item=this.items.get(pieceId.slice(0,cut)),piece=item?.emitted[Number(pieceId.slice(cut+1))];
    if(piece?.text===text)piece.confirmed=true;
  }
  update(id:string,text:string,final:boolean,now=Date.now()):SpeechPiece[]{
    id=id||'unknown';text=text.trim();let item=this.items.get(id);
    if(!item){item={text:'',final:false,lastAt:now,emitted:[],base:this.order++*10000};this.items.set(id,item);while(this.items.size>UTTERANCE_ITEM_LIMIT)this.items.delete(this.items.keys().next().value!);}
    if(item.final&&!final)return [];
    if(item.text===text&&item.final===final)return this.pieces(id,item,now);
    // Some intermediate snapshots omit fixed words or briefly repeat a shorter prefix.
    // They must not move the consumed boundary backwards and replay it on the next event.
    if(!text||!final&&item.text.startsWith(text)){if(final)item.final=true;return [];}
    // ASR returns cumulative snapshots. Never recut the already emitted prefix.
    // On a correction, move its boundaries with the edit instead of reusing chunk indices.
    if(item.emitted.length&&!text.startsWith(item.text)){
      const positions=alignBoundaries(item.text,text);
      for(const part of item.emitted)part.end=positions[part.end];
    }
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
    const chars=Array.from(item.text),offset=afterPunctuation(chars,item.emitted.at(-1)?.end??0);
    for(const c of this.chunks(chars.slice(offset).join(''))){
      if(!hasWords(c.text)||c.complete||weightedLength(Array.from(c.text))<UTTERANCE_TAIL_CHARS)continue;
      return item.lastAt+UTTERANCE_TAIL_HOLD_MS;
    }
    return undefined;
  }
  private chunks(text:string){
    const chars=Array.from(text),chunks:Chunk[]=[];let start=0;
    while(start<chars.length){
      let end=start,weight=0,complete=false;
      while(end<chars.length&&weight<UTTERANCE_CHUNK_CHARS){
        const c=chars[end++];weight+=charWeight(c);
        if(/[。！？!?]/.test(c)||c==='.'&&(!chars[end]||/\s/.test(chars[end]))){
          while(end<chars.length&&weight<UTTERANCE_CHUNK_CHARS+4&&/[」』）”’]/.test(chars[end])){weight+=charWeight(chars[end++]);}
          complete=true;break;
        }
      }
      if(!complete&&end<chars.length){
        const boundary=findNaturalBreak(chars,start,end,16);
        if(boundary>start)end=boundary;
        else end=trimIncompleteTail(chars,start,end,24);
        complete=true;
      }
      chunks.push({text:chars.slice(start,end).join('').trim(),complete,end});start=end;
    }
    return chunks;
  }
  private pieces(id:string,item:Item,now:number){
    const chars=Array.from(item.text),result:SpeechPiece[]=[],last=item.emitted.at(-1);
    const emit=(i:number,text:string,start:number,final:boolean)=>result.push({id:`${id}:${i}`,order:item.base+i,text,final,at:now,context:chars.slice(0,start).join('').slice(-LIVE_CONTEXT_CHARS)});
    // Only the last unfinished translation can be revised; completed captions stay immutable.
    if(last&&!last.confirmed){
      const start=item.emitted.at(-2)?.end??0,text=chars.slice(start,last.end).join('').trim();
      if(hasWords(text)&&withoutEnding(text)!==withoutEnding(last.text)){last.text=text;emit(item.emitted.length-1,text,start,item.final);}
    }
    const offset=afterPunctuation(chars,last?.end??0);if(last)last.end=offset;let start=offset;
    for(const c of this.chunks(chars.slice(offset).join(''))){
      // Late punctuation belongs to the old prefix, not a fresh model request.
      if(!hasWords(c.text)){start=offset+c.end;if(last&&item.emitted.at(-1)===last)last.end=start;continue;}
      if(!item.final&&!c.complete){
        const cChars=Array.from(c.text);
        if(weightedLength(cChars)<UTTERANCE_TAIL_CHARS||now-item.lastAt<UTTERANCE_TAIL_HOLD_MS)break;
        // Prefer cutting at a natural clause/comma boundary and leave the unfinished stub for the next piece.
        const rawEnd=offset+c.end;
        const natural=findNaturalBreak(chars,start,rawEnd,10);
        const cut=natural>start?natural:trimIncompleteTail(chars,start,rawEnd,10);
        const pieceText=chars.slice(start,cut).join('').trim();
        if(!hasWords(pieceText))break;
        const i=item.emitted.length;emit(i,pieceText,start,false);
        item.emitted.push({text:pieceText,end:cut,confirmed:false});start=cut;
        break;
      }
      const i=item.emitted.length;emit(i,c.text,start,item.final||c.complete);
      item.emitted.push({text:c.text,end:offset+c.end,confirmed:false});start=offset+c.end;
    }
    if(result.length)item.lastAt=now;
    while(this.items.size>UTTERANCE_ITEM_LIMIT)this.items.delete(this.items.keys().next().value!);
    return result;
  }
}
const spokenText=(text:string)=>text.replace(/[\p{P}\p{Z}\s]/gu,'');
const hasWords=(text:string)=>spokenText(text).length>0;
const withoutEnding=(text:string)=>text.replace(/[\s、，,.。！？!?；;：:」』）”’]+$/u,'');
function afterPunctuation(chars:string[],offset:number){
  if(offset)while(offset<chars.length&&/[\s、，,。！？!?；;：:」』）”’]/.test(chars[offset]))offset++;
  return offset;
}

/** Map code-point boundaries through a corrected snapshot. Append-only updates skip this.
 * Align the old snapshot to a prefix of the new one: its appended suffix is free.
 * A shared sentence ending must not anchor old text to a later, newly spoken sentence.
 */
function alignBoundaries(before:string,after:string):number[]{
  const a=Array.from(before),b=Array.from(after),positions=new Array<number>(a.length+1);let head=0;
  while(head<a.length&&head<b.length&&a[head]===b[head]){positions[head]=head;head++;}positions[head]=head;
  const n=a.length-head,m=b.length-head,width=m+1,edit=n+1,d=new Int32Array((n+1)*width);
  // Minimize edits first, then prefer exact matches (e.g. 甲。 -> 甲乙。 keeps 。).
  for(let i=0;i<=n;i++)d[i*width]=i*edit;for(let j=0;j<=m;j++)d[j]=j*edit;
  for(let i=1;i<=n;i++)for(let j=1;j<=m;j++)d[i*width+j]=Math.min(d[(i-1)*width+j]+edit,d[i*width+j-1]+edit,d[(i-1)*width+j-1]+(a[head+i-1]===b[head+j-1]?-1:edit));
  let i=n,j=0;
  for(let k=1;k<=m;k++)if(d[n*width+k]<d[n*width+j]||d[n*width+k]===d[n*width+j]&&Math.abs(k-n)<Math.abs(j-n))j=k;
  while(i||j){
    const value=d[i*width+j];
    if(j&&value===d[i*width+j-1]+edit){j--;continue;}
    positions[head+i]=head+j;
    if(i&&j&&value===d[(i-1)*width+j-1]+(a[head+i-1]===b[head+j-1]?-1:edit)){i--;j--;}
    else i--;
  }
  return positions;
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
