export interface SpeechTrace {id:string;createdAt:number;sourceChars:number;targetChars?:number;streaming?:boolean;asrMs?:number;commitMs?:number;queueMs?:number;schedulerMs?:number;firstTokenMs?:number;firstTextMs?:number;translationMs?:number;displayWaitMs?:number;firstPaintMs?:number;audioToPaintMs?:number;outcome?:'completed'|'failed'|'stale'|'skipped'|'cancelled';cache?:boolean}
export interface DiagnosticSettings {asrModel?:string;language?:'ja'|'en'|'zh'|'auto';textModel?:string;textStream?:boolean;readingMode?:'balanced'|'live';target?:string}
const modelName=(value:unknown)=>{if(typeof value!=='string')return;const name=value.trim();if(!name||name.length>120||/[\s:@?#]/.test(name)||name.includes('//'))return;return name;};
export function diagnosticSettings(input:{asrModel?:unknown;language?:unknown;textModel?:unknown;textStream?:unknown;readingMode?:unknown;target?:unknown}):DiagnosticSettings{
  const settings:DiagnosticSettings={};
  const asrModel=modelName(input.asrModel);if(asrModel)settings.asrModel=asrModel;
  if(input.language==='ja'||input.language==='en'||input.language==='zh'||input.language==='auto')settings.language=input.language;
  const textModel=modelName(input.textModel);if(textModel)settings.textModel=textModel;
  if(typeof input.textStream==='boolean')settings.textStream=input.textStream;
  if(input.readingMode==='balanced'||input.readingMode==='live')settings.readingMode=input.readingMode;
  if(typeof input.target==='string'&&/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(input.target))settings.target=input.target;
  return settings;
}
export const DIAGNOSTIC_ROW_LIMIT=100;
export class SpeechDiagnostics {
  rows:SpeechTrace[]=[];
  load(rows:SpeechTrace[]){this.rows=Array.isArray(rows)?rows.slice(-DIAGNOSTIC_ROW_LIMIT):[];}
  add(row:SpeechTrace){this.rows.push(row);if(this.rows.length>DIAGNOSTIC_ROW_LIMIT)this.rows.shift();}
  update(id:string,patch:Partial<SpeechTrace>){const row=this.rows.find(r=>r.id===id);if(row)Object.assign(row,patch);}
  clear(){this.rows=[];}
  report(){const metrics:Record<string,{samples:number;p50:number;p95:number}>={};for(const key of ['asrMs','commitMs','queueMs','schedulerMs','firstTokenMs','firstTextMs','translationMs','displayWaitMs','firstPaintMs','audioToPaintMs'] as const){const values=this.rows.map(r=>r[key]).filter((n):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0).sort((a,b)=>a-b);if(values.length)metrics[key]={samples:values.length,p50:Math.round(values[Math.ceil(values.length*.5)-1]),p95:Math.round(values[Math.ceil(values.length*.95)-1])};}const outcomes={completed:0,failed:0,stale:0,skipped:0,cancelled:0,pending:0};for(const row of this.rows){const key=row.outcome??'pending';if(key in outcomes)outcomes[key as keyof typeof outcomes]++;}return {schema:2,samples:this.rows.length,metrics,outcomes,rows:this.rows.map(r=>({...r}))};}
}
