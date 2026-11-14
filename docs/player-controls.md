# YouTube 播放器入口

## ViiTor 的实际做法

2026-11-14 对 [ViiTor 官网](https://www.viitor.info/) 提供的 [2.1.13 ZIP](https://viitor-cdn.viitor.com/blog/viitor_translate_extension_2.1.13.zip) 做静态检查，未安装或执行该扩展。结论针对这个安装包，不推断其他版本：

- manifest 在 YouTube 页面自动加载 `youtube-subtitle.js` 和样式。脚本查找 `.ytp-right-controls`，把按钮插到这一排控制项的前面，因此出现在进度条下方，与字幕、设置、全屏按钮同排。DOM 观察器和站内导航事件负责重新挂载。
- 该按钮的菜单开关调用 YouTube 字幕翻译流程。页面桥接脚本读取播放器的 `captionTracks`，请求或拦截 `timedtext`，失败时退回读取显示出来的字幕；文本交给后台翻译。它不是从这个按钮直接采集音频。
- 安装包另有音频面板和采集流程。后台收到采集消息后调用 `chrome.tabCapture.getMediaStreamId`，再由 offscreen 页面消费音频流；浏览器工具栏的 action 点击也会注入该面板。没有发现该 YouTube 字幕按钮绕过音频授权的代码。

所以，“页面里放一个按钮”与“首次取得标签页音频”是两件事。前者可以直接实现；后者仍受 [Chrome tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture) 的用户调用要求约束。[activeTab 文档](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) 将扩展快捷键列为可授权的用户操作。这里未复制 ViiTor 的代码或资源。

## 思译实现

`player-controls.js` 是只在 YouTube 顶层页面自动加载的小入口。翻译引擎 `video.js` 仍在用户明确开始时加载。按钮使用隔离样式，复用原控制栏；菜单有实时语音和网站字幕两个开关，保留用户的目标语言、模型和字幕外观设置。

- 网站字幕继续使用现有的可见字幕适配，不自动改变 YouTube 自带字幕开关，也未引入整轨抓取。
- 语音复用现有 offscreen 会话与同页刷新恢复机制。新命令 `toggle-speech` 默认 Alt+Shift+Y；不会覆盖网页翻译的 Alt+Shift+T。
- 页面请求只允许来自 YouTube 顶层 content script；目标标签页取自浏览器提供的 sender，忽略消息中自报的 tabId。只返回本页开关、提示和快捷键，不返回 Key、原文、译文或其他标签页的会话信息。
- 其他标签页正在语音翻译时，本页无法启动、停止或抢占它。停止会释放采集及 offscreen 页面。
- 仅生命周期变化推送状态；菜单打开时才补充轮询。观察器只在按钮失去挂载位置时调度查找，避免每次字幕 DOM 变化都扫描播放器。
- 页面合成的点击不触发模型请求。开始、停止和设置均需真实用户操作。

## 验证范围

本地 YouTube 页面 fixture 覆盖：禁用划词仍显示入口、无点击不请求、键盘启动、控制栏重建不重复、全屏、弹窗同步、停止后刷新不重启、首次授权失败提示、已授权语音开始 / 停止与刷新恢复，以及跨标签页隔离。

普通浏览器测试不启用采集 allowlist，验证真实的未授权失败。语音集成测试的隔离浏览器用 allowlist 模拟已取得的扩展调用授权，不能据此宣称页面按钮可直接取得首次授权。两套浏览器均保持 `--mute-audio`，实际采集仅验证静音 PCM；非零信号只在 OfflineAudioContext 中验证。尚未在真实 YouTube 页面验证新版控件结构、自动隐藏样式或服务延迟。
