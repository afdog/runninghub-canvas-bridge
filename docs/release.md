# Release guide

Source and releases: https://github.com/limyum-creator/runninghub-canvas-bridge

The product has two parts: the local bridge/MCP package and the browser extension. Both must use the same product version. Node.js 22+, ffmpeg/ffprobe and a logged-in supported browser are required. Standard Chrome/Edge and Codex built-in browser extension packages are provided. Lumen is optional and only needed for its archive tools.

## Install from source

```sh
git clone https://github.com/limyum-creator/runninghub-canvas-bridge.git
cd runninghub-canvas-bridge
npm ci
npm run build
RH_BRIDGE_ALLOW_GENERATION=1 npm start
```

Load `extension/` as an unpacked Chrome extension. Register `server/mcp.mjs` with the absolute Node executable in the MCP client, then call `rh_status`. Full instructions are in [AGENT_INSTALL.md](../AGENT_INSTALL.md).

## Install a release package

Download the `.tgz` from the matching GitHub Release:

```sh
npm install -g ./runninghub-canvas-bridge-0.10.7.tgz
runninghub-canvas-bridge setup
```

Load the `extension.unpackedPath` returned by setup in Chrome, or extract the matching extension ZIP and load that directory. The ZIP requires the local bridge; it is not a standalone cloud service. Register the installed `runninghub-canvas-mcp` command with your MCP client. No npm registry publication is implied by the `.tgz` package.

## Build and publish

1. Keep package, extension, loader, server and MCP versions aligned.
2. Run `npm ci`, `npm run check`, `npm test` and `npm run build`.
3. Run `npm run release:package`, `npm pack --pack-destination dist`, then `npm run release:manifest`.
4. Inspect the staged source and package inventory. Exclude private configuration, canvas payloads, media, credentials and `local-private/`.
5. Write `docs/releases/<version>.md` with user-facing changes, upgrade instructions and the checks actually completed. The tag workflow uses this file as the release body, adding package installation details.
6. Push the reviewed source to this repository and wait for the macOS/Windows/Linux checks. Push a matching `v*` tag to run the release workflow, or attach the verified artifacts to a release manually. Use one publication path per version. With multiple remotes, always give `gh` the explicit `-R limyum-creator/runninghub-canvas-bridge` target.
7. Read back the published release, download its seven assets, verify SHA-256 and `update.json` against the exact tarball, and check that the tag matches the reviewed commit.

Release assets:

- `update.json` (stable-channel update metadata)
- `runninghub-canvas-bridge-<version>.tgz.sha256`
- `runninghub-canvas-bridge-<version>.tgz`
- `runninghub-canvas-bridge-extension-v<version>.zip`
- `runninghub-canvas-bridge-extension-v<version>.sha256`
- `runninghub-canvas-bridge-codex-extension-v<version>.zip`
- `runninghub-canvas-bridge-codex-extension-v<version>.sha256`

The tag workflow installs dependencies and ffmpeg, runs tests, builds the browser dependencies and packages the artifacts. It publishes a GitHub Release; it does not publish to npm.

Bridge protocol version is `1`. Refresh canvas tabs after updating the extension and bridge. Keep the private archive directory across updates so pending imports can resume with their original identities.

Automatic updates are opt-in. See [automatic updates](AUTO_UPDATE.md) for configuration retention, service management and rollback. Never overwrite a published archive in place; fix it in a newer version.
