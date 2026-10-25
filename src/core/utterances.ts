export interface SpeechPiece {id:string;order:number;text:string;final:boolean;at:number;context?:string;traceId?:string;sourceEndAt?:number}
interface Item {text:string;final:boolean;lastAt:number;emitted:Map<number,string>;base:number}
interface Chunk {text:string;complete:boolean}
// Confirmed prefixes only. Draft suffixes never trigger translation.
export const UTTERANCE_CHUNK_CHARS=36;
export const UTTERANCE_TAIL_CHARS=12;
export const UTTERANCE_TAIL_HOLD_MS=800;
export class Utterances {
  private items=new Map<string,Item>();private order=0;
  reset(){this.items.clear();this.order=0;}
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
      result.push({id:`${id}:${i}`,order:item.base+i,text:c.text,final:item.final||c.complete,at:now,context:chunks.slice(0,i).map(c=>c.text).join('').slice(-400)});item.emitted.set(i,c.text);
    }
    if(result.length)item.lastAt=now;
    while(this.items.size>32)this.items.delete(this.items.keys().next().value!);
    return result;
  }
}
export const LIVE_QUEUE_LIMIT=3;
export function enqueuePiece(queue:SpeechPiece[],piece:SpeechPiece){
  const index=queue.findIndex(p=>p.id===piece.id);if(index>=0)queue[index]=piece;else queue.push(piece);
  queue.sort((a,b)=>a.order-b.order);return queue.slice(-LIVE_QUEUE_LIMIT);
}
