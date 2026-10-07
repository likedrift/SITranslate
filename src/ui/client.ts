import {LANGUAGES} from '../core/types';
export async function rpc<T=unknown>(type:string,extra:Record<string,unknown>={}):Promise<T>{
  const reply=await chrome.runtime.sendMessage({type,...extra});if(!reply?.ok)throw new Error(reply?.error??'扩展连接中断，请重新打开。');return reply.data;
}
export const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
export const value=(id:string)=>(el<HTMLInputElement>(id)).value;
export const check=(id:string)=>(el<HTMLInputElement>(id)).checked;
export function languageOptions(select:HTMLSelectElement){for(const [id,label]of LANGUAGES){const option=document.createElement('option');option.value=id;option.textContent=label;select.append(option);}}
export function sitePattern(address:string){let url:URL;try{url=new URL(address);}catch{throw new Error('请输入完整网站地址，例如 https://example.com。');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('请输入 HTTP 或 HTTPS 网站地址。');return `${url.protocol}//${url.hostname}/*`;}
