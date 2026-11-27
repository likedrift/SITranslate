declare const __SI_EDITION__: 'oss' | 'pro' | undefined;
declare const __SI_BUILD_MODE__: 'dev' | 'prod' | undefined;

export type Edition = 'oss' | 'pro';
export type BuildMode = 'dev' | 'prod';

export const EDITION: Edition = typeof __SI_EDITION__ !== 'undefined' ? __SI_EDITION__ : 'oss';
export const BUILD_MODE: BuildMode = typeof __SI_BUILD_MODE__ !== 'undefined' ? __SI_BUILD_MODE__ : 'prod';
export const isProEdition = (): boolean => EDITION === 'pro';

const DEV_LOOPBACK_WS = new Set(['ws://127.0.0.1/*', 'ws://localhost/*', 'ws://[::1]/*']);

/** Strips test-only loopback WebSocket host permissions for Chrome Web Store production builds. */
export function buildManifest<T extends { host_permissions?: string[]; name?: string }>(
  raw: T,
  options: { mode?: BuildMode; edition?: Edition } = {}
): T {
  const mode = options.mode ?? 'prod';
  const edition = options.edition ?? 'oss';
  const copy: T = structuredClone(raw);
  if (Array.isArray(copy.host_permissions)) {
    const filtered = mode === 'prod'
      ? copy.host_permissions.filter(item => !DEV_LOOPBACK_WS.has(item))
      : [...new Set([...copy.host_permissions, ...DEV_LOOPBACK_WS])];
    copy.host_permissions = filtered;
  }
  if (edition === 'pro' && typeof copy.name === 'string' && !copy.name.includes('Pro')) {
    copy.name = `${copy.name} Pro`;
  }
  return copy;
}
