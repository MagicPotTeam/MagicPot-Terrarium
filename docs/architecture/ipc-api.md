# IPC API

## Source of truth

MagicPot's renderer-to-main API is defined in public TypeScript contracts under:

- `packages/app/src/shared/api/index.ts`
- `packages/app/src/shared/api/svc*.ts`
- `packages/app/src/shared/api/apiUtils/serviceDefSheet.ts`

The preload side builds a client from these definitions, and the main side registers matching service implementations. The public contract is the service name, method name, request type, response type, and method kind.

## Transport model

Every method is registered as one of two shapes:

| Shape             | Contract                       | Transport behavior                                                                                                             | Use for                                                                                                     |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `unary`           | `(req) => Promise<resp>`       | Request/response over Electron IPC invoke/handle.                                                                              | Finite operations such as reads, writes, status calls, commands, and dialog results.                        |
| `serverStreaming` | `(req, resp) => Promise<void>` | A `MessageChannel`/`MessagePort` streams `{ data }` events and closes when complete; errors are sent as stream error payloads. | Logs, queues, long-running subprocess output, ComfyUI events, chat streaming, and duplicate-check progress. |

All request and response payloads must be structured-clone compatible. Prefer plain objects, arrays, strings, numbers, booleans, `null`, and `Uint8Array` for binary data. Do not put functions, class instances, open file handles, or secrets that the renderer does not need into IPC payloads.

## Naming

Runtime channel names are formed as:

```text
<serviceName>.<methodName>
```

Examples:

- `svcState.getConfig`
- `svcComfy.submitWorkflow`
- `svcLLMProxy.chatStream`
- `svcLog.watchAppLogs`

## Base service catalog

The current public `BaseApi` includes these services.

| Service              | Responsibility                                                                                                                             | Public methods                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `svcState`           | Global config, build environment, user-data directory, storage locations, LLM proxy usage, MCP status.                                     | `getConfig`, `watchConfig`, `saveConfig`, `getBuildEnv`, `getUserDataDirectoryState`, `setUserDataDirectory`, `getStorageLocations`, `getLlmProxyAccessUsage`, `getMcpStatus`                                                                                                                                                                      |
| `svcComfy`           | ComfyUI API wrapper, queue/event helpers, workflow submission, image/mask upload and view retrieval.                                       | `getInstalled`, `getObjectInfo`, `getQueue`, `postPrompt`, `getHistory`, `uploadImage`, `uploadMask`, `getView`, `connectWs`, `submitWorkflow`, `waitPromptId`, `watchQueue`, `cancelQueueItem`                                                                                                                                                    |
| `svcHyper`           | Privileged local helpers for ComfyUI startup/detection, directory listing, subprocesses, GPU info, image saving, and clipboard operations. | `listFastSettingTemplates`, `getFastSettingValue`, `getExtraModelPaths`, `startComfyUI`, `comfyPortDetect`, `listComfyFiles`, `listDirShallow`, `startProcess`, `killSubProcess`, `runCommandSync`, `getGPUInfo`, `saveImageToDir`, `writeImageToClipboard`, `readClipboardText`, `readClipboardHtml`, `readClipboardImage`, `writeSvgToClipboard` |
| `svcLLMProxy`        | Chat, streaming chat, profile listing, proxy status/fetching, cancellation, and 3D model upload/sign/cleanup helpers.                      | `chat`, `chatStream`, `listProfiles`, `serverStatus`, `remoteFetch`, `cancelConversation`, `uploadHy3DModel`, `signHy3DModel`, `clearHy3DCosPrefix`                                                                                                                                                                                                |
| `svcQApp`            | Quick App configuration lifecycle.                                                                                                         | `listQAppCfgs`, `getQAppCfg`, `saveQAppCfg`, `deleteQAppCfg`, `deleteQApp`, `renameQAppCfg`                                                                                                                                                                                                                                                        |
| `svcTargetScheme`    | Target scheme lifecycle and target history.                                                                                                | `listTargetSchemes`, `saveTargetScheme`, `deleteTargetScheme`, `listTargetHistoryTargets`, `saveTargetHistoryTarget`                                                                                                                                                                                                                               |
| `svcCustomSkill`     | Custom skill lifecycle and batch save.                                                                                                     | `listCustomSkills`, `saveCustomSkill`, `deleteCustomSkill`, `batchSaveCustomSkills`                                                                                                                                                                                                                                                                |
| `svcProjectTrace`    | Project trace document lifecycle and event appending.                                                                                      | `listProjectTraces`, `readProjectTraceDocument`, `saveProjectTraceDocument`, `appendProjectTraceEvent`                                                                                                                                                                                                                                             |
| `svcCanvasThumbnail` | Project Canvas thumbnail cache and native thumbnail creation.                                                                              | `getThumbnailCacheRoot`, `writeThumbnailSet`, `createNativeThumbnail`                                                                                                                                                                                                                                                                              |
| `svcFs`              | File/image/text operations needed by user-facing features.                                                                                 | `listImagesInFolder`, `listFilesInFolder`, `saveImageToPath`, `readImageFromPath`, `readTextFile`, `readFileFromPath`, `writeTextFile`                                                                                                                                                                                                             |
| `svcDialog`          | Electron dialog wrapper.                                                                                                                   | `showOpenDialog`, `showSaveDialog`, `showMessageBox`                                                                                                                                                                                                                                                                                               |
| `svcLog`             | App and ComfyUI log streams.                                                                                                               | `watchAppLogs`, `watchComfyLogs`                                                                                                                                                                                                                                                                                                                   |
| `svcAppUpdate`       | App updater status and actions.                                                                                                            | `getStatus`, `checkForUpdates`, `downloadUpdate`, `installUpdate`, `watchStatus`                                                                                                                                                                                                                                                                   |
| `svcShell`           | Directory preparation, downloads, and Git repository installation.                                                                         | `ensureDirectory`, `downloadFile`, `installGitRepository`                                                                                                                                                                                                                                                                                          |
| `svcDuplicateCheck`  | Visual analysis and duplicate-check progress.                                                                                              | `runVisualAnalysis`, `runDuplicateCheck`                                                                                                                                                                                                                                                                                                           |
| `svcAdobeBridge`     | Export selected assets to Adobe-compatible workflows.                                                                                      | `exportAsset`                                                                                                                                                                                                                                                                                                                                      |
| `svcDccBridge`       | Export 3D/model assets to DCC workflows.                                                                                                   | `exportModel`                                                                                                                                                                                                                                                                                                                                      |
| `svcFigma`           | Resolve, sync, and update-check Figma files.                                                                                               | `resolveFile`, `syncFile`, `checkFileUpdate`                                                                                                                                                                                                                                                                                                       |
| `svcPhotoshop`       | Send/load images and manage realtime-generation integration with Photoshop.                                                                | `sendImageToPhotoshop`, `loadImageFromPhotoshop`, `startRealtimeGeneration`, `stopRealtimeGeneration`                                                                                                                                                                                                                                              |
| `svcPysssss`         | Pysssss/Comfy image listing and viewing helpers.                                                                                           | `listImages`, `viewImage`                                                                                                                                                                                                                                                                                                                          |
| `svcMagicAgentPlatform` | Feature-flagged MagicAgent Platform v1 service for route-scoped agent/tool/graph/package operations.                                      | `getStatus`, `listAgents`, `registerAgent`, `runAgent`, `listTools`, `callTool`, `listGraphs`, `createGraph`, `inspectGraph`, `runGraph`, `listGraphRuns`, `getGraphRun`, `watchGraphRun`, `cancelGraphRun`, `validatePackageManifest`, `scanPackage`, `installPackage`, `listPackages`, `inspectPackage`, `uninstallPackage`                                      |

Extension-provided IPC services are appended through `ApiExtensionServices` and `apiExtensionDef`. In the public open build these extension service definitions are empty.

## Contract rules

When adding or changing an IPC method:

1. Add or update the request/response types in the relevant `shared/api/svc*.ts` file.
2. Add the method to the service type and service definition sheet with the correct method kind.
3. Implement the method in the main process and register it through the API assembly.
4. Use explicit request objects, even when the request is currently empty, so the method can evolve additively.
5. Keep response objects versionable; prefer adding optional fields over changing existing field meanings.
6. Validate all renderer-provided paths, commands, URLs, provider IDs, and binary payload sizes in main-process code.
7. Do not add ad hoc IPC channels unless there is a documented Electron API reason; prefer the shared service system.

## Streaming behavior

A server-streaming method may send zero or more `onData` events before completion. Renderer-side callers should:

- Treat stream completion and stream error as distinct outcomes.
- Support cancellation by closing or aborting the stream when the UI no longer needs updates.
- Avoid assuming every stream emits a final summary event unless the method contract says so.

Main-side stream implementations should:

- Clean up timers, subprocess listeners, WebSocket handlers, and file watchers on abort/close.
- Convert errors into serializable stream errors.
- Avoid leaking credentials or full internal stack traces into renderer-visible payloads.

### `svcMagicAgentPlatform.watchGraphRun`

`watchGraphRun({ runId, route }, resp)` is a MagicAgent Platform `serverStreaming` method for graph-run observability. The main process authorizes the trusted Agent Studio route, derives the `sessionKey`, and subscribes only to a run in that session. The stream contract is one `snapshot`, zero or more `event` frames, then one `closed` frame. Each frame carries a per-run monotonic `sequence`, `runId`, `graphId`, status, timestamp, and the current run snapshot when available.

Renderer aborts unsubscribe from the watcher only; they do not cancel execution. Use `cancelGraphRun` for explicit cancellation. If a run cannot be found in the authorized route/session partition, the stream fails as not found without exposing whether the same `runId` exists under another route.
