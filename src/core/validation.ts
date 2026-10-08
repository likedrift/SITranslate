import { isTarget, type Settings, type TranslationInput, type TextBlock } from './types';

export function endpointFor(base: string): {url: string; origin: string; permission: string} {
  let u: URL;
  try { u = new URL(base.trim()); } catch { throw new Error('请输入完整的 API 服务地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('服务地址须使用 HTTPS；本机服务可使用 HTTP。');
  if (u.username || u.password || u.search || u.hash) throw new Error('服务地址不能包含账户、查询参数或片段。');
  u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';
  return {url: u.href, origin: u.origin, permission: `${u.protocol}//${u.hostname}/*`};
}
const boundedString = (x: unknown, max: number) => typeof x === 'string' && x.length <= max;
export function validateSettings(value: unknown): asserts value is Settings {
  const s = value as Settings;
  if (!s || s.version !== 1 || !Array.isArray(s.profiles) || s.profiles.length < 1 || s.profiles.length > 12 ||
      !isTarget(s.target) || !['replace', 'bilingual'].includes(s.display) ||
      !Number.isInteger(s.maxPageChars) || s.maxPageChars < 10000 || s.maxPageChars > 500000 ||
      !['includeContext', 'dynamic', 'cacheEnabled'].every(k => typeof s[k as keyof Settings] === 'boolean')) throw new Error('设置格式无效。');
  const ids = new Set<string>();
  for (const p of s.profiles) {
    if (!p || !boundedString(p.id, 80) || !p.id || ids.has(p.id) || !boundedString(p.name, 80) || !p.name.trim() ||
        !['deepseek', 'compatible'].includes(p.type) || !boundedString(p.apiKey, 512) || !boundedString(p.model, 120) ||
        !p.model.trim() || !boundedString(p.baseUrl, 2048) ||
        !['jsonMode', 'stream', 'disableThinking'].every(k => typeof p[k as keyof typeof p] === 'boolean') ||
        ![p.inputPrice,p.outputPrice].every(n => Number.isFinite(n) && n >= 0 && n <= 10000)) throw new Error('服务商配置无效。');
    endpointFor(p.baseUrl); ids.add(p.id);
  }
  if (!ids.has(s.activeProfileId)) throw new Error('请选择有效的服务商。');
}
export function validateInput(value: unknown): asserts value is TranslationInput {
  const x = value as TranslationInput;
  if (!x || !['page','selection','subtitle','test'].includes(x.kind) || !isTarget(x.target) ||
      !boundedString(x.requestId,100) || !x.requestId || !boundedString(x.taskId,100) || !x.taskId ||
      !boundedString(x.profileId,80) || !Array.isArray(x.blocks) || x.blocks.length < 1 || x.blocks.length > 64) throw new Error('翻译请求无效。');
  const ids = new Set<string>(); let chars = 0; let contextChars = 0;
  const blockIds = new Set<string>();
  for (const b of x.blocks) {
    if (!b || !boundedString(b.id,80) || !b.id || blockIds.has(b.id) || !boundedString(b.context,2500) ||
        !Array.isArray(b.segments) || !b.segments.length || b.segments.length > 128) throw new Error('段落格式无效。');
    blockIds.add(b.id); contextChars += b.context.length;
    for (const s of b.segments) {
      if (!s || !boundedString(s.id,100) || !s.id || ids.has(s.id) || !boundedString(s.text,5000) || !s.text.trim()) throw new Error('文字片段格式无效。');
      ids.add(s.id); chars += s.text.length;
    }
  }
  if (chars > 12000 || contextChars > 12000 || ids.size > 256) throw new Error('本批次文字过长，请拆分后再试。');
}
export function parseSegments(content: string, expected: TextBlock[]) {
  const clean = content.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let parsed: unknown;
  try { parsed = JSON.parse(clean); } catch { throw new Error('模型返回的格式不完整。请重试，或更换模型。'); }
  const segments = (parsed as {segments?: unknown})?.segments;
  if (!Array.isArray(segments)) throw new Error('模型没有返回有效译文。');
  const wanted = new Map(expected.flatMap(b => b.segments).map(s => [s.id,s.text]));
  const found = new Map<string,string>();
  for (const s of segments) {
    if (!s || typeof s.id !== 'string' || typeof s.text !== 'string' || !wanted.has(s.id) || found.has(s.id) ||
        !s.text.trim() || s.text.length > Math.max(500, wanted.get(s.id)!.length * 12)) throw new Error('译文片段校验失败，原文已保留。');
    found.set(s.id,s.text);
  }
  if (found.size !== wanted.size) throw new Error('译文缺少片段，原文已保留。');
  return [...wanted.keys()].map(id => ({id,text:found.get(id)!}));
}
