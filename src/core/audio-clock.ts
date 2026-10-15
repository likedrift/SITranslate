// Metadata only. ASR times are relative to audio actually uploaded on this connection.
export class AudioClock {
  private frames:{start:number;end:number;at:number}[]=[];private elapsed=0;
  reset(){this.frames=[];this.elapsed=0;}
  upload(samples:number,now=Date.now()){const duration=samples/16;this.frames.push({start:this.elapsed,end:this.elapsed+duration,at:now});this.elapsed+=duration;if(this.frames.length>300)this.frames.shift();}
  endAt(ms:number){if(!Number.isFinite(ms)||ms<0)return;const f=this.frames.find(f=>ms>=f.start&&ms<=f.end);return f?Math.round(f.at-(f.end-ms)):undefined;}
}
