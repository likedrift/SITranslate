export interface SpeechTrace {id:string;createdAt:number;sourceChars:number;targetChars?:number;streaming?:boolean;asrMs?:number;commitMs?:number;queueMs?:number;schedulerMs?:number;firstTokenMs?:number;firstTextMs?:number;translationMs?:number;displayWaitMs?:number;firstPaintMs?:number;audioToPaintMs?:number;outcome?:'completed'|'failed'|'stale'|'skipped'|'cancelled';cache?:boolean}
export class SpeechDiagnostics {
  rows:SpeechTrace[]=[];
  load(rows:SpeechTrace[]){this.rows=Array.isArray(rows)?rows.slice(-100):[];}
  add(row:SpeechTrace){this.rows.push(row);if(this.rows.length>100)this.rows.shift();}
  update(id:string,patch:Partial<SpeechTrace>){const row=this.rows.find(r=>r.id===id);if(row)Object.assign(row,patch);}
  clear(){this.rows=[];}
  report(){const metrics:Record<string,{samples:number;p50:number;p95:number}>={};for(const key of ['asrMs','commitMs','queueMs','schedulerMs','firstTokenMs','firstTextMs','translationMs','displayWaitMs','firstPaintMs','audioToPaintMs'] as const){const values=this.rows.map(r=>r[key]).filter((n):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0).sort((a,b)=>a-b);if(values.length)metrics[key]={samples:values.length,p50:Math.round(values[Math.ceil(values.length*.5)-1]),p95:Math.round(values[Math.ceil(values.length*.95)-1])};}return {schema:1,samples:this.rows.length,metrics,rows:this.rows.map(r=>({...r}))};}
}
