# Chrome、MCP 与 Codex 生图节点

这是 afdog 基于 RunningHub Canvas Bridge 0.10.9 的定制版本，包含 Chrome 扩展图标、原生画布图片节点和 Codex 账户生图适配。基础桥接保留原有功能，新增 4 个 GPT 图片 MCP 工具。

[查看真实界面演示：图片节点、参考连线与批量结果](../README.md#界面演示)。

## 运行条件

- Node.js 22+，Chrome/Edge 或支持扩展的 Codex 内置浏览器。
- 浏览器已登录 RunningHub；桥接、本地 MCP、浏览器在同一台电脑运行。
- 可选生图功能需要本机 Codex 已登录 ChatGPT 账户，并实际支持 `app-server --stdio`、`image_generation` 和图片能力查询。登录本身不保证账户已开放生图；以 `rh_gpt_image_status` 为准。
- 沿用 Codex 账户用量，不配置 OpenAI API Key，不调用 RunningHub 付费生图模型。该账户适配依赖 Codex 的实验性接口，版本或权益变化可能影响可用性。
- macOS 已完成真实画布文生图、参考生图与多节点并行验证。Windows/Linux 的基础桥接继承上游支持；此生图适配在这些系统上未做真实账户验收。

## 安装和启动

```sh
git clone https://github.com/afdog/runninghub-canvas-bridge.git
cd runninghub-canvas-bridge
npm ci
npm run build
npm run release:package
```

生图模块默认从 PATH 查找 `codex`。也可在**启动桥接的环境**中设置 `RH_CODEX_BIN` 为 Codex 可执行文件的绝对路径；若使用非默认账户目录，设置 `CODEX_HOME`。这两个变量应配置给桥接进程，单独放在 MCP 客户端中不会改变已经运行的桥接。

```sh
# 路径请替换；可执行文件存在于 PATH 时可省略 RH_CODEX_BIN。
RH_CODEX_BIN=/absolute/path/to/codex npm start
```

Windows 如需指定路径，应使用原生 `codex.exe`，不使用 `.cmd`/`.bat` 包装器。需要后台服务时，先在当前终端设置上述变量，再运行 `npm run service:install`；安装器会保存所需的路径变量。发布准备和测试不需要更换已有登录账户，也不要复制他人的账户目录。

## 加载 Chrome 扩展

1. 打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”。
2. 普通 Chrome/Edge 选择仓库中的 `extension/` 文件夹。
3. Codex 内置浏览器选择 `dist/runninghub-canvas-bridge-codex-extension/`。两个包的浏览器来源标记不同，不要混用。
4. 在目标浏览器打开并登录 RunningHub 的画布。更新扩展后重新加载扩展并刷新画布。

扩展连接本机 `127.0.0.1:18765`。图片编辑面板由本机桥接提供，因此只加载扩展、不启动桥接无法生图。默认自动复用目标画布所在的已连接浏览器；需要固定来源时，在桥接环境中设置 `RH_GPT_IMAGE_BROWSER_SOURCE=browser-extension` 或 `codex-browser`。

## MCP 配置

Codex 的 `config.toml` 用 `[mcp_servers.<name>]` 配置 stdio 命令及工具超时；具体格式以 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 为准。

把 [Codex TOML 模板](../config/codex-mcp.example.toml) 中的两个绝对路径替换为本机路径，合并到自己的 `~/.codex/config.toml`；保留已有其他设置。采用 `mcpServers` 格式的客户端可使用 [JSON 模板](../config/mcp.example.json)。Windows JSON 路径建议写成 `C:/tools/...`。

配置示例仅含路径与本机服务地址，不需要 Cookie、令牌或 API Key。修改配置后重新连接 MCP 客户端，再验证：

```sh
node scripts/mcp-call.mjs list
node scripts/mcp-call.mjs rh_status
```

`list` 应包含 `rh_gpt_image_create_node`、`rh_gpt_image_generate`、`rh_gpt_image_status`、`rh_gpt_image_commit_output`。先连接准确画布，取得其 `scopeId`，再读取图片能力或操作该画布。完整基础流程见 [Agent 使用说明](../AGENT_QUICKSTART.md)。

## 画布中使用

使用“Codex 生图”入口创建原生图片节点。节点可拖动、连接，以图片或生成进度为默认展示；点击节点后展开提示词、比例、数量和参考图。

- 文生图或参考生图；参考图最多 5 张，合计不超过 30 MiB。
- 每次生成 1–4 张；生成结果留在原节点，可切换当前图片和查看历史。
- 全局默认 4 张并行。在任意节点的“并行数量 · 全局”选择预设数量、自定义正整数或“不限”，所有节点与画布共用此设置。
- 设置保存在 `~/.runninghub-canvas-bridge/gpt-images/settings.json`，刷新和服务重启后保留。调高可启动排队任务，调低不取消已发出的任务。“不限”取消本机并行数量限制，仍遵守上游限流和自动退避。
- 比例和透明背景作为生成要求传入；精确分辨率、质量和模型版本由原生通道管理，本适配不承诺固定 GPT Image 2.5 或精确 4K。

本机并行名额不等于上游 GPU 内部调度。2026-10-30 的 [8 并行实测](EIGHT_PARALLEL_TEST.md) 中，8 个独立节点各生成 1 张，原生生图工具运行重叠峰值为 8，约 66 秒全部回填，无失败、限流或重试。此结果验证当前条件下至少支持 8 并行；更高上限与持续负载尚未测试。仓库仅展示选定的局部演示截图和汇总，不包含画布 ID、原始图片文件、任务回执或完整私人分镜内容。

## 从首页进入新画布后看不到入口

旧版扩展仅匹配首次打开时的画布地址。RunningHub 的站内跳转不重新加载文档，因此从首页或项目列表进入画布时可能没有“Codex 生图”。普通刷新可恢复当前画布。

2026-10-30 的修复让加载器在已经授权的 RunningHub 域名内监听路由，只在进入画布后加载本机桥接；本机服务短暂未启动时自动退避重试。更新扩展源码后，需要在 `chrome://extensions` 对已加载的 RunningHub 扩展点击一次“重新加载”，再刷新打开着的 RunningHub 页面。此后从首页进入画布时无需再手动刷新。

## 错误与维护

普通 HTTP 429 按有界退避处理；安全验证、总用量耗尽、未知网络结果不会盲目重发。部分成功时保留已生成图片；结果未知时查询原请求，不能通过新请求 ID 重复生成。需要人机验证时由使用者在官方页面完成，不绕过验证。

有图片任务运行、排队或回填时，不要直接重启服务。使用 `node scripts/rh-image-safe-restart.mjs`：它先申请维护许可，忙碌时退出，维护期间拒绝新的图片请求。

```sh
npm run check
npm test
npm run test:gpt-image
npm run release:package
```

`test:gpt-image` 使用模拟 RPC 和临时目录，不提交真实图片任务。真实能力还需在自己的账户与浏览器中验证。源码保持回环地址服务；公开仓库不意味着应把本机端口暴露到公网。远程接入采用上游独立的认证网关方案。

## 本次源码更新检查（2026-10-30）

语法检查、构建和两种浏览器扩展打包通过；基础测试 238 项通过、2 项 Windows 专项跳过，生图测试 66 项通过。基础媒体测试需要本机已安装的 ffprobe / ffmpeg，可通过 `RH_FFPROBE` / `RH_FFMPEG` 指定路径。自动化测试不提交真实图片，另已完成上述 8 节点真实账户验收。此次仅更新定制版源码和说明，不发布上游 Release 或 npm 包。

## 公开版首次发布检查（2026-10-29）

在 macOS 的独立源码副本上完成：语法检查通过；基础测试 231 项通过、2 项 Windows 专项跳过；生图模块 60 项通过；两种扩展 ZIP、图标字节与 MCP 模板打包校验通过。依赖已更新至兼容修复版本，发布时 `npm audit` 为 0 个已知漏洞。测试不连接真实账户，不能替代其他系统上的真实浏览器验收。
