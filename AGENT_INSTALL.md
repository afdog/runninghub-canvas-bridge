# 安装与升级

适用于 0.8.2。返回 [首页](README.md) · [Agent 使用](AGENT_QUICKSTART.md)。

## 1. 准备本机服务

需要 Node.js 22+、ffmpeg/ffprobe，以及已登录 RunningHub 的浏览器。桥接、MCP 与浏览器应运行在同一台电脑。默认本机地址为 `http://127.0.0.1:18765`。

```sh
git clone https://github.com/limyum-creator/runninghub-canvas-bridge.git
cd runninghub-canvas-bridge
npm ci
npm run build
npm run release:package
```

运行 `npm start` 启动前台服务。需要生成时，在启动前设置环境变量：

```sh
# macOS / Linux
RH_BRIDGE_ALLOW_GENERATION=1 npm start
```

```powershell
# Windows PowerShell
$env:RH_BRIDGE_ALLOW_GENERATION="1"
npm start
```

生成开关不代替用户对具体任务的授权。编辑、上传和生成还需要该任务的 `allowWrites: true` 连接。

## 2. 加载浏览器扩展

| 浏览器 | 源码构建目录 | Release 下载包 |
| --- | --- | --- |
| Codex / 桌面应用内置浏览器 | `dist/runninghub-canvas-bridge-codex-extension` | `runninghub-canvas-bridge-codex-extension-v0.8.2.zip` |
| Chrome / Edge | `extension` | `runninghub-canvas-bridge-extension-v0.8.2.zip` |

- **内置浏览器：** 设置 → 浏览器 → 扩展程序管理器 → 管理 → 开发者模式 → 加载未打包的扩展程序。
- **Chrome / Edge：** 打开浏览器扩展管理器，启用开发者模式并加载未打包扩展。
- ZIP 必须先解压，选择包含 `manifest.json` 的文件夹。内置浏览器专用包显示为 **RunningHub Canvas Bridge — Codex**。
- 在所选浏览器登录 RunningHub，刷新已打开的画布；若浏览器提示本地网络访问，桥接需要连接本机端口。

内置浏览器使用扩展路线，不需要通过 CDP 注入脚本。来源显示为 `codex-browser`；普通扩展为 `browser-extension`。这是适配器标记，不是身份凭据。内置浏览器在线时开页与账号目录默认优先使用它，也可显式传 `browserSource`。不要把内置专用包加载到外部 Chrome，否则来源标记会不准确。

## 3. 配置 MCP 客户端

配置 Node 可执行文件和本项目的绝对路径：

```json
{
  "mcpServers": {
    "runninghub-canvas": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/runninghub-canvas-bridge/server/mcp.mjs"]
    }
  }
}
```

Windows JSON 路径可用 `C:/tools/nodejs/node.exe` 和 `C:/tools/runninghub-canvas-bridge/server/mcp.mjs`。建议工具超时至少 90 秒；首次账号目录加载可能更久，超时后通过返回的请求 ID 恢复。

重新连接客户端后调用 `rh_status`，检查服务、浏览器来源和画布连接。再按 [Agent 快速上手](AGENT_QUICKSTART.md) 获取任务 scope。未刷新客户端时可使用仓库附带的真实 MCP 客户端：

```sh
node scripts/mcp-call.mjs rh_status
node scripts/mcp-call.mjs list
```

## 后台常驻：macOS 与 Windows

设置需要的环境变量后，使用后台服务代替前台 `npm start`，不要两者同时启动。

```sh
npm run service:install
npm run service:status
npm run service:restart
```

支持 `service:start`、`service:stop`、`service:uninstall`。macOS 使用 LaunchAgent；Windows 使用当前用户的登录启动目录，无需管理员权限。卸载保留本地归档与配置；不要在运行期间移动项目目录。改变服务保存的环境变量后，重新安装服务定义。

Windows 需在 PATH 中提供 `ffprobe.exe`，或在安装服务前设置 `RH_FFPROBE` 为完整路径。企业策略禁用 Windows Script Host 时，使用前台 `npm start`。当前源码已在 Windows Chrome 完成账号目录、准确画布连接与读取、公网 OAuth 和授权续期验证，75 项自动测试全部通过；付费生成与整机重启后的浏览器恢复不在此次验收范围内。

## ChatGPT 个人插件

使用 OpenAI 官方 Secure MCP Tunnel 将本机 stdio MCP 接入 ChatGPT。**端口 18765 是本地桥接接口，不是可直接填入 ChatGPT 的远程 MCP 地址。**

1. 从 [官方 tunnel-client](https://github.com/openai/tunnel-client/releases) 安装并校验客户端。
2. 在目标 Platform 组织创建专用 Tunnel，按官方 quickstart 配置本机 stdio 命令，启动本项目的 `server/mcp.mjs`。运行密钥仅保存在本机，不提交到仓库。
3. 确认隧道运行状态 healthy / ready，在 ChatGPT 添加自定义 MCP 插件并选择对应 Tunnel。
4. 安装插件后调用 `rh_status`，验证本机桥接与浏览器来源；按自己的使用需求配置插件操作权限。

Tunnel 配置与界面以 [官方文档](https://github.com/openai/tunnel-client#readme) 为准。隧道、本机桥接和已登录浏览器需要在线；本项目无需额外 RunningHub API key。

## Gemini 与其他远程 MCP 客户端

Gemini 等网页版客户端可使用独立的 HTTPS MCP 网关，复用现有工具和浏览器连接。它使用 OAuth 授权，并与本地 stdio、ChatGPT 专用隧道并行；不能把本地 18765 端口直接填到远程客户端。配置和验证步骤见 [远程 MCP 接入](docs/REMOTE_MCP.md)。

Gemini 自定义 MCP 目前需要英文界面：可用 `https://gemini.google.com/app?hl=en` 进入，再从 `@` 菜单选择真正的连接器。提示词和回复可以继续用中文，已完成目录查询、准确开页和画布摘要的真实验收。中文界面可能已显示关联和工具清单，但对话不加载这些工具；不能把保存成功当作实际调用成功。

## 升级与故障定位

1. 保存当前工作，更新源码并执行 `npm ci`、`npm run build`、`npm run release:package`。
2. 重启桥接服务，并在相应浏览器重新加载扩展、刷新画布。
3. 重启 MCP / Tunnel，刷新插件工具列表。旧会话可能仍保留旧参数定义。
4. 重新 `rh_open_canvas` 获取 scopeId；旧 scope 不应跨服务重启或页面刷新继续使用。

`rh_diagnose` 或 `node bin/runninghub-canvas-bridge.mjs doctor` 可检查服务及依赖。若明确选择的浏览器不在线，不会偷偷切换到另一个浏览器。

命令回执跨服务重启保存；超时或断连不等于提交失败。保留原请求 ID，通过 `rh_command_result` / `rh_recover_command` 查询，勿重新生成请求代替恢复。

## 可选归档与数据目录

独立下载不要求 Lumen。需要 Lumen 自动归档时另行安装其 MCP，并用 `RH_LUMEN_MCP_CONFIG` 指向客户端配置。macOS 默认读取 `~/Library/Application Support/Lumen/mcp-client.json`。

| 内容 | 默认位置或覆盖变量 |
| --- | --- |
| 归档状态 | `~/.runninghub-canvas-bridge/archives`；`RH_ARCHIVE_DIR` |
| 下载回执 | `~/.runninghub-canvas-bridge/downloads`；`RH_DOWNLOAD_DIR` |
| 画布快照 | `~/.runninghub-canvas-bridge/snapshots`；`RH_SNAPSHOT_DIR` |
| 命令回执 | 归档目录下 `commands`；`RH_COMMAND_DIR` |
| 聊天附件落地 | 本机用户的 `Downloads/RunningHub/ChatGPT` |

这些目录可能包含私人画布数据和临时媒体地址，不要提交或打包发布。浏览器登录凭据留在网页内。

## 可选：隧道掉线自动恢复（0.10.9）

`scripts/tunnel-watchdog.mjs` 可监督已有官方隧道管理脚本：

```sh
node scripts/tunnel-watchdog.mjs /absolute/path/to/manager.mjs
```

管理脚本须接受 `status` / `connect`，输出官方 runtime 状态 JSON。watchdog 每15秒检查一次；确认进程退出后重连，失败时逐步退避。增加 `--restart-stalled` 时，管理脚本还必须支持 `stop`：云端成功轮询超过120秒、连续观察至少30秒，且隧道队列、执行请求、响应交付和本机桥接均空闲后才重启原 alias。短暂故障或状态不明时保留进程；先确认旧进程退出才重连，同一故障最多重启3次，恢复正常轮询后重置。日志只输出状态，不回显密钥或原始配置。将 watchdog 配置到系统的用户后台服务中，进程退出后由系统重新启动。需要主动停止隧道时先停止 watchdog，否则它会按设计重连。

watchdog 还会从官方 runtime 返回的本机管理地址读取 `/health?details=true`，检查控制面最近成功轮询和快照时效。`polling` 表示最近轮询正常；`poll-degraded` 表示退避或连接异常；`poll-stalled` 表示成功轮询已超过正常等待范围；`poll-health-unavailable` 表示缺少实时证据。它们不等于客户端工具调用成功，验收仍需真实 MCP 调用。旧管理器未提供地址时无法确认云端状态。

隧道恢复不保证客户端继续持有的旧 MCP 会话仍有效。若仍报 `Session terminated`，客户端需要重新连接或在新会话中重新调用；先核查未知写入回执，不重复提交生成。扩展更新后需重新加载扩展并刷新画布，MAIN 和 ISOLATED 两种页面心跳才会同时生效。

内置浏览器要求扩展新建的标签页处于激活状态。`rh_open_canvas` 默认 `intent: "connect"`，优先静默复用已连接画布；旧 `focus: true` 不再激活已有标签页。只有用户要求展示时才设置 `intent: "show"`。必须新建内置页面时仍会前台打开，回执标明 `presentation.activation: "required-for-new-tab"`；Chrome/Edge 保留后台新建能力。任务 scope 固定操作目标，不代表宿主的前台标签页已经按对话隔离。

后台服务不会自动继承终端或系统代理环境。若 OpenAI 连接依赖已有代理，需在该后台服务中明确配置同一 HTTP_PROXY / HTTPS_PROXY，并让 NO_PROXY 排除本机地址。不要把 local healthy/ready 当作云端接通证据；应从客户端实际调用 rh_status 验证。

若隧道日志出现 `control-plane proxy closed long poll`，说明长轮询被网络路径提前关闭；客户端随后的退避可能让工具调用失败。可在隧道后台服务环境中设置 `CONTROL_PLANE_POLL_TIMEOUT=10s` 和 `CONTROL_PLANE_INITIAL_POLL_TIMEOUT=10s`，再重启该隧道进程，使正常轮询在代理空闲超时前返回。此值只调整取回请求的等待周期，不缩短画布操作或生成的执行时限。沿用已有代理和 TLS 校验，不关闭证书验证。具体网络仍须实际验收。

多个客户端共用官方 `tunnel-client` 0.0.16 的 stdio 进程时，如果出现 `MCP server is not initialized`，可在同一后台服务环境设置 `MCP_STDIO_SEND_INITIALIZED_NOTIFICATION=true`。这是官方客户端的兼容开关：在成功的 initialize 响应后、释放共享请求通道之前发送 initialized 通知，避免其他调用进入初始化空隙；后续重复通知会被客户端去重。它不重放工具调用，也不改变 RunningHub 的功能权限。此配置和轮询参数需要重启隧道进程生效，浏览器扩展无需因此重载。升级官方客户端后按其当前帮助再次核对。

0.8.2 的服务端采用官方 SDK v2 `serveStdio` 入口，支持 MCP `2026-07-28` 的 `server/discover` 和自包含请求。支持新版协议的云端客户端可跳过反复 initialize/initialized；旧本地客户端仍可按原握手连接。更新源码后先安装依赖，再重启隧道进程，并用实际调用确认协商结果。无论使用哪个协议，每个画布任务都必须继续携带自己的 `scopeId`。协议说明见 [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)。

## 自动更新（Windows / macOS）

使用 Node.js 22+，从正式 Release 解压到固定目录的安装可运行 `node scripts/rh-update.mjs enable`；`status` 查看结果，`disable` 关闭。无需重建桥接或 OAuth 配置。更新只针对正式 Release，不覆盖 Git 工作区。首次从旧扩展升级需要重载一次，以后自动检测已登记文件的更新。完整的服务支持范围、独立扩展目录、授权保留与回退说明见 [自动更新](docs/AUTO_UPDATE.md)。


### 常开电脑与 Secure MCP Tunnel

ChatGPT 专用 Secure MCP Tunnel 和 Gemini/Grok 使用的公网 HTTP 网关是独立入口；应分别确认实际运行主机。Mac 合盖休眠时，其上的隧道也会离线。需要持续可用时，把专用隧道迁到常开电脑，保留原 tunnel ID 与 runtime key；先停止旧主机的监督器及原 alias，再在新主机连接同一身份。不要让两台机器同时占用同一个隧道。插件本地文件路径按新宿主解释，本地 stdio MCP 可继续在另一台机器使用。

本项目提供跨平台管理脚本 `scripts/tunnel-manager.mjs status|connect|stop`，默认读取私有的 `~/.runninghub-canvas-bridge/chatgpt-tunnel/config.json`，或通过 `--config` / `RH_TUNNEL_CONFIG` 指定。配置包含绝对路径 `client`、`node`、`root`、`runtimeKeyFile`、`profileDir`，以及原有 `alias`、`tunnelId`、`profile`，可选本机 `bridgeUrl`。密钥以文件引用交给官方客户端，管理器不会创建新隧道或授权。

```sh
node scripts/tunnel-watchdog.mjs /absolute/install/scripts/tunnel-manager.mjs --restart-stalled
```

将监督器放入该用户的 LaunchAgent 或 Windows 登录计划任务。Windows 应从交互用户计划任务启动，避免 SSH 会话结束回收进程。后台需明确继承现有代理与 NO_PROXY 设置；实际连接以官方健康快照和一次插件调用验收。

自动更新器发现上述默认私有配置、安装根一致且 alias 正在运行时，会将其纳入升级：先停原 alias，再换代码，等待本机桥接恢复后连接新版；原已停止的 alias 保持停止。连接配置、密钥、profile 和 OAuth 继续放在安装目录外。迁移回退时先停新宿主，再启用旧宿主原服务和 alias。
