export interface LiveCaption {id:string;version:string;source:string;text:string;final:boolean;traceId?:string;sourceEndAt?:number;arrivedAt:number}
export const readingMs=(text:string)=>Math.min(6000,Math.max(1500,900+Array.from(text).length*90));
// Bounded reading buffer; no audio, DOM or timers. The page owns its existing refresh timer.
export class LiveReader {
  private confirmed=new Map<string,LiveCaption>();
  items:LiveCaption[]=[];currentId='';paused=false;shownAt=0;finalAt=0;dropped:LiveCaption[]=[];
  get current(){return this.items.find(c=>c.id===this.currentId);}
  get previous(){const i=this.items.findIndex(c=>c.id===this.currentId);return this.items.slice(0,i).filter(c=>c.final).at(-1);}
  get pending(){const i=this.items.findIndex(c=>c.id===this.currentId);return this.items.slice(i+1).length;}
  reset(){this.items=[];this.confirmed.clear();this.currentId='';this.paused=false;this.shownAt=0;this.finalAt=0;this.dropped=[];}
  receive(cue:LiveCaption,now:number,mode='balanced'){
    const old=this.items.find(c=>c.id===cue.id);if(old){if(old.version===cue.version&&old.final&&!cue.final)return;const wasFinal=old.final,arrivedAt=old.version===cue.version?old.arrivedAt:cue.arrivedAt;Object.assign(old,cue,{arrivedAt});if(cue.id===this.currentId&&cue.final&&!wasFinal)this.finalAt=now;}
    else this.items.push(cue);
    if(cue.final)this.confirmed.set(cue.id,{...cue});
    if(!this.currentId)this.show(cue,now);
    while(this.pending>3){const i=this.items.findIndex(c=>c.id===this.currentId)+1;this.dropped.push(...this.items.splice(i,1));}
    while(this.items.length>8){const i=this.items.findIndex(c=>c.id!==this.currentId);this.items.splice(i,1);}
    for(const id of this.confirmed.keys())if(!this.items.some(c=>c.id===id))this.confirmed.delete(id);
    this.tick(now,mode);
  }
  tick(now:number,mode='balanced'){
    const current=this.current;if(!current||this.paused||!current.final||!this.pending)return;
    const i=this.items.findIndex(c=>c.id===current.id);
    while(this.pending>1&&now-this.items[i+1].arrivedAt>4000)this.dropped.push(...this.items.splice(i+1,1));
    const next=this.items[i+1];if(!next)return;
    const deadline=Math.min(Math.max(this.shownAt+readingMs(current.text),this.finalAt+800),next.arrivedAt+2500);
    if(mode!=='live'&&now<deadline)return;this.show(next,now);
  }
  private show(cue:LiveCaption,now:number){this.currentId=cue.id;this.shownAt=now;this.finalAt=cue.final?now:0;}
  back(now:number){const i=this.items.findIndex(c=>c.id===this.currentId);if(i>0){this.paused=true;this.show(this.items[i-1],now);}}
  forward(now:number){const i=this.items.findIndex(c=>c.id===this.currentId);if(i+1<this.items.length){this.paused=true;this.show(this.items[i+1],now);}}
  latest(now:number){this.paused=false;const cue=this.items.at(-1);if(cue)this.show(cue,now);}
  withdraw(id:string,version:string,now:number){const i=this.items.findIndex(c=>c.id===id&&c.version===version&&!c.final);if(i<0)return;const old=this.items[i],saved=this.confirmed.get(id);this.dropped.push(old);if(saved){this.items[i]={...saved};if(this.currentId===id)this.show(this.items[i],now);}else{this.items.splice(i,1);if(this.currentId===id){this.currentId='';const cue=this.items.at(-1);if(cue)this.show(cue,now);}}}
}
