import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LIVE_SEEK_BACK_TOLERANCE_SEC, LiveSeekGuard, isLiveDuration, shouldInterruptSeek} from '../src/core/live-seek.ts';

const interruptLog = () => {
  const calls: string[] = [];
  const guard = new LiveSeekGuard();
  const seek = (duration: number, time: number) => {
    if (guard.onSeeking(duration, time)) calls.push('interrupt');
  };
  return {calls, guard, seek};
};

test('only an infinite duration is live', () => {
  assert.equal(isLiveDuration(Infinity), true);
  for (const duration of [NaN, 0, 1, 3600, -1, Number.MAX_VALUE]) assert.equal(isLiveDuration(duration), false);
  assert.equal(LIVE_SEEK_BACK_TOLERANCE_SEC, 15);
});

test('live edge and buffer seeks do not call interrupt', () => {
  const {calls, guard, seek} = interruptLog();
  guard.note(500, false);
  seek(Infinity, 560);
  seek(Infinity, 552);
  seek(Infinity, 552);
  seek(Infinity, 552 - LIVE_SEEK_BACK_TOLERANCE_SEC);
  assert.deepEqual(calls, []);
});

test('a large live rewind calls interrupt once per seek', () => {
  const {calls, guard, seek} = interruptLog();
  guard.note(500, false);
  seek(Infinity, 500 - LIVE_SEEK_BACK_TOLERANCE_SEC - 0.1);
  assert.deepEqual(calls, ['interrupt']);
  seek(Infinity, 400);
  assert.deepEqual(calls, ['interrupt', 'interrupt']);
});

test('vod seeking still calls interrupt, including a seek that does not move', () => {
  for (const duration of [NaN, 0, 180, 3600]) {
    const {calls, guard, seek} = interruptLog();
    guard.note(40, false);
    seek(duration, 40);
    seek(duration, 12);
    seek(duration, 90);
    assert.deepEqual(calls, ['interrupt', 'interrupt', 'interrupt']);
  }
});

test('an unknown live playhead does not call interrupt, then later deltas use the new time', () => {
  const {calls, guard, seek} = interruptLog();
  guard.note(NaN, false);
  seek(Infinity, 1000);
  assert.deepEqual(calls, []);
  seek(Infinity, 990);
  assert.deepEqual(calls, []);
  seek(Infinity, 990 - LIVE_SEEK_BACK_TOLERANCE_SEC - 1);
  assert.deepEqual(calls, ['interrupt']);
});

test('samples taken while seeking do not hide a large rewind', () => {
  const {calls, guard, seek} = interruptLog();
  guard.note(200, false);
  guard.note(20, true);
  seek(Infinity, 20);
  assert.deepEqual(calls, ['interrupt']);
});

test('playback samples move the baseline so a later buffer seek stays small', () => {
  const {calls, guard, seek} = interruptLog();
  guard.note(100, false);
  guard.note(180, false);
  seek(Infinity, 172);
  assert.deepEqual(calls, []);
});

test('tolerance override only changes the live backward boundary', () => {
  assert.equal(shouldInterruptSeek(Infinity, 100, 70, 30), false);
  assert.equal(shouldInterruptSeek(Infinity, 100, 70, 10), true);
  assert.equal(shouldInterruptSeek(90, 100, 100, 30), true);
});
