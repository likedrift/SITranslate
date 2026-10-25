// Opening audio only. About two seconds at 16 kHz, matching the 100 ms worklet frames.
export const PREROLL_SAMPLE_RATE=16000;
export const PREROLL_FRAME_SAMPLES=1600;
export const PREROLL_MS=2000;
export const PREROLL_SAMPLES=PREROLL_SAMPLE_RATE*PREROLL_MS/1000;

export class AudioPreroll {
  private frames:{samples:Float32Array;at:number}[]=[];
  private total=0;
  constructor(readonly maxSamples=PREROLL_SAMPLES,readonly maxAgeMs=PREROLL_MS){}
  get samples(){return this.total;}
  get length(){return this.frames.length;}
  push(samples:Float32Array,now=Date.now()){
    if(samples.length<=0||!Number.isFinite(now))return;
    this.frames.push({samples,at:now});this.total+=samples.length;this.evict(now);
  }
  drain(now=Date.now()){this.evict(now);const out=this.frames;this.clear();return out;}
  clear(){this.frames=[];this.total=0;}
  private evict(now:number){
    const stale=(at:number)=>now-at>this.maxAgeMs;
    while(this.frames.length>1&&(this.total>this.maxSamples||stale(this.frames[0].at)))this.total-=this.frames.shift()!.samples.length;
    const only=this.frames[0];if(!only)return;
    if(stale(only.at)){this.clear();return;}
    if(this.total<=this.maxSamples)return;
    const tail=only.samples.subarray(only.samples.length-this.maxSamples),copy=new Float32Array(tail.length);copy.set(tail);
    this.frames=[{samples:copy,at:only.at}];this.total=copy.length;
  }
}
