export const LANGUAGES = [
  ['zh-Hans', '简体中文'], ['zh-Hant', '繁體中文'], ['en', 'English'],
  ['ja', '日本語'], ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['es', 'Español'], ['pt', 'Português'], ['ru', 'Русский'], ['ar', 'العربية'],
  ['it', 'Italiano'], ['vi', 'Tiếng Việt'], ['th', 'ไทย'], ['hi', 'हिन्दी']
] as const;
export type DisplayMode = 'replace' | 'bilingual';
export interface Profile {
  id: string; name: string; type: 'deepseek' | 'compatible'; baseUrl: string;
  apiKey: string; model: string; jsonMode: boolean; stream: boolean;
  disableThinking: boolean; inputPrice: number; outputPrice: number;
}
export interface Settings {
  version: 1; profiles: Profile[]; activeProfileId: string; target: string;
  display: DisplayMode; includeContext: boolean; maxPageChars: number;
  dynamic: boolean; cacheEnabled: boolean;
}
export interface PublicConfig {
  profileId: string; profileName: string; target: string; display: DisplayMode;
  includeContext: boolean; maxPageChars: number; dynamic: boolean; ready: boolean;
}
export interface Segment { id: string; text: string }
export interface TextBlock { id: string; context: string; segments: Segment[] }
export interface TranslationInput {
  kind: 'page' | 'selection' | 'subtitle' | 'test'; requestId: string; taskId: string;
  profileId: string; target: string; blocks: TextBlock[];
}
export interface TranslationResult {
  segments: Segment[]; cached: boolean; usage: { input: number; output: number; estimatedCost: number; requests?:number };
}
export interface TranslationObserver {start?:(streaming:boolean)=>void;token?:()=>void;text?:(text:string)=>void}
export interface PageStatus {
  state: 'idle' | 'scanning' | 'translating' | 'watching' | 'done' | 'stopped';
  total: number; completed: number; failed: number; chars: number;
  limited: boolean; message: string; display: DisplayMode;
}
export interface VideoStatus {state:'idle'|'loading'|'active'|'stopped'|'error';source:string;completed:number;message:string;bilingual:boolean}
export const NO_VIDEO_CAPTION_MESSAGE='这个视频没有可读取的字幕。请打开工具栏弹窗，点击「开始实时翻译」。';
export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  profiles: [{ id: 'deepseek-default', name: 'DeepSeek', type: 'deepseek',
    baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-flash',
    jsonMode: false, stream: true, disableThinking: true, inputPrice: 0, outputPrice: 0 }],
  activeProfileId: 'deepseek-default', target: 'zh-Hans', display: 'replace',
  includeContext: false, maxPageChars: 100000, dynamic: true, cacheEnabled: true
};
export const EMPTY_STATUS: PageStatus = {state: 'idle', total: 0, completed: 0,
  failed: 0, chars: 0, limited: false, message: '', display: 'replace'};
export const EMPTY_VIDEO_STATUS:VideoStatus={state:'idle',source:'',completed:0,message:'有字幕的视频可开启翻译。',bilingual:true};
const PAGE_STATES=['idle','scanning','translating','watching','done','stopped'] as const;
const VIDEO_STATES=['idle','loading','active','stopped','error'] as const;
function count(value:unknown):value is number{return typeof value==='number'&&Number.isFinite(value)&&value>=0;}
export function isPageStatus(value:unknown):value is PageStatus{
  if(!value||typeof value!=='object')return false;
  const s=value as PageStatus;
  return (PAGE_STATES as readonly string[]).includes(s.state)&&(['total','completed','failed','chars'] as const).every(key=>count(s[key]))&&typeof s.limited==='boolean'&&typeof s.message==='string'&&(s.display==='replace'||s.display==='bilingual');
}
export function isVideoStatus(value:unknown):value is VideoStatus{
  if(!value||typeof value!=='object')return false;
  const s=value as VideoStatus;
  return (VIDEO_STATES as readonly string[]).includes(s.state)&&typeof s.source==='string'&&count(s.completed)&&typeof s.message==='string'&&typeof s.bilingual==='boolean';
}
// 页面脚本未注入，或监听了消息却没有回传状态时，保留已保存进度并回到空闲。
export function pageStatusOrIdle(live:unknown,stored?:unknown):PageStatus{
  if(isPageStatus(live))return live;
  const merged:PageStatus={...EMPTY_STATUS,...(stored&&typeof stored==='object'?stored as Partial<PageStatus>:{}),state:'idle',message:''};
  return isPageStatus(merged)?merged:{...EMPTY_STATUS};
}
export function videoStatusOrEmpty(value:unknown):VideoStatus{return isVideoStatus(value)?value:{...EMPTY_VIDEO_STATUS};}
export function isTarget(target: unknown): target is string {
  return typeof target === 'string' && LANGUAGES.some(([id]) => id === target);
}
export function configFor(settings: Settings): PublicConfig {
  const p = settings.profiles.find(p => p.id === settings.activeProfileId);
  return { profileId: p?.id ?? '', profileName: p?.name ?? '', target: settings.target,
    display: settings.display, includeContext: settings.includeContext,
    maxPageChars: settings.maxPageChars, dynamic: settings.dynamic,
    ready: !!(p?.apiKey && p?.model) };
}
