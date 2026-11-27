# 隐私政策 · Privacy Policy

最后更新日期 / Last Updated: 2026-11-28

## 中文说明

**思译（Si Translate）** 是一款本地优先、自带密钥（BYOK）的浏览器翻译扩展。我们严格遵循最小数据访问与用户主动触发原则：

1. **无自有中转服务器与遥测收集**
   - 思译不设任何账号系统、广告 SDK、第三方统计或后台遥测。
   - 您的网页文本、划词内容、视频字幕与标签页音频 **绝不会** 发送给思译开发者，仅在您明确点击翻译或开启实时语音后，由浏览器直接发送至您自行配置的大模型或语音识别服务商接口（例如 DeepSeek、OpenAI 兼容接口、阿里云百炼 DashScope）。
2. **密钥与配置的本地隔离存储**
   - 您填写的 API Key、模型地址、术语表与偏好仅保存在当前浏览器设备的 `chrome.storage.local`（`TRUSTED_CONTEXTS` 隔离级别），网页端脚本（Content Script）无法读取任何密钥，也不会通过浏览器账号跨设备明文上传。
3. **严格的按需触发边界**
   - 浏览普通网页或仅用鼠标选中文字 **不会** 产生任何网络请求；只有点击「翻译此页」、点击划词浮窗按钮、开启视频字幕翻译或开启实时语音翻译时才会发起调用。
   - 实时语音翻译仅在用户主动开启时采集当前单个标签页的播放声音（`tabCapture`），**永不访问麦克风或摄像头**，也不在本地持久化保存音频录音；点击停止、关闭标签页或切换页面时立即释放音轨与临时会话鉴权。
4. **本地缓存与诊断数据**
   - 会话译文缓存与本地延迟诊断数据仅保存在本机内存与 `chrome.storage.session` 中，关闭浏览器后自动销毁；导出的诊断 JSON 仅包含匿名耗时数字指标，不含原文、译文、音频、网址或 API Key。

---

## English Summary

**Si Translate** is a local-first, Bring-Your-Own-Key (BYOK) browser extension:

1. **Zero Developer Servers or Telemetry**: We do not collect, log, store, or transmit your browsing history, page content, audio, or API keys to any server operated by us.
2. **Direct User-Configured API Calls**: Text and tab audio are sent directly from your browser to the LLM / ASR endpoints you explicitly configure, and **only** after an explicit user action (clicking translate or enabling subtitle/speech translation). Selection alone never triggers network requests.
3. **Isolated Local Storage**: API keys are stored exclusively on your device in `chrome.storage.local` with `TRUSTED_CONTEXTS` access control, inaccessible to web pages and content scripts.
4. **Ephemeral Tab Audio**: Live speech translation uses `chrome.tabCapture` on the active tab only while explicitly enabled, never accesses your microphone or camera, and stores no audio recordings.
