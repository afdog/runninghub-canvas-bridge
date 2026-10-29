# 参考

本仓库为独立实现。连接 RunningHub 画布的思路，参考了 [windzu/runninghub-canvas-bridge](https://github.com/windzu/runninghub-canvas-bridge)。

## afdog 定制版本（2026-10-29）

本分支基于 [limyum-creator/runninghub-canvas-bridge](https://github.com/limyum-creator/runninghub-canvas-bridge)，基线提交 `62860ea5554211423ab2f822c20c792ac38e8a36`。保留 Apache-2.0 许可证、原署名与历史；新增 Codex 图片节点、并行调度、扩展图标和本机 MCP 配置示例。修改的文件带有日期说明或定制版标记。

公开版另将 MCP 与 Zod 依赖升级至兼容修复版本，并更新锁文件中的间接依赖；未改动使用者本机已安装服务。
