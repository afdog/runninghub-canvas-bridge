# Automatic updates

Automatic updates are opt-in. Windows and macOS installations can check official stable GitHub Releases at sign-in and every six hours. Linux users can check releases and install manually; automatic service management on Linux is not implemented.

## Enable once

Use Node.js 22 or newer. Extract the release `.tgz` into a permanent, dedicated directory, install dependencies with `npm ci --omit=dev --ignore-scripts`, and install the bridge service using the normal installation instructions. Load the extension from that directory's `extension/`. Run:

```sh
node scripts/rh-update.mjs enable
node scripts/rh-update.mjs status
```

The equivalent CLI is `runninghub-canvas-bridge update enable`. These commands never initialize or replace an existing remote MCP account. They require a running bridge and retain its settings, instance identity and service definitions. A source checkout containing `.git`, including a clean checkout, is deliberately excluded; developers continue to update their source themselves. Do not run `service:install` or `remote init` as an upgrade procedure.

If a separate unpacked extension directory is used, register it once:

```sh
node scripts/rh-update.mjs enable --extension-dir /absolute/path/to/extension
```

The updater detects the Codex variant and preserves its browser identity. The separate extension must be on the same filesystem as the installation and outside the managed package directory. The extension in `extension/` is always included automatically. Other copies not registered with this updater are not modified.

## What updates

The package contains the bridge, stdio MCP, remote HTTP gateway, page runtime, browser extension, CLI and documentation. Releases contain `update.json`, an exact archive size and SHA-256, and a locked dependency set. The updater downloads only from this repository's HTTPS GitHub release assets, rejects prereleases and downgrades, validates the package, and installs dependencies without dependency lifecycle scripts before stopping anything. It does not update Node.js, Chrome/Edge, ffmpeg or cloudflared.

Only recognized **running** managed services are restarted:

- Windows: the per-user bridge service (`service.json`, `service.pid`, `start-bridge.vbs`). For installations launched by an interactive Scheduled Task, supply `--bridge-task "RunningHub Canvas Bridge"`.
- Windows remote deployment: a `remote-runtime/runtime.json` supervisor using the existing PID/stop/launcher contract; `--remote-task` selects its Scheduled Task (default `RunningHub Remote MCP`). The service must belong to this installation. A gateway managed differently needs service integration before unattended upgrades.
- macOS: loaded LaunchAgents `cn.runninghub.canvas-bridge` and `cn.runninghub.remote-mcp` whose definitions point to this installation. Stopped or login-disabled services are not enabled. The independent tunnel process is left alone.

Private configuration and OAuth state remain in `~/.runninghub-canvas-bridge/`, outside the application. Existing generation settings, browser login, access and refresh grants, archive bindings, download records and service environment are retained. The updater does not change the public hostname or request fresh client authorization. Existing token expiration and revocation still apply.

## Safe switching and recovery

The bridge refuses the maintenance lease while commands, browser jobs, downloads, imports or local requests are in flight. Once a lease is acquired, new operations receive `UPDATE_IN_PROGRESS`. Cloud-side generation already submitted to RunningHub continues; updates do not cancel or resubmit tasks. If busy, the scheduled check defers to the next interval. Unknown services or locally modified managed files also prevent replacement.

Before changing files, a durable transaction records the previous code. Health checks verify the new bridge/gateway version and original bridge instance. Failure rolls **code** back and restarts the previous services, without restoring an old OAuth-state snapshot. A failed version is blocked from automatic retry. A crash during replacement is recovered on the next updater run. The recovery engine and transaction live outside the installation directory.

The initial move from an older release to this updater requires a one-time installation/reload. Starting with this version, the extension checks the installed manifest against the bridge and calls the browser's [runtime.reload API](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-reload) when its registered files have changed and the bridge is idle. It does not open or refresh production canvas pages. An older already-loaded extension needs **one manual reload** to activate this mechanism. New browser permissions, browser-specific restrictions, or an extension loaded from another directory can still require user action.

Page runtimes already detect and load updated runtime code. Remote MCP uses the restarted gateway immediately. A stdio MCP process launched by an external client may need that client's restart/reconnect to load new code. Client-side tool-list caches may require a new conversation or refresh; updating server code does not imply every client's cache has refreshed. Canvas scopes may expire after a service restart and should be selected again by exact canvas URL. Account authorization need not be recreated for an ordinary upgrade.

## Upgrading to 0.10.8

All 83 tools remain available. Refresh the client's tool catalogue to use `rh_get_node.view`, metadata `refresh`, optional-scope receipt recovery and explicit `resumeBlocked`. Existing configuration, OAuth clients and refresh grants are retained. A normal upgrade does not require account relinking.

Historical synchronization jobs with permanent conflicts become visible as blocked instead of retrying indefinitely. Their original receipts and identities remain stored. After repairing the exact node, explicitly request `resumeBlocked` on `rh_sync_node_history` to resume those jobs. Upgrading does not repair or regenerate production nodes automatically.

The extension update deduplicates pending page opens; page runtime code provides the metadata cache and narrower generation checks. Verify all layers through `rh_status` after updating, including separately managed ChatGPT runtime copies. Existing stdio clients may need a reconnect to load the new process; keep their current connection and credentials.

## Upgrading to 0.10.7

Version 0.10.7 includes the 0.10.4–0.10.6 recovery, performance, P-node reuse and layout changes. Existing layout preferences remain intact; omitted `groupColumns` defaults to two groups per row. Installation does not reorganize a canvas or repair a node's history automatically. A recorded 301 history conflict uses the explicit preview/apply flow in [Agent quickstart](../AGENT_QUICKSTART.md).

After updating, inspect `rh_status` / `rh_diagnose`: backend and MCP active/disk versions should match, extension fingerprints should match their installed files, and connected page runtimes should be fresh. The catalogue remains 83 tools; `rh_sync_node_history` now exposes `repairRoute`. If only the old schema appears, reconnect that MCP client or refresh its tool list while keeping existing OAuth grants.

Separately managed ChatGPT tunnel runtime copies are not switched by this updater. Update that copy and its launch path using the tunnel's own deployment procedure, retaining its profile and credential references, then verify an actual plugin call. Updating the source checkout alone does not change an already-running copy elsewhere.

## Inspect, update now, or disable

```sh
node scripts/rh-update.mjs check
node scripts/rh-update.mjs apply
node scripts/rh-update.mjs status
node scripts/rh-update.mjs disable
```

`check` only inspects the release; `apply` uses the same idle, checksum and recovery checks as the schedule. `status` includes the last result, deferral/error and blocked version. After investigating a failed release, `enable --retry-failed` explicitly permits another attempt. Review local edits before re-enabling; enable records the current files as the new baseline.

Windows creates the current user's `RunningHub Automatic Updates` Scheduled Task (interactive logon, no administrator requirement); macOS creates `cn.runninghub.auto-update`. The updater never changes system sleep policy. The machine must be awake, and canvas calls still require a logged-in browser session. Scheduling is not a replacement for browser login or a machine that is powered off.

## Publishing updates

Keep versions aligned and run tests. The release workflow builds the runtime and extension bundles, generates a shrinkwrap lock for the tarball, then writes `update.json` and SHA-256 beside that exact tarball. Publish the assets together as a stable `vX.Y.Z` Release. A push to `main` alone does not trigger users' updates. A release without an update manifest is reported but not installed automatically.

Checksums detect corrupt or substituted downloads relative to the release manifest; they are not a separate publisher signature. Repository/release publishing access remains part of the trust boundary. Any future incompatible private-state schema requires an explicit migration design; the current updater accepts state schema 1 only.
