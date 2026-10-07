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
  kind: 'page' | 'selection' | 'test'; requestId: string; taskId: string;
  profileId: string; target: string; blocks: TextBlock[];
}
export interface TranslationResult {
  segments: Segment[]; cached: boolean; usage: { input: number; output: number; estimatedCost: number };
}
export interface PageStatus {
  state: 'idle' | 'scanning' | 'translating' | 'watching' | 'done' | 'stopped';
  total: number; completed: number; failed: number; chars: number;
  limited: boolean; message: string; display: DisplayMode;
}
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
