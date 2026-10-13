# 验证记录

## 0.8.1 — 2026-10-13

本版现场验证在 macOS 与 RunningHub 国际站完成，账号、画布 ID、素材 URL 和私有回执不公开。

| 验证项 | 结果 |
| --- | --- |
| MCP 握手与工具清单 | 73 个工具 |
| 内置浏览器独立接入 | 专用扩展来源标记、指定浏览器开页、账号目录完整查询通过 |
| 页面固定与多任务 | 独立 scope；切换目标后原 scope 仍读取自己的画布；服务端拒绝跨页面调用 |
| 真实读写 | 独立测试画布改名、回读、恢复通过；生产画布仅只读检查 |
| 原生应用 | 创建、字段配置、参考绑定、预检和运行 dry-run 通过 |
| 聊天附件 | 官方文件参数 → 本机下载 → 画布上传 → 回读通过；文件 SHA 与原文件一致 |
| 图片与视频下载 | 上传合成素材后独立下载，校验一致；下载失败重试回归通过 |
| 画布与复用 | 画布创建/改名/移动/复制，素材保存/改名，工作流保存/应用通过 |
| 布局与恢复 | 分组、快照比较及恢复通过 |
| 自动检查 | macOS 52 通过，2 个 Windows 专用测试跳过；跨平台 CI 另见 Actions |

未在本轮执行真实付费生成、取消运行中任务、Windows 登录浏览器现场操作或中国站全流程验收。预览返回媒体资源链接，客户端原生播放器未验收。资产移动到分类顶层被平台拒绝，需有效文件夹并检查 failedItems。

内置浏览器后台曾出现连接掉线，已加入页面心跳唤醒，重载后账号目录与后续健康检查通过；这不等于长时间休眠/系统重启已经完成现场耐久测试。首次画布同步可能超时，本次重试只读查询后成功；未知写入不能用相同方式盲重试。

以下为历史版本证据，不代表本版所有环境均已重复验收。

---

## Historical international canvas validation

2026-09-28 · version 0.4.0

## Live browser and MCP evidence

- Chrome unpacked extension updated to 0.4.0; local background bridge runs on port 18765 with generation enabled.
- Standard MCP stdio handshake lists 23 tools; registration was verified with a Codex client.
- MCP read and edit of a test canvas succeeded; complete Chinese text and updated title were visible in Chrome.
- Uploaded a synthetic 128×128 PNG through native international canvas storage. Returned a usable URL and an rh-image node; reread confirmed the node. No generation was involved.
- Deleted the failed earlier upload staging node by exact ID. Test canvas then held three nodes and one edge.
- Production canvas read returned 17 nodes and 16 edges, including existing H3 results and a genuine blank H3 template.
- Clone preview preserved that template's native model/settings, returned `applied: false`, and left the production canvas unchanged.
- Earlier 0.2 verification created, edited, moved and connected text nodes, then confirmed state after page refresh and a fresh synchronized read.

## 0.4.0 media and archive verification

- Native MP4 (1 second) and WAV (0.5 seconds, 48 kHz mono) upload succeeded with SHA-confirmed URLs and rh-video/rh-audio nodes. Chrome refresh retained both nodes.
- Recovered those real uploaded files, validated their media metadata and full SHA, and imported both through the installed Lumen MCP into an isolated library. Both exact Revision/SHA identities were read back. Completion signaling was simulated; no actual generation was submitted.
- Interrupted import-response tests reused the same token/request and retained downloads across an archive-manager restart without duplicate versions.
- Import into an explicitly registered empty project Work requires a compatible Lumen App runtime. Verified with the complete 0.8.8 (22.20) App; updating external Python modules alone does not update the bundled App runtime.
- 2026-09-28 joint retest passed through fresh MCP connections to the installed 22.20 App: the same disposable registered Work had zero revisions, accepted its first version, then a second real downloaded output. Both SHA/Revision identities were read back in the original Project/Work. Replaying each exact import request and restarting/retrying the archive manager retained exactly two revisions. Title, project, locks and pin/final fields remained unchanged. Completion signaling was simulated; the formal library was not modified.

## Automated checks

All 25 tests passed for this release, including archive registration before generation, refusal to submit on registration failure, and retention of all outputs while first-version import is unavailable.

Tests cover MCP handshake/schema, real stdio startup, canvas selection, local-only transport, read-only Yjs sessions, schema mismatch, scoped writes, generation access, graph preview/mock submission, H3 reference validation, blank template cloning, node/command ID separation, HTTP origin/host restrictions, duplicate command IDs, result ownership and prompt deduplication.

Syntax checks, dependency bundles with licenses and extension packaging are part of release checks. Private account details, canvas IDs and media URLs are excluded from this record.

## Evidence limits

No actual generation was submitted in this integration test. Real billing/entitlement, generation completion, production generation-to-archive completion, asset-drawer search, multi-user conflict handling and long-term storage durability are not validated by these checks. Node completion can expose historical outputs; match to the current task ID. Refresh and fresh reads establish this session's retained state only.

This conversation used the standard MCP client script for live calls; registration alone does not prove that an already-open Codex conversation hot-loaded its native tools.
