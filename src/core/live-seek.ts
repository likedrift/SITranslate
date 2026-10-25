/** HTML live media: a finite duration, including NaN before metadata, stays VOD. */
export const LIVE_SEEK_BACK_TOLERANCE_SEC = 15;

export function isLiveDuration(duration: number): boolean {
  return duration === Infinity;
}

/**
 * VOD seeking always stops capture. On a live stream, forward jumps (back to
 * the live edge) and backward jitter within the tolerance keep the session.
 * A larger backward jump is the detectable user scrub away from the playhead.
 */
export function shouldInterruptSeek(duration: number, from: number, to: number, toleranceSec = LIVE_SEEK_BACK_TOLERANCE_SEC): boolean {
  if (!isLiveDuration(duration)) return true;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return from - to > toleranceSec;
}

/** Remembers the last playhead sampled while the element was not seeking. */
export class LiveSeekGuard {
  private playhead = NaN;
  note(time: number, seeking = false) {
    if (seeking || !Number.isFinite(time)) return;
    this.playhead = time;
  }
  /** True when this seeking event should call interrupt('seek'). */
  onSeeking(duration: number, time: number): boolean {
    const interrupt = shouldInterruptSeek(duration, this.playhead, time);
    if (Number.isFinite(time)) this.playhead = time;
    return interrupt;
  }
}
