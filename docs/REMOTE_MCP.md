# Remote MCP for Gemini and other web clients

The optional gateway serves the same 73 tools over authenticated Streamable HTTP. Local stdio clients and the ChatGPT Secure MCP Tunnel retain their existing entrypoints. Public HTTPS OAuth, tool discovery and a status call have passed live checks. Gemini account linking, discovery of all 73 tools, and actual status, layout-template, canvas catalog, exact-canvas open and summary calls have passed in its English interface. A Chinese prompt also completed the catalog/open/summary flow. Account linking alone does not prove a chat can invoke the tools; paid generation and Gemini attachment upload were not part of these checks.

## Run the gateway

Requires Node.js 22+, the local bridge and a logged-in supported browser. These commands work on macOS, Windows and Linux:

```sh
npm install
node scripts/rh-remote.mjs init --public-url https://mcp.example.com
node scripts/rh-remote.mjs serve
```

`init` creates a private directory under the current user's home and prints the configuration/key file paths without printing the key. It refuses to replace existing credentials. Use `--config /absolute/path/config.json` to choose another private location. Keep this directory outside source control. On Windows, protect it with the account's directory ACL.

The gateway binds **127.0.0.1:18766**. The internal bridge stays on **127.0.0.1:18765**. Publish only the gateway port, never the internal bridge. Check it with `node scripts/rh-remote.mjs status`.

For persistent operation, run `node server/mcp-http.mjs /absolute/path/config.json` under the OS service manager. Restart only the gateway when its configuration changes; the bridge and ChatGPT runtime can keep running.

## Publish a fixed HTTPS address

Map the chosen Cloudflare Tunnel hostname to `http://127.0.0.1:18766`. Its public origin must exactly match `publicUrl` in the private configuration.

Cloudflare's free full DNS setup requires Cloudflare nameservers. Export and compare the complete current DNS zone first, including website, email and verification records. Existing websites can stay DNS-only; only the MCP hostname needs the tunnel. Domain registration and renewals can stay with the existing registrar. Do not assume automatic DNS scanning found every record.

Quick Tunnels have changing hostnames and do not support SSE, so use a named tunnel for persistent operation. Do not put an interactive Cloudflare Access email login in front of `/mcp`: server requests need OAuth bearer authentication, not browser login cookies.

## Link Gemini

Use the **English Gemini interface** for custom MCP apps. In live verification, the Chinese interface saved the app and listed all 73 tools in settings, but did not expose the connector in chats or the `@` picker. Opening [Gemini in English](https://gemini.google.com/app?hl=en) exposed the connector and enabled real calls, without changing the Google account language. Returning that same working conversation to `hl=zh-CN` removed its MCP tools again. Keep the interface English while using this connector; prompts and responses can still be Chinese. Select the actual connector from `@`, rather than an installed skill with a similar name. These are product availability requirements; follow Google's current account, region, activity and language eligibility guidance.

Enter `https://mcp.example.com/mcp` in its custom connected-app dialog. OAuth discovery and dynamic client registration are supported; manual client credentials should not be necessary.

The authorization page displays the application and exact callback URL. Enter the **local connection key** saved during installation, then authorize that client. This is not a Google or RunningHub password. Do not send it in chat or commit it to Git. This initial account link does not add a per-tool approval gate.

Complete the entire account-linking flow in the same browser. If an embedded browser cannot open the authorization window, start again from Gemini in Chrome or Edge; do not copy an old authorization URL between browsers. If Google reports an expired session, begin a new link from Gemini. The gateway's completion page returns to the registered callback automatically and also provides a continuation link.

All existing tools remain exposed; Gemini controls its own confirmations and usage limits. ChatGPT-specific file parameters do not establish Gemini attachment compatibility. Local-file upload and platform asset reuse remain available independently.

Validate tool discovery, `rh_status`, exact read-only connection and a canvas summary before a reversible test edit. Generation still requires the production request. Canvas operations retain their explicit `scopeId`; routine connections use `intent: connect`.

## Link Grok Bot

In the verified desktop flow, ask an existing Bot to add a custom **Remote HTTPS** MCP named RunningHub Canvas at `https://mcp.example.com/mcp`, using Streamable HTTP and OAuth. Complete the connector card's authorization flow in the browser and enter the connection key only on your gateway's authorization page. Do not paste the key into the Bot chat or a command. The cloud Bot connects to the public gateway; it does not need a second RunningHub bridge installed on its cloud computer or the user's laptop.

Live Grok Bot verification loaded all 73 tools and completed status, layout-template, complete account catalog, exact-canvas connection and summary calls against a Windows-hosted gateway. The initial verification was read-only; editing and generation tools remain exposed. Installed connectors are account-wide across personal Bots; see [Grok Bot computer and apps](https://docs.x.ai/grok-bot/computer-and-apps).

## Authentication and recovery

- The SDK validates registered callback URLs, client credentials and S256 PKCE. Owner consent uses a bound browser form; authorization codes are short-lived and single-use.
- Access tokens last one hour. Refresh tokens rotate, expire after 30 days and survive restarts. Reuse of a rotated refresh token revokes its family. `/revoke` revokes the related access/refresh credentials.
- Access/refresh tokens are stored as hashes. Client secrets and the connection-key file remain private. Pending login forms and codes expire on restart; start linking again if interrupted.
- Only MCP, OAuth and minimal health routes are exposed. Internal bridge commands, local files and media-serving routes are not forwarded. This is a personal gateway, not a multi-tenant service.
- Requests, prompts and credentials are not logged. Recover an uncertain tool request by its original receipt instead of replaying writes or generation.

## Move the gateway to another computer

Install the bridge, gateway, browser extension and logged-in RunningHub browser on the destination computer. Verify its local OAuth flow, tool discovery, account catalog and an exact read-only canvas before switching the public route. Local file paths and downloads refer to this computer; a Lumen installation on the previous computer does not migrate automatically. Local stdio clients and the separate ChatGPT Secure MCP Tunnel also retain their own connection paths.

Keep the HTTPS origin unchanged to preserve client configuration. Stop the old gateway before copying its latest `config.json`, `connection-key.txt` and `oauth-state.json` to the destination's private directory. Copy the named-tunnel credential separately and protect all credentials with the destination user's permissions. Never run independent OAuth stores behind the same public hostname: token rotation would diverge. Disable the previous host's automatic startup before starting the new tunnel. A rollback after new requests must first stop the new gateway and copy its latest OAuth state back; the original backup may already be stale.

On Windows, launch persistent processes in the intended Windows user session, for example with Task Scheduler and an interactive logon principal. Processes started through an SSH session can be terminated when that session closes. The browser still needs a logged-in Windows session and a valid RunningHub login. Use an absolute `RH_FFPROBE` path for the bridge. If an unusually long `PATH` causes npm scripts to lose access to Node, use a concise installation-process `PATH` rather than replacing the user's system configuration. Where QUIC repeatedly times out, configure the named tunnel to use `--protocol http2` and verify actual public tool calls.

Windows live validation covered 75 passing automated tests, browser catalog/open/read calls, a public route handoff retaining an existing access grant, OAuth refresh, and gateway-process recovery. Paid generation, cross-computer Lumen import and full-machine reboot recovery were not tested in this deployment.

References: [Gemini custom apps](https://support.google.com/gemini/answer/17209137?co=GENIE.Platform%3DDesktop&hl=en), [MCP HTTP](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html), [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/).

## Updates without relinking accounts

Enable the [automatic updater](AUTO_UPDATE.md) on the host running this gateway. Keep the public URL, private configuration and live `oauth-state.json` in place. Ordinary upgrades restart the gateway and preserve account grants; do not re-run `init` or restore an older OAuth state. Client tool-list caches can need a refresh.
