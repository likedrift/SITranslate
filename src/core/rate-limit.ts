/** First 429 (or equivalent) waits this long. Consecutive live hits double it, then cap. */
export const RATE_LIMIT_BACKOFF_MS = 2000;
export const RATE_LIMIT_BACKOFF_MAX_MS = 8000;
/** Existing single retry for other retryable provider failures (5xx). */
export const RETRYABLE_BACKOFF_MS = 1500;

export function rateLimitBackoffMs(streak: number): number {
  const step = Math.max(0, Math.min(Number.isFinite(streak) ? Math.floor(streak) : 0, 2));
  return Math.min(RATE_LIMIT_BACKOFF_MS * 2 ** step, RATE_LIMIT_BACKOFF_MAX_MS);
}

const RATE_LIMIT_TEXT = /rate[_\s-]?limit|too many requests|throttl(?:e|ing)?|ratequota|限流|请求过于频繁/i;

function collectText(payload: unknown, depth = 0): string {
  if (depth > 4) return '';
  if (typeof payload === 'string') return payload.slice(0, 500);
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload);
  if (!payload || typeof payload !== 'object') return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!/^(code|type|message|error|status|msg)$/i.test(key)) continue;
    parts.push(collectText(value, depth + 1));
    if (parts.join('').length > 2000) break;
  }
  return parts.join('\n').slice(0, 2000);
}

function payloadText(payload: unknown): string {
  if (typeof payload === 'string') {
    const snippet = payload.slice(0, 2048);
    try { return `${snippet}\n${collectText(JSON.parse(snippet))}`; } catch { return snippet; }
  }
  return collectText(payload);
}

/** HTTP 429, or a 400/5xx/SSE error body that names a rate limit. Auth and billing statuses stay out. */
export function isRateLimitPayload(status: number, payload: unknown): boolean {
  if (status === 429) return true;
  if (status !== 0 && status !== 400 && status < 500) return false;
  return RATE_LIMIT_TEXT.test(payloadText(payload));
}
