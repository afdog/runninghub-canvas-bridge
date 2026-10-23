# Agent Usage

This product exposes a local bridge for Agents to operate a logged-in RunningHub infinite canvas without mouse automation.

For repeatable black-box acceptance testing, use `docs/agent-qa-playbook.md`.

## MCP agents

Codex and other MCP clients follow [AGENT_QUICKSTART.md](../AGENT_QUICKSTART.md) and the live tool descriptions. They do not have `generate-video-node` or `poll-node-result`. Use `rh_preflight` for both model and application readiness, preview with `rh_run_node` `dryRun` when needed, and submit only when generation is authorized. `rh_validate_node` remains a basic ordinary-model compatibility check. Read results with `rh_task_status` or one `rh_node_result`. The commands below are the local CLI.

## Persistent project work

For non-temporary RunningHub projects, use the project canvas and native application nodes. Project trials and revisions stay in that project; use a temporary path only when explicitly requested. Keep one application node per P and configure/run that same node for each iteration. Native history owns versions; do not generate off-canvas and routinely upload every attempt as another media card.

Inspect the original node first. Use a stable `productionKey` such as `EP01/P001` (no version/attempt suffix); summaries and search results expose it. `rh_create_app` reuses an exact node ID or key and returns the canonical `nodeId` with `reused: true`. Attach a key to an older app by passing its exact ID to `rh_configure_app` or `rh_create_app`. Conflicting identities/apps stop without replacement or history merging. A new independent P may create a new application; clones/workflow copies clear copied production keys and native history ownership.

Read/select versions with `rh_node_history` / `rh_apply_node_history`. A rejected attempt does not discard the P application. Clean explicitly rejected standalone cards and unused inputs; deletion of a whole P or native history follows the user's specific request. Generation and spending still follow existing authorization.

Layout sections in rows: `groupColumns=2` by default, then wrap downward. Each section uses `maxColumns=4` P nodes per row. Use actual portrait/landscape dimensions, aligned row tops and the tallest row member for spacing. Only request a long single-column layout explicitly; keep public asset zones separate and reuse their nodes.

## Local CLI

When using a release, call `runninghub-canvas-bridge ...` as the product boundary. Do not patch installed package internals when a command fails; run `runninghub-canvas-bridge doctor` and `runninghub-canvas-bridge report --write`.

## First Commands

Run these before touching the canvas:

- `runninghub-canvas-bridge agent-manifest`
- `runninghub-canvas-bridge doctor`
- `runninghub-canvas-bridge clients`

`agent-manifest` is machine-readable and works even when the bridge server is offline. `preflight` requires the local bridge server and checks:

- bridge server health
- live RunningHub canvas page client
- runtime version freshness
- required runtime capabilities

Only proceed when `preflight.ok` is `true`.

If `doctor` returns `NO_PAGE_CLIENT`, run `runninghub-canvas-bridge diagnose-extension`. On first Chrome setup, the page may be blocked until the user allows the local-network prompt for `rhtv.runninghub.cn`.

## Safety Rules

- Do not print, store, or commit cookies, tokens, authorization headers, or private payloads.
- Prefer high-level commands over composing low-level commands yourself.
- Use `--dry-run` before mutating or paid workflows when available.
- Do not use `page.eval` in autonomous workflows.
- Do not call paid generation commands unless the user has approved the spend or the task explicitly authorizes generation.

## Local CLI video generation

These commands exist only on the local CLI. MCP agents use the route in the section above.

Preferred command:

- `runninghub-canvas-bridge generate-video-node <videoNodeId> --dry-run --append-prompt "<constraints>"`
- `runninghub-canvas-bridge generate-video-node <videoNodeId> --timeout <ms> --append-prompt "<constraints>"`

The high-level command performs:

1. `prepare-video-node`
2. `validate-video-run`
3. `run-node --validate-references`

`prepare-video-node` preserves the existing video prompt by default, merges upstream text, appends `--append-prompt` constraints, and switches reference-conditioned runs to a multimodal video modelCode. Use `--prompt-merge-mode replace` only when replacement is intentional.

In dry-run mode it returns `run: null` and does not spend credits.

Before a real run, check:

- `validation.ok` is `true`
- every `references[]` item has `hasDirectUpstreamImage: true`
- `subType` is `multimodal-video`
- `modelCode` contains `multimodal-video`
- prompt is non-empty

Do not use plain `run-node` for video unless you pass `--validate-references`.

## Runtime Stability

The server injects a runtime version into `bridge-runtime.js`. Page clients report that version in `clients` and event payloads. If the server runtime changes, the page runtime auto-reloads itself on the next command poll.

The server rejects commands sent to stale clients with:

- `STALE_RUNTIME`

If `preflight` reports stale clients but also shows a fresh selected client, use the fresh client or omit `--client` so routing selects the latest client.

## Common Commands

- `agent-manifest`: machine-readable command catalog and safety metadata.
- `preflight`: health/client/runtime/capability checks.
- `capabilities`: live runtime command list.
- `yjs-snapshot`: read canonical canvas nodes and edges.
- `canvas-summary`: read compact Agent-oriented canvas state. Use `--full` only when full payloads are necessary.
- `find-elements`: query nodes/edges. Use `--summary`, `--fields`, and `--limit` on large or private canvases.
- `suggest-empty-region`: find a conservative placement area before creating new nodes.
- `create-text-node`: create an `rh-text` node.
- `create-text-nodes`: create multiple related `rh-text` nodes in one rollbackable operation.
- `group-elements`: create a visual group around explicitly provided node ids.
- `create-image-node`: create an `rh-image` node without running image generation.
- `create-video-node`: create an `rh-video` node without running video generation; use `--multimodal` when the intended path is reference-conditioned video.
- `create-reference-from-url`: create a usable reference node from an existing image URL.
- `upload-local-reference-image`: one-shot local upload that returns directly usable reference node ids and URLs.
- `upload-reference-image`: upload a local image into the canvas through the live page.
- `prepare-video-node`: collect upstream text/image inputs into video params.
- `validate-node-run`: generic validation before running text/image/video nodes.
- `validate-video-run`: validate effective video references.
- `generate-video-node`: safe high-level video generation.
- `poll-node-result`: wait for node output URLs after generation.
- `poll-task-result`: wait for output URLs matching a RunningHub task id.
- `delete-elements`: remove nodes/edges.

## Agent-Friendly Reference Upload

Prefer:

- `runninghub-canvas-bridge upload-local-reference-image --file <path> --config-json '<json>' --timeout 60000`

Use `result.primaryReference.nodeId` as the upstream image node for later commands. Do not infer the usable reference from the visible staging node; RunningHub may create a separate native upload node.

## Failure Handling

Stable error codes from `agent-manifest.stableErrorCodes`:

- `BRIDGE_OFFLINE`
- `NO_PAGE_CLIENT`
- `STALE_RUNTIME`
- `MISSING_CAPABILITY`
- `VALIDATION_FAILED`
- `WOULD_SPEND_CREDITS`

When a blocking preflight reason is present, fix that reason before sending canvas commands.

### Model filters and rejected history routes

`rh_list_models` and `rh_model_schema` accept categories such as `types: ["video"]`, or exact modes returned by discovery (`IMAGE_VIDEO`, `MULTIMODAL_VIDEO`). Categories expand to supported API modes; casing and hyphens are normalized.

A definite `HISTORY_ROUTE_CONFLICT` has `submissionState: "rejected"` and the original request/node/index evidence. Do not change the request ID and submit again. Preflight now surfaces this known conflict. Use `rh_sync_node_history` to diagnose and synchronize only a verified replacement index. If the same index remains rejected, it returns `changed: false`, `historyRoute.blocked: true` and requires the explicit preserving repair described below. It never silently clears `historyStorage`, creates a replacement P node, borrows another node’s history, or reports an unchanged pointer as repaired. The native reset flow detaches historical routing; it requires an explicit migration decision and preservation plan.

Network errors, malformed responses and missing task IDs remain `submissionState: "unknown"`. Recover the original receipt with `rh_command_result` for both timeouts and restarts (`rh_recover_command` is a compatibility entry) and inspect platform task history before any new submission.

### Preserve history while repairing a rejected route

After a recorded native 301 rejection, call `rh_sync_node_history` with `repairRoute: true, dryRun: true`. The preview validates every task/node/output relationship and returns `expectedRevisions`. Apply the same repair with that revision map and a new logical request ID. This explicit repair saves a private snapshot, stores the original native batches on the same node using the site's embedded history format, and retires the invalid remote link. It does not run the node or delete remote history.

`rh_node_history` keeps the server page/count unchanged and adds `preservedHistory`, `preservedHistories`, `embeddedHistory` and `combinedLocalResultCount` for recovered nodes. Select a preserved output with its original historyId/revision/outputId. Subsequent synchronization retains preserved generations when the platform creates a new remote index. `rh_delete_node_history` refuses preserved records while they form the recovery archive.

Run preflight again and inspect a dry-run payload after repair. Actual generation requires the user's generation authorization. A code/schema change, a route repair and a successful paid submission are separate checks.
