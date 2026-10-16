# MCP 工具目录

0.10.3 共 **83** 个工具。以下描述由当前 MCP 工具清单生成；准确参数、必填字段和返回结构以客户端发现的 schema 为准。

所有画布工具携带任务自己的 `scopeId`。连接、账号目录和独立下载状态等工具不需要画布 scope。参见 [调用流程](../AGENT_QUICKSTART.md)。

## 连接与诊断

| 工具 | 用途 |
| --- | --- |
| `rh_diagnose` | Read-only Windows/macOS/Linux setup checks and actionable fixes. Does not export login data or submit generation. |
| `rh_recover_command` | Read a persisted receipt after reconnect/restart and inspect its target node when the same canvas is selected. Never resubmits; current node state alone does not prove an uncertain submission succeeded. |
| `rh_list_canvases` | List every personal account canvas, recursively including folders, using the logged-in browser. No canvas page needs to be open. Team scope requires exact teamId. complete=false means inventory is incomplete. |
| `rh_browser_result` | Recover a browser discovery/open result by browserRequestId after a timeout. Does not repeat the operation. |
| `rh_open_canvas` | Connect to an exact canvas and return a scope pinned to its page. Default intent=connect reuses a fresh connection without browser actions; older focus=true no longer activates existing tabs. Use intent=show only when the user explicitly asks to view the canvas, never for routine production or reconnects. If a page must be created, Codex requires foreground creation even for connect; inspect presentation.activation. Chrome/Edge can create background tabs. Prefers Codex when connected; browserSource selects the provider. Does not edit or generate. |
| `rh_status` | Inspect local bridge, connected canvas pages and their reported browser sources and active access scope. |
| `rh_select_canvas` | Select an exact connected canvas for this MCP session. allowWrites enables editing/upload/generation on this one canvas; false selects read-only. |
| `rh_command_result` | Recover the original bridge result after a timeout. Missing means unknown, never permission to submit a duplicate. |
| `rh_archive_status` | Read durable collection/import state and verified per-file receipts. complete means archived, not accepted or final. |
| `rh_download_status` | Read download progress and verified absolute local paths. complete confirms local files, not Lumen import. |
| `rh_task_status` | Read a batch of exact platform task IDs, including results when requested. No dependence on node current output. |

## 画布、节点与布局

| 工具 | 用途 |
| --- | --- |
| `rh_prepare_shots` | Prepare an entire batch from blank templates in one canvas edit: exact prompts, validated params, complete references and collision-free positions. Explicit unique node IDs make retries detectable. Does not generate. Archive binding failures are returned per shot. |
| `rh_auto_layout` | Arrange selected ungrouped nodes in the provided order, avoiding existing nodes. Other nodes stay in place. Grouped canvases require manual layout. |
| `rh_batch_update_nodes` | Apply parameter/title/position changes in one transaction. Every target requires the revision from rh_get_node. Any stale or missing target rejects the whole batch. |
| `rh_get_layout_template` | Read persistent default or canvas-specific layout rules. Call at the beginning of every new conversation/task and follow the returned rules when adding or organizing nodes. |
| `rh_set_layout_template` | Persist default or per-canvas scene layout geometry for future conversations. Does not move any nodes. Omit canvasUrl to update the shared default. |
| `rh_canvas_summary` | Read compact node titles, models, state, position and connection counts. No media URLs by default. |
| `rh_get_node` | Read a complete node or edge, including full unabridged prompt, parameters and output URLs. |
| `rh_find_nodes` | Find existing nodes by text/title before creating duplicates. |
| `rh_connections` | Read exact upstream/downstream nodes and edge IDs to inspect reference order and dependencies. |
| `rh_create_text_nodes` | Create several prompt cards in one edit; preserve text verbatim. Explicit positions prevent overlap. |
| `rh_update_node` | Update a node's title, complete prompt text or data fields. Read the existing node first. For image/video prompts use params.prompt. Does not generate. |
| `rh_move_nodes` | Batch place nodes at explicit positions in one edit. Use for asset zones, rows or columns. |
| `rh_connect_nodes` | Add a reference/prompt connection between existing nodes. Does not rewrite prompts or submit generation. |
| `rh_delete_elements` | Remove explicitly named nodes or edges. Pass only edgeIds to disconnect references without deleting assets. Inspect the proposed diff with dryRun first. |
| `rh_manage_canvas` | Create/rename a canvas, create/rename a folder, or move a canvas within the current account/team. Works without an open canvas. Uses an explicit account origin; does not edit canvas content. |
| `rh_duplicate_canvas` | Copy the selected canvas into a newly created private canvas. Returns the new task scope. Does not generate, publish or alter the source. Inspect the returned creation receipt before any retry. |
| `rh_edit_groups` | Create or regroup exact members, rename a group, or ungroup without deleting member nodes/edges. Recalculates memberships, offsets and bounds. |
| `rh_transform_nodes` | Move/resize nodes and synchronize dimensions, native group bounds and offsets. Moving a group moves its members; group size is derived. |
| `rh_align_nodes` | Align or distribute existing nodes. Synchronizes native group bounds/offsets and preserves content. Do not select a group and its members together. |
| `rh_check_layout` | Read-only layout inspection: missing members, incorrect parent references, overlapping ungrouped/native group bounds. Does not repair or delete. |

## 模型、应用与参考

| 工具 | 用途 |
| --- | --- |
| `rh_preflight` | Check live model constraints, connected reference slots and optional exact expected prompt/params/reference mapping. Returns a digest to pin rh_run_node. Does not assess artistic quality. |
| `rh_list_models` | Discover current platform models and their raw configuration. Live account/team context; not a price or entitlement guarantee. |
| `rh_model_schema` | Read live model parameter names, types, options, defaults and constraints. Pass modelType from rh_list_models as types to disambiguate modes. |
| `rh_inspect_references` | Recognize actual image/video/audio outputs, including rh-ai generated nodes. Returns exact output URLs and a revision for binding. |
| `rh_bind_references` | Atomically bind selected source outputs to exact live model parameters and connect source nodes. Merge preserves unspecified slots; replace clears all live media slots and removes proven old media edges. Inspect schema and outputs first; multiple outputs require an explicit URL. Does not generate. |
| `rh_apply_layout_template` | Arrange explicit scene/asset/tool groups using the persistent template. Each column contains one shot and its status/history nodes, top to bottom. Groups run vertically. Reuse existing group IDs and include all their members. Preserves all text, parameters, media and edges; no deletion or generation. Read target nodes first; expectedRevisions pins edits. Use dryRun to inspect placement. |
| `rh_clone_template` | Copy one genuinely blank configured model node. Preserve model/parameters; refuse result nodes, prompts or input references. Produces no generation. |
| `rh_update_params` | Merge exact parameters such as prompt, duration, ratio and reference slots without changing the model or generating. Read current parameters first. |
| `rh_validate_node` | Inspect existing node fields and reference dependencies without generating. Platform price/entitlement and acceptance are checked separately. |
| `rh_list_apps` | Search native AI applications, including user-owned applications. Results are platform data; read app schema before creating. |
| `rh_app_schema` | Read native AI app inputNodes, exact nodeId/fieldName/type/options/defaults. Does not use normal modelCode validation. |
| `rh_create_app` | Create a native rh-ai application node from its live schema, without blank placeholder inputs or generation. Bind existing references with rh_configure_app. |
| `rh_configure_app` | Set exact AI app input fields and optionally bind existing image/video/audio/text nodes in one transaction. Slots use application nodeId + fieldName, not canvas node IDs. Does not run. |
| `rh_create_model_node` | Create a model node or explicitly switch an existing node to a live catalog model. The new model receives its own schema defaults plus supplied params; old incompatible params are not retained. Does not generate. |

## 任务与媒体

| 工具 | 用途 |
| --- | --- |
| `rh_run_node` | Submit the already-configured node once; may spend credits. Follow the caller's project identity rules before submission; when Lumen archiving is enabled, use a registered target Work. dryRun only returns the outgoing graph. Never retry an uncertain submission with a new requestId. |
| `rh_node_history` | 读取当前节点自己的原生历史；翻页携带返回的 historyId 与 knownRevision，不切换当前结果。 |
| `rh_sync_node_history` | 校验 canvas、node、task 和输出后仅修复 historyStorage；保留视频、参数、参考、连线和采用状态。不生成、不借用其他节点索引。 |
| `rh_node_result` | Read current generation status, task ID and output URLs once without submitting or waiting for generation to finish. |
| `rh_upload_image` | Upload a local PNG/JPEG/WebP image (up to 30 MiB) through the logged-in canvas, creating a reusable reference node. No generation. The path must exist on this computer. |
| `rh_upload_media` | Upload a verified local image, video or audio through native canvas storage. PNG/JPEG/WebP up to 30 MiB, MP4/MOV/WebM up to 500 MiB, MP3/WAV/M4A/AAC/FLAC/OGG up to 50 MiB. Streams from this computer; no generation. |
| `rh_set_archive_target` | Bind a selected canvas node to its Lumen destination. Future rh_run_node calls automatically collect task-matched outputs, verify SHA and import via Lumen MCP. null removes the binding; does not generate. |
| `rh_archive_outputs` | Collect an existing or running task into an explicit Lumen destination. Requires exact taskId and expected successful output count; never generates. Runs in the background and survives bridge restart. |
| `rh_retry_archive` | Retry collection/import using the original frozen identity, SHA and Lumen request/token. After a bridge restart lost the submission response, taskId may attach an explicitly verified task to a job that has none. Never resubmit generation. |
| `rh_download_outputs` | Download inspected image/video/audio outputs to a local folder without Lumen. Durable job, SHA verification, no overwrite. Call rh_download_status; retry resumes partial downloads when server validators permit. |
| `rh_retry_download` | Retry the same download job without duplicate files. Uses HTTP Range only with a saved validator. |
| `rh_receive_chatgpt_file` | Receive an actual ChatGPT attachment onto the bridge computer. Pass the host-provided file object, never a /mnt/data path. Read download status then use its local path with rh_upload_media. No canvas mutation or generation. |
| `rh_preview_outputs` | Return playable remote media resource links from exact node outputs for inline preview/download. Does not download or generate. |
| `rh_download_task_outputs` | Download original outputs of an exact task even when its canvas node now shows a newer generation. No Lumen requirement. |
| `rh_add_task_output` | Reuse an exact historical task output on this canvas as a media reference, preserving its source identity. Existing exact URL is reused. Does not regenerate. |
| `rh_cancel_task` | Cancel one exact platform generation task. Does not submit replacements. Cancellation may not refund already consumed credits. |
| `rh_generation_history` | Read native generation history for the current browser account/team context. Fetch more pages until total is covered. |
| `rh_history_inputs` | Read recorded original generation parameters for a historical task and plan. |

## 资产、工作流与恢复

| 工具 | 用途 |
| --- | --- |
| `rh_search_assets` | Search the platform asset drawer, or browse groups/folders and their items. Asset tokens expire after 15 minutes or page/runtime reload; reuse them with rh_add_asset on the same canvas. |
| `rh_add_asset` | Reuse a searched platform image/video/audio on the canvas without uploading. Existing nodes with the exact URL are reused. Does not generate. |
| `rh_list_asset_types` | Read native asset library category codes used for creating folders and browsing media. |
| `rh_manage_assets` | Rename a native library asset/folder, create a library folder, or move explicit library items to a destination code returned by library browsing. |
| `rh_save_asset` | Save a selected canvas media node into an explicit native asset-library folder. Uses existing media URLs; no upload or generation. |
| `rh_list_workflows` | List account canvas workflow templates or retrieve an exact saved workflow. |
| `rh_save_workflow` | Save explicitly selected canvas nodes and internal connections as a reusable native workflow. Does not publish publicly or generate. |
| `rh_apply_workflow` | Apply an existing workflow into the selected canvas using new node IDs. Retains internal bindings and offsets, does not submit any generation. |
| `rh_save_snapshot` | Save an exact private local canvas snapshot and digest for later diff/recovery. Does not change the canvas. |
| `rh_list_snapshots` | List local snapshots for this exact canvas. |
| `rh_diff_snapshot` | Compare a saved snapshot to the current canvas; returns currentDigest required for restoring without overwriting intervening work. |
| `rh_restore_snapshot` | Restore an exact saved snapshot only if the whole canvas still matches currentDigest from rh_diff_snapshot. Saves a pre-restore backup. This can remove edits after the snapshot; never use to undo unrelated work. |

## Media routes and history selection

| Tool | Purpose |
|---|---|
| `rh_clone_nodes` | Copy explicit nodes/internal edges with new task/history identities and separate provenance. |
| `rh_apply_node_history` | Select an exact native historical output; optionally restore recorded parameters. |
| `rh_delete_node_history` | Delete one explicitly approved past output with revision protection; refuses the current result. |
| `rh_media_capabilities` | Compare free browser/local operations and consent-gated canvas processing. |
| `rh_plan_media_operation` | Freeze source, processing node, options and route rationale; return an owner approval link if charges are paid or unknown. |
| `rh_execute_media_operation` | Execute one unchanged plan; paid/unknown paths cannot self-authorize. |
| `rh_media_operation_status` | Recover original job/receipt or a verified local output, without resubmission. |

Local FFmpeg and browser pixel operations use no RunningHub generation credits. Native FFMPEG jobs and AI model processing are conservatively marked unknown-cost until a reliable exact quote is integrated. The caller must compare free routes instead of defaulting to the canvas. See [agent workflow](../AGENT_QUICKSTART.md#media-processing-and-spending-consent-010).

## Layout and cleanup (0.10.3)

`rh_apply_layout_template` accepts independent `nodeIds` grids or short shot `columns`, wraps at persistent `maxColumns` (default 4), resolves media metadata, and locks native image display sizes. `rh_check_layout` now includes same-group overlap and preview geometry risk.

`rh_cleanup_canvas` previews exact user-rejected nodes or verified empty app-created inputs, then accepts the preview digest to apply with a private recovery snapshot. It protects adopted, running and referenced nodes and never deletes media files or native history. Explicit user rejection is sufficient; PASS alone is not a rejection signal. `rh_configure_app` prunes only empty unused native input scaffolds by default. See the [agent layout guide](../AGENT_QUICKSTART.md#排版与批量准备).
