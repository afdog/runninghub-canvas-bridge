# Changelog

## 0.10.7 — 2026-10-22 — preserving native history

This stable release includes the previously unpublished 0.10.4–0.10.6 changes below. See the [release summary and upgrade guide](docs/releases/0.10.7.md).

- Add explicit, revision-pinned history route recovery on `rh_sync_node_history` (`repairRoute: true`). Verify every original task and output, preserve native batch/output IDs on the same node in the native embedded format, and retire the rejected remote link without generating.
- Save a private pre-repair snapshot; keep current media, parameters, references, connections, layout and adoption unchanged. Retain the original remote records and their complete metadata.
- Recovered-node submissions exclude the rejected link instead of silently restoring it from the history lookup. Later history sync merges genuine new results with preserved generations; original versions remain readable/selectable. Copies clear recovery ownership.
- Verification: macOS 194 tests passed with 2 Windows-only skips; Windows passed all 196. In-place repair, cloud persistence, preflight and submission preview passed against a real affected node, retaining its existing media and history. No generation was submitted for this repair verification.
- Public OAuth/PKCE, token refresh, 83-tool discovery, canvas reads and lowercase model filters passed against the updated Windows gateway. Existing configuration and authorization were retained on macOS and Windows.


## 0.10.6

- Expire unsent requests even when their old page connection never polls again, so reconnects do not leave tasks or updates waiting indefinitely. Dispatched requests retain their original outcome/recovery semantics.

- Model discovery accepts `video`, `image`, `audio`, `text`, mixed case and hyphenated exact modes, expanding categories into real platform modes.
- Classifies native history route rejection (301) separately from unknown generation outcomes. Structured evidence survives MCP calls, receipt recovery and service restarts. No automatic generation retry.
- Preflight and submission consult persisted route failures. Unchanged rejected routes cannot be retried under a new request ID. Native history synchronization verifies replacement indexes; unresolved platform routes are reported explicitly while preserving current media, inputs, links, adoption and history.
- Native history reset is deliberately not automatic: it detaches old history. A readable index alone does not establish that the platform will accept it for generation.


## 0.10.5 — persistent P applications and section grids

- Make canvas-native applications the default for non-temporary projects. Reuse the original P node for revisions and keep results in its own native history.
- Add stable productionKey to app creation/configuration. Repeated creation returns the existing node without resetting media, inputs, history, adoption, links or geometry; conflicting identities fail. Copies clear the key. Summaries/search expose the production identity.
- Layout template v3 arranges sections in two columns by default, with four P columns per section and vertical wrapping. Align row tops, preserve real portrait/landscape sizing, and move complete rows around obstacles.
- Add groupColumns preferences without rewriting existing saved settings or canvas overrides. Keep reusable P apps when rejecting individual attempts; clean separate discarded cards only within explicit user scope.

## 0.10.4 — recovery, concurrency and faster canvas reads

- Retire permanently rejected browser receipts so workers keep accepting jobs; reconcile late durable-write receipts only with their original saved lease, without replaying operations.
- Resolve dimensions from the currently selected media instead of unbound node-level widths/heights left by earlier outputs or history selections.
- Include MCP-imported shared JavaScript in loaded-versus-installed build fingerprints.
- Preserve failed/unknown command receipts through composed MCP tools and media HTTP calls, including error codes, request IDs and active scope; stop dependent edits on failed reads.

- Retain command/browser request IDs when the submission response or receipt query is lost; retry receipt reads only. Browser jobs accept stable client IDs.
- Run four independent browser workers; a slow job no longer blocks free workers. Retry lost completion receipts without executing jobs again.
- Persist receipts asynchronously; preserve durable edit/generation and unknown receipts. Quarantine damaged command files and block reuse of their identities. Retain terminal read receipts for 24 hours, up to 2,000, with cleanup every 15 minutes.
- Long-poll command/browser results and resolve task scope plus page routing in one lookup. Authorization and canvas mutation locking remain enforced at dispatch.
- Page summaries before formatting and index batch node/revision lookups. Share bounded media-dimension caching across layout checks; changed URLs/outputs and a 10-minute TTL refresh dimensions.
- Expose loaded versus installed backend/MCP builds, tool catalogue count/hash, per-extension-instance fingerprints and runtime freshness through status/diagnostics. Same-version extension fixes reload only after matching disk files and an idle bridge.


- Keep permission/generation validation on a fixed 15-second TTL even during continuous reads.
- Report disconnected or undrained writes as unknown, retain their original request IDs in durable receipts, and discard unconfirmed cached documents. Media status recovery preserves that uncertainty.
- Require all native parent-linked children in layout requests. Detach planned inner groups consistently while preserving outside groups and sibling geometry.
- Pin price previews to the frozen processing node and preflight digest; reject whitespace, malformed prices and invalid zero-price counts. Explicit counted zero quotes still require owner consent.
- Wake all clients waiting for the same canvas mutation lock, including other tabs.
- Commit archive bindings to disk before replacing in-memory state, so failed batches cannot leak into later writes.
- The browser extension long-polls account jobs for 12 seconds. An older bridge that ignores `waitMs` and returns immediately still waits 1.5 seconds before asking again.
- Submit every `rh_prepare_shots` archive binding in one request. A rejected destination is reported on that shot; the prepared canvas nodes stay in place.
- Reuse an open writable canvas socket for later edits and reads. A local update is flushed when the socket buffer drains instead of waiting a fixed 1.2 seconds.
- Layout converts parent-relative nodes to canvas coordinates and places them on the existing grid. Include the source groups and all children being moved; when a whole inner group is flattened, its outside parent's membership is updated without moving siblings.
- Freeze a canvas-model media plan with the `/canvas/price/estimate` price when `estimatePrice` is present. A missing or bare-zero response stays an unknown cost and still needs owner consent.
- Route MCP instructions by read, edit, layout, generate and media. Layout rules are read only when arranging nodes, and overlapping tools name the tool to use instead.
- Reuse one read-only Yjs session for repeated reads on the same canvas generation, and drop it before a write.
- Long-poll `/commands` so an open page does not wait out a fixed 700ms gap. Older servers that ignore `waitMs` still back off.
- `rh_canvas_summary` can filter by type, status and group, continue with `offset` / `nextOffset`, and include size plus revision.
- `rh_get_node` accepts `nodeIds` and reads that batch in one sync.


## 0.10.3 — layout geometry and explicit canvas cleanup

- Wrap shots/assets into four-column grids by default; reject accidental long columns unless explicitly requested.
- Resolve actual media dimensions, distinguish portrait/landscape/square previews, and synchronize native size locks to prevent preview-driven overlap.
- Check overlapping group members, stale offsets, bounds, aspect mismatch and preview resizing risks.
- Add `rh_cleanup_canvas` with whole-graph revision checks and recovery snapshots for explicit user rejections or verified empty app inputs; preserve referenced/adopted/running content and stored media/history.
- App configuration removes only empty native-created, unbound inputs; new applications avoid creating placeholders.
- Validation: 119 local tests passed with 2 Windows-only skips; 53 targeted Windows checks passed.
- Production canvases are not reorganized or cleaned by installing this update. Native sizing analysis/replay and synthetic tests do not claim live production visual acceptance.

## 0.10.2 — media routes and explicit spending consent

- Copies and workflow application clear task/history ownership and adoption while retaining original media provenance; batch shot preparation uses the same rule.
- Add exact native-history selection (output-only or recorded parameters), guarded deletion, and explicit node-subgraph copying.
- Add media capability discovery, immutable plans, once-only execution and durable status. Free browser image/frame processing and local FFmpeg editing are separate routes; agents must compare convenience and quality.
- Canvas media jobs and configured AI image/video processing require owner-key consent bound to the exact plan. Unknown prices are not classified as free; connector authorization and agent-supplied booleans cannot approve spending.
- Interrupted/unknown submissions are retained and never automatically regenerated. Existing credentials and OAuth registrations are preserved. Paid native execution remains unverified until a user-approved real job; static contracts and blocked-consent tests are not paid acceptance.

## 0.9.4

- Display exact video URLs as playable history previews when the native site supplies MP4 thumbnails. Preview playback does not apply a different result or change canvas data.
- Preserve already-owned native history when older tasks have expired from batchStatus; newly attached indices still require full task/output proof.
- Restore native node history using the exact server-owned canvas/node index, with paginated revision checks and independent task/plan/output validation. Only historyStorage is updated; current outputs, inputs, references, links and adoption remain intact.
- Match native history metadata in generation payloads and persist post-generation reconciliation jobs across disconnects/restarts. Never replay generation or open background canvas tabs.
- Retry delivery of command receipts without re-executing commands; bound metadata reads to prevent a stalled connection from holding history work indefinitely.
- Add rh_node_history and rh_sync_node_history (75 tools). Bound read timeouts and reject stale-runtime index writes.


## 0.9.1

- Optional OAuth/PKCE Streamable HTTP gateway for Gemini and Grok Bot, retaining the 73-tool surface and local stdio entrypoint.
- Opt-in Windows/macOS automatic updates from verified stable release archives, with locked dependencies and no lifecycle hooks during staging.
- Idle maintenance leases, exclusive updater lock, durable crash recovery and code-only rollback; preserve configuration, OAuth grants and disabled service state.
- Managed browser extension update detection and reload; register separate Codex extension directories without changing browser identity.
- Publish `update.json` and archive SHA-256 for each release; source checkouts and locally modified installations are protected.


- Verify Grok Bot OAuth linking and 73-tool discovery against a Windows-hosted public gateway, including real status, layout, catalog, exact-canvas connection and read-only summary calls. Document the account-wide remote connector setup.
- Add an optional loopback Streamable HTTP gateway for remote MCP clients, with OAuth discovery, dynamic registration, owner consent, S256 PKCE and rotating refresh tokens. Reuse the full tool factory while preserving task scopes. Public OAuth/tool calls and Gemini account linking with 73-tool discovery are verified. Gemini's English interface passed real status, layout-template, catalog, exact-canvas open and summary calls, including Chinese-language prompts.
- Support native browser consent forms without relaxing Origin or CSRF checks. Finish authorization on a same-origin page before navigating to the registered client callback, keeping `form-action 'self'` throughout.

- Reuse a fresh exact canvas connection before sending any browser open job, preserving browser-provider and task-scope isolation.
- Separate routine `intent: connect` from user-requested `intent: show`. Normalize legacy `focus: true` at the broker so already-running older clients cannot activate existing tabs during background work.
- Report required foreground creation for new Codex tabs explicitly; existing-tab reuse does not claim cross-conversation ownership of the browser UI. No extension reload is needed for this server/MCP change.

## 0.8.2

- Open new Codex built-in browser tabs as active, as required by the host; reusing an existing tab retains the normal focus preference.
- Wait for newly created account pages to register their tab ID before querying the directory or dispatching an account operation; readiness retries never repeat the API write.

- Replace extension long-poll batches with bounded short polling and all-settled lane handling to prevent overlapping workers after a transport failure.
- Wake the extension worker from live page polling as well as isolated content-script timers and browser alarms.
- Add an optional tunnel watchdog with health checks, reconnect backoff, and redacted state-only logs. It reconnects exited runtimes without replaying canvas commands.
- Inspect fresh loopback control-plane health separately from local readiness, and document shorter tunnel polling for proxies that close long polls early.
- Document the official stdio initialized-notification shim for interleaved tunnel callers sharing one MCP process.
- Serve modern MCP 2026-07-28 discovery and self-contained calls through the official SDK v2 stdio entry, while retaining the legacy handshake for older local clients. Canvas scope handles remain explicit in both protocols.

## 0.8.1

Added a separately labelled unpacked extension build for the Codex built-in browser, explicit browser-provider routing for account/open jobs, and server-enforced page pinning for task scopes. Source metadata is visible in status.

## 0.8.0

Added production downloads, native AI app operations, task/history tools, canvas and asset organization, workflows, snapshot recovery and ChatGPT file receipt tools. Canvas calls now require independent task scopes to prevent shared-client selection races. Browser workers process independent jobs concurrently; account writes persist deduplication receipts. Fixed immediate retry after download failure.


## 0.7.0

- List personal/team canvases across pages and nested folders through the browser.
- Open or reuse requested canvas tabs and select after connection.
- Persistent scene/shot layout defaults and per-canvas geometry, with native group planning.
- Browser result recovery and Chrome/Edge service worker; no account credentials leave the page.

## 0.6.0

- Add complete reference replacement/clearing with precise old-edge cleanup.
- Validate parameter writes against live model schemas; add exact-input preflight and graph digest checks at submission.
- Add atomic multi-shot canvas preparation with optional post-edit archive bindings and explicit partial binding results.
- Persist command receipts before dispatch and after completion; preserve request IDs across reconnects without replaying uncertain work.
- Add collision-aware local layout for ungrouped nodes.
- Expand doctor and MCP diagnostics to inspect the actual bridge service environment on Windows/macOS/Linux.

## 0.5.0

- Add platform asset browsing/search and URL-based canvas reuse.
- Recognize generated media outputs and bind references with live model fields.
- Discover current model configuration instead of relying on static presets.
- Isolate MCP canvas scopes; serialize canvas mutations and add optimistic batch conflict checks.
- Add Windows per-user background startup, media-tool discovery and portable ZIP packaging.
- Add Linux/macOS/Windows CI, including Windows Unicode-path launcher and service lifecycle checks.


## 0.4.0 — 2026-09-27

- Add native video/audio upload with content inspection, metadata, SHA verification and scoped file streaming.
- Add persistent node-to-Lumen destinations and background task-specific output collection, all-output download, MCP import/readback, receipts and recovery.
- Preserve original Lumen import arguments on retries; never retry generation as part of collection.
- Recover page clients after a local service restart without requiring browser refresh.

Live tests: MP4 and WAV upload retained after refresh. Real downloads and two Lumen MCP imports passed in an isolated library, with simulated generation completion.

2026-09-28 joint validation: installed Lumen 0.8.8 (22.20) accepts the first and second outputs into the same pre-registered empty Work; exact import replay and archive-manager restart retain the original identities and exactly two revisions. No formal-library writes or actual generation were involved.

## 0.3.0 — 2026-09-27

- Add 18 stdio MCP tools for exact canvas selection, batch editing, blank templates, uploads, generation and results.
- Enable generation through service configuration; provide graph preview and original-request result recovery.
- Upload images through international canvas storage using transient page-local credentials; bundle upload dependencies and licenses.
- Persist selected canvas access for the macOS service; scope mutations to that exact canvas.
- Separate command IDs from node IDs, reject conflicting duplicate request IDs, expire unexecuted commands.
- Preserve native H3 parameters when cloning and validate native reference slots without Seedance-only fields.

Verified through real MCP: read/edit, image upload, deletion, production-canvas inspection and blank H3 clone preview. Generation request construction and mock submission pass; no live generation submitted for verification.

## 0.2.0-dev — 2026-09-27

- Add international `/project/canvas/` routing and React Flow inspection.
- Adapt page-session authentication and current Yjs generation metadata.
- Bundle synchronization dependencies locally instead of loading remote code.
- Restrict browser origins, command access and writes to one configured canvas.
- Keep generation, upload and arbitrary script/API commands disabled.
- Prevent reads from initializing missing remote canvas structures.
- Preserve displayed node labels and avoid repeated prompt text on preparation.

Verified in Chrome on the international RHTV site: empty-canvas read, dry-run, two text nodes, text edit, position edit, connection, and state retained after page refresh and fresh socket read. Image/video node variants, paid generation, long-term durability, and multi-user editing are not live-validated.
