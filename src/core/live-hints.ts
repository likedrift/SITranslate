/** Short, stable copy for live-speech safeguards. Keep these sentences in one place. */
export const PAUSE_SCROLL_NOTE = '暂停滚动仍在采集和计费';
export const PAUSE_SCROLL_POPUP_NOTE = '暂停字幕滚动不会停止采集和计费。';
export const STREAM_OFF_WARNING = '未开启流式响应。实时字幕需等整段译完，延迟会更高。';

export function liveInterruptHint(cause: unknown): string {
  if (cause === 'seek') return '拖动进度后已停止。请重新点击「开始实时翻译」。';
  if (cause === 'video') return '视频已切换，已停止。请重新点击「开始实时翻译」。';
  if (cause === 'refresh') return '页面已刷新，已停止。请重新点击「开始实时翻译」。';
  if (cause === 'leave') return '页面已离开，已停止。请重新点击「开始实时翻译」。';
  return '已停止。请重新点击「开始实时翻译」。';
}
