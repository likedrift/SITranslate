export interface SubtitleCue {id:string;start:number;end:number;text:string;context:string}
export function cueIndex(cues:ArrayLike<{startTime:number}>,time:number) {
  let low=0,high=cues.length;while(low<high){const mid=(low+high)>>>1;if(cues[mid].startTime<time)low=mid+1;else high=mid;}return low;
}
export function activeSubtitle(cues:SubtitleCue[],time:number) {
  return cues.filter(c=>c.start<=time&&time<c.end);
}
export function subtitleText(text:string){return text.replace(/\s+/g,' ').trim().slice(0,2000);}

export interface YouTubePendingLine {text:string;context:string}

const YT_STABLE_MS = 300;
const YT_SENTENCE_MS = 150;
const YT_MAX_WAIT_MS = 750;
const YT_MAX_CACHE = 240;

function hasTextOverlap(a:string,b:string){
  if(!a||!b)return false;
  if(a===b||a.startsWith(b)||b.startsWith(a))return true;
  const short=a.length<=b.length?a:b,long=a.length<=b.length?b:a;
  if(short.length>=4&&long.includes(short))return true;
  // Rolling captions often drop leading words while appending new ones.
  const maxCheck=Math.min(a.length,b.length),minOverlap=Math.max(4,Math.floor(short.length*0.35));
  for(let len=maxCheck;len>=minOverlap;len--){
    if(a.endsWith(b.slice(0,len))||b.endsWith(a.slice(0,len)))return true;
  }
  const wordsA=new Set(a.toLowerCase().split(/\s+/).filter(w=>w.length>=2));
  const wordsB=b.toLowerCase().split(/\s+/).filter(w=>w.length>=2);
  if(wordsA.size>=2&&wordsB.length>=2){
    let shared=0;for(const w of wordsB)if(wordsA.has(w))shared++;
    if(shared/Math.min(wordsA.size,wordsB.length)>=0.4)return true;
  }
  return false;
}

/**
 * Tracks visible YouTube caption lines across rolling/word-by-word updates.
 * Prevents debounce starvation, reuses cached translations per line, and keeps
 * overlapping in-flight translations visible instead of dropping them on drift.
 */
export class YouTubeCaptionTracker {
  private lines:string[]=[];
  private translations=new Map<string,string>();
  private failed=new Set<string>();
  private previousLine='';
  private firstPendingAt:number|undefined;
  private lastChangedAt=0;
  private pendingSignature='';

  reset(){
    this.lines=[];this.translations.clear();this.failed.clear();
    this.previousLine='';this.firstPendingAt=undefined;this.lastChangedAt=0;this.pendingSignature='';
  }

  retry(now:number){
    this.failed.clear();
    if(this.untranslated().length){
      this.firstPendingAt=now-YT_MAX_WAIT_MS;
      this.lastChangedAt=now-YT_STABLE_MS;
    }
  }

  get hasContent(){return this.lines.length>0;}

  update(rawLines:string[],now:number){
    const next:string[]=[];
    for(const raw of rawLines){
      const clean=subtitleText(raw);
      if(clean&&next.at(-1)!==clean)next.push(clean);
    }
    if(!next.length){
      this.lines=[];this.pendingSignature='';this.firstPendingAt=undefined;return;
    }
    for(const prev of this.lines){
      if(prev.length>=4&&!next.some(line=>line===prev||line.startsWith(prev)))this.previousLine=prev;
    }
    this.lines=next;
    const missing=this.untranslated();
    const sig=missing.join('\n');
    if(!sig){
      this.pendingSignature='';this.firstPendingAt=undefined;return;
    }
    if(sig!==this.pendingSignature){
      if(!this.pendingSignature||this.firstPendingAt===undefined)this.firstPendingAt=now;
      this.lastChangedAt=now;
      this.pendingSignature=sig;
    }
  }

  readyToTranslate(now:number):YouTubePendingLine[]{
    const missing=this.untranslated();
    if(!missing.length)return [];
    const stable=now-this.lastChangedAt>=YT_STABLE_MS;
    const maxWait=this.firstPendingAt!==undefined&&now-this.firstPendingAt>=YT_MAX_WAIT_MS;
    const last=missing[missing.length-1];
    const sentenceEnd=/[.!?。！？…」』"']\s*$/.test(last)&&now-this.lastChangedAt>=YT_SENTENCE_MS;
    if(!stable&&!maxWait&&!sentenceEnd)return [];
    return missing.map(text=>{
      const idx=this.lines.indexOf(text);
      const prev=idx>0?this.lines[idx-1]:this.previousLine;
      const context=prev&&!text.startsWith(prev)?prev.slice(-800):'';
      return {text,context};
    });
  }

  markDispatched(){
    this.firstPendingAt=undefined;
  }

  applyTranslations(items:Array<{source:string;translation:string}>,now:number){
    for(const {source,translation} of items){
      if(!source||!translation)continue;
      this.failed.delete(source);
      this.translations.delete(source);
      this.translations.set(source,translation);
      while(this.translations.size>YT_MAX_CACHE){
        const oldest=this.translations.keys().next().value!;
        this.translations.delete(oldest);
      }
    }
    const missing=this.untranslated();
    const sig=missing.join('\n');
    this.pendingSignature=sig;
    if(sig&&this.firstPendingAt===undefined)this.firstPendingAt=now;
  }

  markFailed(sources:string[]){
    for(const source of sources)if(source)this.failed.add(source);
    this.pendingSignature=this.untranslated().join('\n');
    if(!this.pendingSignature)this.firstPendingAt=undefined;
  }

  display():{source:string;translation:string}{
    if(!this.lines.length)return {source:'',translation:''};
    const source=this.lines.join('\n');
    const cached=[...this.translations.entries()];
    const out:string[]=[];
    for(const line of this.lines){
      const exact=this.translations.get(line);
      if(exact){out.push(exact);continue;}
      let fallback='';
      for(let i=cached.length-1;i>=0;i--){
        const [src,trans]=cached[i];
        if(hasTextOverlap(line,src)){fallback=trans;break;}
      }
      if(fallback&&out.at(-1)!==fallback)out.push(fallback);
    }
    return {source,translation:out.join('\n')};
  }

  private untranslated(){
    return this.lines.filter(line=>!this.translations.has(line)&&!this.failed.has(line));
  }
}
