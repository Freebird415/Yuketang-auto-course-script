# 雨课堂连播助手

一个油猴（Tampermonkey）脚本，自动以 **2 倍速 + 静音 + 防暂停 + 自动连播** 的方式刷完雨课堂视频，支持后台挂机（always-on-focus）。内置**一键 BUG 上报**，小白用户无需打开控制台即可反馈问题。

## 支持平台

| 平台 | 域名 | 状态 |
|---|---|---|
| 华工雨课堂 | `scut.yuketang.cn` | ✅ 稳定 |
| 长江雨课堂 | `changjiang.yuketang.cn` | 🚧 适配中（v1.4 起，实战验证进行中） |

## 功能特性

- 🎬 **自动播放**：视频页点「开始」即可，2 倍速 + 静音 + 防暂停
- 🔁 **自动连播**：播完一节自动跳下一节，跨页面全量加载避免状态泄漏
- 👁️ **后台挂机**：always-on-focus 覆写 visibility 检测，切后台/最小化不暂停
- ⏭️ **非视频页面跳过**：自动识别作业/讨论等非视频节点并跳过
- 💪 **播放健康守护**（长江）：分段视频切段重建 `<video>` 时自动重绑、停滞恢复
- 🛡️ **防续播守护**（长江）：断区重播时检测播放位置异常跳跃并重置
- 🐛 **一键 BUG 上报**：点面板按钮 → 输入现象 → 自动采集诊断数据发送到飞书群
- 🔒 **隐私保护**：不采集 Cookie、姓名、学号、视频标题

## 安装

1. 安装浏览器扩展 **Tampermonkey**（[Chrome 商店](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) / [Edge 商店](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepiloendndfphd)）
2. 点击本仓库的 `yuketang-auto.user.js` → 右上角「Raw」→ Tampermonkey 会自动弹出安装页 → 点「安装」
   - 或复制脚本内容，在 Tampermonkey 面板中「新建脚本」粘贴保存
3. 打开雨课堂视频页，右下角出现「🎓 雨课堂连播助手」面板即安装成功

## 使用

1. 进入任意视频播放页
2. 点击面板上的 **「🚀 开始刷课」**
3. 脚本会自动 2 倍速静音播放，并在播完后自动跳转下一节
4. 点击 **「⏹ 停止刷课」** 随时停止

> 切换页面时脚本会通过 `sessionStorage` 标记自动恢复连播，无需重复点击开始。

## BUG 上报

面板上的 **「BUG上报」** 按钮会把诊断信息发送到开发者维护的飞书群：

- 你只需描述「何时发生 / 做了什么操作 / 期望结果」，**无需在控制台执行任何命令**
- 脚本自动采集页面结构、媒体事件史、运行日志等诊断数据（已脱敏）
- 默认使用开发者内置的飞书 webhook；如需自建接收渠道，可修改脚本中 `FEISHU_WEBHOOK_URL` 常量

## 隐私承诺

脚本**不会**采集或上传以下内容：

- Cookie、完整 DOM、localStorage 全文
- 学生姓名、学号
- 视频标题列表
- 任何可用于识别个人身份的信息

诊断数据仅包含页面结构摘要、播放器状态、媒体事件时间线等 debug 所需的技术信息。

## 开发

本项目将可测试的纯逻辑提取到 `lib/core.js`，用 Vitest 覆盖。

```bash
npm install          # 安装依赖
npx vitest run       # 跑全部单元测试（86 例）
npx vitest run --coverage   # 生成覆盖率报告
```

### 项目结构

```
├── yuketang-auto.user.js   # 主脚本（油猴直接安装）
├── lib/core.js             # 可测试纯函数模块
├── tests/core.test.js      # 单元测试
├── vitest.config.js        # Vitest 配置
└── package.json
```

## License

[MIT](LICENSE) © 2026 Acac1a
