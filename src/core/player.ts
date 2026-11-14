export interface PlayerState {
  speech: {state:string;message:string;needsActivation?:boolean};
  captions: {state:string;message:string};
  shortcut: string;
}

export function isYouTubePage(url:string){
  try{const u=new URL(url);return u.protocol==='https:'&&(u.hostname==='youtube.com'||u.hostname.endsWith('.youtube.com'));}catch{return false;}
}
