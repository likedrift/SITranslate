import type { Profile, TranslationInput, TranslationResult, Segment } from './types';
export interface CacheEntry { key:string; texts:string[]; bytes:number; time:number }
export class TranslationCache {
  private entries = new Map<string,CacheEntry>();
  private bytes = 0;
  constructor(private limit=4*1024*1024) {}
  load(items:CacheEntry[]) {for(const item of items) if(item && typeof item.key==='string' && Array.isArray(item.texts) && item.texts.every(t=>typeof t==='string'))this.put(item.key,item.texts);}
  get(key:string,input:TranslationInput):TranslationResult|undefined {
    const entry=this.entries.get(key),segments=input.blocks.flatMap(b=>b.segments);
    if(!entry || entry.texts.length!==segments.length)return;
    this.entries.delete(key);this.entries.set(key,entry);
    return {segments:segments.map((s,i)=>({id:s.id,text:entry.texts[i]})),cached:true,usage:{input:0,output:0,estimatedCost:0}};
  }
  put(key:string,texts:string[]) {
    const bytes=new TextEncoder().encode(JSON.stringify({key,texts})).byteLength;
    if(bytes>this.limit)return;
    const old=this.entries.get(key);if(old){this.bytes-=old.bytes;this.entries.delete(key);}
    this.entries.set(key,{key,texts,bytes,time:Date.now()});this.bytes+=bytes;
    while(this.bytes>this.limit){const first=this.entries.keys().next().value!;this.bytes-=this.entries.get(first)!.bytes;this.entries.delete(first);}
  }
  clear(){this.entries.clear();this.bytes=0;}
  snapshot(){return [...this.entries.values()];}
  size(){return {bytes:this.bytes,entries:this.entries.size};}
  async lookupBlocks(profile:Profile,input:TranslationInput) {
    const keys=await Promise.all(input.blocks.map(block=>cacheKey(profile,{...input,blocks:[block]})));
    const segments:Segment[]=[],missing:TranslationInput['blocks']=[];
    input.blocks.forEach((block,i)=>{
      const hit=this.get(keys[i],{...input,blocks:[block]});
      if(hit)segments.push(...hit.segments);else missing.push(block);
    });
    return {keys,segments,missing};
  }
  putBlocks(keys:string[],input:TranslationInput,result:TranslationResult) {
    const output=new Map(result.segments.map(segment=>[segment.id,segment.text]));
    input.blocks.forEach((block,i)=>{
      if(block.segments.every(segment=>output.has(segment.id)))this.put(keys[i],block.segments.map(segment=>output.get(segment.id)!));
    });
  }
}
export async function cacheKey(profile:Profile,input:TranslationInput) {
  const value=JSON.stringify({version:2,profile:profile.id,type:profile.type,endpoint:profile.baseUrl,model:profile.model,
    json:profile.jsonMode,thinking:profile.disableThinking,target:input.target,kind:input.kind,
    blocks:input.blocks.map(b=>({context:b.context,texts:b.segments.map(s=>s.text)}))});
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
