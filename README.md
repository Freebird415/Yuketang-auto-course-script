# 雨课堂连播助手

一个油猴脚本（Tampermonkey / Violentmonkey）。在雨课堂视频页点一次「开始刷课」，
即以 2 倍速静音播放，播完后自动跳转课程中的下一个未完成视频，直至该课程视频全部完成。
支持后台挂机，附带状态面板与一键 BUG 上报。

> 本脚本仅供学习浏览器自动化技术使用。使用本脚本产生的一切后果由使用者自行承担。

## 版本说明

2026 年雨课堂更换了课程播放页（`/pro/lms/...` 改为 `/ai-workspace/lms-graph/...`）。
v2.0 是针对新版的重写：

- 弃用「读取 Vue 实例拿下一节 ID」（`__vue__` / `nextLeaf.id`）的做法。新版为生产构建的
  Vue 3，不暴露任何组件实例，该路径已不可用
- 弃用成绩单页的 DOM 爬取，改为直接调用课程接口
- 保留原型链拦截（倍速 / 静音 / 防暂停）、整页跳转、后台挂机与 BUG 上报

实现细节见 [docs/脚本逻辑.md](docs/脚本逻辑.md)。

## 适配范围

| 站点 / 页面 | 状态 |
| --- | --- |
| `scut.yuketang.cn` 新版学习空间 `/ai-workspace/lms-graph/{classroomId}/video/{leafId}` | 已实测 |
| 其他 `*.yuketang.cn` 新版学习空间 | 同一套代码，未逐一实测 |
| 旧版 `/pro/lms/{sign}/{classroomId}/video/{leafId}` | 保留兼容分支 |
| `changjiang.yuketang.cn` `/v2/web/xcloud/video-student/{courseId}/{leafId}` | 保留兼容分支 |

## 功能

- **2 倍速**：拦截 `HTMLMediaElement.prototype.playbackRate` 的 setter，页面后续创建的
  `<video>` 元素均自动生效
- **静音**：同理拦截 `volume` 的 setter，并将 `muted` 置为 `true`
- **防暂停**：拦截 `pause()`，另加 1 秒定时守护
- **自动连播**：调用课程接口获取未完成清单，播完后跳转下一个视频；清单中的讨论、作业节点自动跳过
- **后台挂机**：覆写 `visibilityState` 与 `hasFocus`，切换标签页或最小化不中断播放
- **播放健康守护**：视频分段切换导致 `<video>` 元素重建时自动重绑；长时间停滞自动尝试恢复，
  卡死则刷新重试（有次数上限）
- **状态面板**：右下角浮窗，含开始 / 停止、实时日志、日志复制
- **BUG 上报**：自动采集页面结构、媒体事件时间线与运行日志发送至飞书群，无需打开控制台

## 安装

1. 安装浏览器扩展 Tampermonkey（[Chrome 商店](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) /
   [Edge 商店](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepiloendndfphd)）
2. 打开本仓库的 [yuketang-auto.user.js](yuketang-auto.user.js)，点击右上角「Raw」，
   Tampermonkey 会弹出安装页，点「安装」
3. 打开雨课堂的**视频播放页**，右下角出现面板即安装成功

> 面板只在视频播放页（`/ai-workspace/lms-graph/{classroomId}/video/{leafId}` 等）出现，
> 课程目录页、未完成列表页不显示。

## 使用

1. 打开课程中的任意视频播放页
2. 点击面板上的「开始刷课」
3. 保持页面打开即可。脚本会自动播完一个跳下一个，全部完成后自动停止并复位按钮

点击「停止刷课」可随时中止，播放器行为立即恢复正常。

## 工作原理

```
点击「开始刷课」
  │
  ├─ 激活引擎：window._yktEngineActive = true，原型链拦截生效
  │
  ├─ 调用课程接口获取未完成清单
  │    GET /c27/online_courseware/course/classroom/{cid}/0/sku_list/       → sku_id
  │    GET /c27/online_courseware/course/classroom/{cid}/{sku}/todo_list/  → 未完成节点列表
  │    （所需头部 xtbz / university-id / platform-id / x-client / x-csrftoken 均读自 document.cookie）
  │
  ├─ 取清单中第一个 type === 0（视频）的节点，以 location.href 整页跳转
  │
  ├─ 页面重载后读取 localStorage 标记，自动恢复会话
  │
  ├─ 定位 <video>，静音、2 倍速、播放，等待 video.ended
  │
  ├─ 确认完成：读页面「已完成」标记；读不到时以接口二次确认
  │    （雨课堂通过 POST /video-log/heartbeat/ 的 videoend 事件写入完成状态）
  │
  └─ 回到第三步，直到清单中不再有 type === 0 的节点
```

跳转使用整页加载而非前端路由，以避免页面组件状态残留。

关于倍速是否会被判定为作弊：实测不会。服务端统计的是视频时间轴上的播放量
（记录为 `watch_length` 102.3 / `video_length` 101），与墙钟时间无关。

## 隐私

脚本不采集、不上传以下内容：Cookie、完整 DOM、localStorage 全文、姓名、学号、视频标题。

BUG 上报仅包含页面结构摘要、播放器状态、媒体事件时间线与运行日志，用于定位问题。

## 开发

```bash
npm install
npm test            # 单元测试（53 例）
npm run coverage
```

单元测试直接加载出货脚本本体（`import '../yuketang-auto.user.js'`），测试其导出的
`window._ykt.pure` 纯函数，因此不存在「脚本与测试两份实现互相漂移」的问题。

覆盖率统计对象同样是出货脚本本体，约 28% 语句 / 33% 行。其余部分为 DOM 交互、
接口调用与面板 UI，jsdom 无法执行，只能在真实浏览器中验证。

### 目录结构

```
yuketang-auto.user.js   主脚本，油猴直接安装（唯一真源）
tests/core.test.js      单元测试
vitest.config.mjs
docs/脚本逻辑.md         架构与实现细节
```

### 无油猴环境的调试方式

在 Chrome DevTools 中直接执行出货脚本。需先起一个带 `Access-Control-Allow-Origin: *`
的本地静态服务器：

```js
const r = await fetch('http://127.0.0.1:8124/yuketang-auto.user.js?t=' + Date.now());
(0, eval)(await r.text());
localStorage.setItem('_ykt_engine_active', '1');
window._ykt.start();
```

可用 `window._ykt.pure` 直接调用纯函数做调试。

## License

[MIT](LICENSE) © 2026 Acac1a
