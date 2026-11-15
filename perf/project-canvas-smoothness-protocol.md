# Project canvas: measurement protocol for "as smooth and as memory-light as PureRef"

Line numbers refer to the tree at the time of writing (November 2026) and will drift.
Companion script: `scripts/projectCanvas/canvasSmoothBench.mjs` (npm script `benchmark:project-canvas:smooth:raw`).

## 0. What the existing benchmarks can and cannot tell you

| Benchmark (npm script) | What it does | What it reports | Pass/fail gate | Blind spots for the PureRef goal |
|---|---|---|---|---|
| `benchmark:project-canvas:webgl[:raw]` (scripts/projectCanvas/webglBenchmark.mjs) | Copies the same 82x82 PNG (`assets/workflowImage.png`, 2188 bytes) 12 times (`MAGICPOT_WEBGL_BENCHMARK_IMAGES`, :27-30, :192-204), imports them through the file input, zooms until culling is seen, then 8 wheel steps 100 ms apart (:682-747) | `interactionBenchmark.{average,p50,p95,p99,max}RenderDurationMs`, `steadyStateFps`, `maxResidentTextureBytes`, `maxDomNodeCount` | `steadyStateFps > 60` plus accounting checks (:851-867) | "RenderDurationMs" is the CPU time of one `app.render()` call (ProjectCanvasWebGLImageLayer.tsx:1895-1923), not the time between frames on screen; `steadyStateFps = 1000 / average render call` (:758-760) is not a frame rate. 8 samples. 12 identical tiny images. No memory. |
| `benchmark:project-canvas:overlay[:raw]` (overlayBenchmark.mjs) | Seeds 48 items per overlay kind straight into IndexedDB `magicpot-canvas/canvas-items` (:16-18, :258-298), opens the canvas, zooms until overlays cull | overlay counts before/after zoom | DOM/per-kind accounting only (:506-518) | No timing, no memory, no images. |
| `benchmark:project-canvas:video[:raw]` (videoBenchmark.mjs) | 24 video items (`MAGICPOT_VIDEO_BENCHMARK_COUNT`, :23) from the fixture under packages/app/src/main/testSupport (:25-31) | mounted / playing / poster counts | budget accounting only (:711-730) | No timing, no memory. |
| `benchmark:project-canvas:real-board*` (realBoardBenchmark.mjs) | Imports N files in batches of 128 (:65-91, :1117-1240), 500 ms synthetic wheel burst (:2596-2699), 12 wheel samples 180 ms apart (:2553-2594), high-zoom source upgrade (:2715), optional pressure sampling (synthetic wheel every 16 ms, sample every 500 ms, :2221-2356), tiny-zoom probe (:2840); cold- and warm-cache passes | `frameTime` p50/p95/p99/max (again the CPU `app.render()` time, :2568, :2585), `hotPathReactCommits`, `postIdleReactCommits`, `webgl.residentTextureBytes`, `jsHeapBytes`, pressure summaries and monotonic-growth analysis (:1787-1842), `sourceUpgradeLatencyMs`, thumbnail cache hits, memory-watchdog report | `buildAcceptance` (:3090-3199): no missing/failed images or placeholders, source upgrade seen, tiny zoom suppresses sources, warm-cache hits, hot-path commits <= 2, post-idle commits <= 8, no sustained growth > 16 MiB / 32 counts, and frame p95 <= 24 ms **only when the board has <= 300 images** (:3555-3560) | No pan at all (every input is a wheel zoom); the official 3000-image run has no frame-time gate; "React commits" count renders of ProjectCanvasPageStageScene only (render-phase counter, ProjectCanvasPageStageScene.tsx:860-861); the memory watchdog is a host safety stop on *system* used memory (`os.totalmem()-os.freemem()`, :283-308), not app memory; no per-process memory (no `getAppMetrics` anywhere in the script); no GPU memory; no import or open timing; no time-to-first-image; no reopen. |
| `benchmark:project-canvas:real-board:official` (runOfficialBenchmark.mjs) | Forces mixed / 3000 / 30 s pressure / cold+warm / batch 128 / watchdog 0.75-0.8 (:8-22) and requires `MAGICPOT_REAL_BOARD_IMAGE_DIR(S)` (:29-37) | as above | as above | as above |
| `test:project-canvas:benchmark-smoke` (package.json:85) | vitest of the helper functions in the four *.test.js files | - | unit tests | Does not launch the app: not a performance measurement. |

Other facts that matter for running them:
- All benchmarks set `MAGICPOT_TEST_WINDOW_MODE=hidden` (benchmarkPolicy.mjs:70-80). The main window is then never shown and gets `backgroundThrottling:false` (mainWindow.ts:142, :155, :187-189). Frame cadence of a never-shown window is not what the artist sees: frame numbers must come from a visible window (section 3).
- The window size is whatever window-state.json holds (mainWindow.ts:134-141); benchmarks never set it, so visible-image counts depend on the PC.
- Reports land in `<checkout>\.magicpot-trash\<MAGICPOT_TEST_RUN_ID>\` (benchmarkPolicy.mjs:83-89; `MAGICPOT_TEST_DESKTOP_PATH` moves the parent).
- `largeImageResourceMetrics` defines `first-thumbnail-ms` (largeImageResourceMetrics.mjs:9-14) but nothing in packages/app/src emits `firstThumbnailMs`, so it is always reported as unavailable.
- `MAGICPOT_REAL_BOARD_SOFTWARE_GL=1` adds `--disable-gpu --disable-gpu-compositing` (appRuntime.ts:210-213): useful as a contrast, never as evidence.
- The Rust thumbnail sidecar is off unless `MAGICPOT_CANVAS_THUMBNAIL_SIDECAR=1` (canvasThumbnailSidecarAdapter.ts:5, :355-358, :487-489) and a binary exists in one of the candidate paths (:430-457). A plain `npm run build:pure` does not build it. To include it: install a Rust toolchain, run `npm run build:image-worker` (package.json:105, scripts/build-image-worker.mjs:14-38: cargo build of packages/canvas-thumbnail-sidecar, copied to `packages\runtime-assets\resources\bin\image-worker\win32-x64\magicpot-image-worker.exe`, one of the adapter's candidate paths, canvasThumbnailSidecarAdapter.ts:430-440), then set `$env:MAGICPOT_CANVAS_THUMBNAIL_SIDECAR = "1"` for a separate pass and compare `thumbnailCache` / import timings with and without it.
- On a machine without a usable GPU (for example a Linux container under xvfb) `app.getGPUFeatureStatus()` reports `webgl: unavailable_off` and `gpu_compositing: disabled_software` with default switches, and the canvas then does not use its WebGL layer at all: images go through the Canvas2D fallback (`data-project-canvas-canvas2d-fallback-image-count`, ProjectCanvasPageStageScene.tsx:3093; `data-project-canvas-webgl-initialized=false`, :3105). With `--enable-unsafe-swiftshader --ignore-gpu-blocklist --use-angle=swiftshader` WebGL2 comes up on SwiftShader (`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))`) and the WebGL layer runs, in software. A canvas number measured in such an environment belongs to the WebGL path only if the run passed those switches. On a PC check `gpu.webgl = enabled` and a real GPU name in `glRenderer` before using any number.

## 1. PC preparation (once)

1. Record: CPU, RAM, GPU + driver version, display resolution, refresh rate, Windows display scale (100/125/150 %), power plan. Plug in the laptop, choose the High performance / Best performance power mode, close browsers, games, other Electron apps.
2. Install Node 24.18 or newer below 25 (package.json:16-19) and Git. Optional: PresentMon 2.x (Intel, open source) for present-to-present frame times, PureRef 2.x for the comparison.
3. Checkout and build (PowerShell):

```powershell
git clone <repo-url> C:\mp ; cd C:\mp
git checkout <branch-under-test>
npm ci
npm run build:pure                      # typecheck + electron-vite build into .\out (several minutes)
npm run test:project-canvas:benchmark-smoke
```

4. Corpus folders OUTSIDE the checkout (realBoardBenchmark.mjs:1328-1356 refuses the workspace, `.magicpot-trash` and the BaiduSyncdisk root):
   - `D:\mp-corpus\refs-small` : at least 2000 distinct real reference images around 800-1600 px (web references).
   - `D:\mp-corpus\refs-large` : at least 500 distinct photos / renders of 3000-6000 px (8-24 MP), JPEG and PNG.
   - `D:\mp-corpus\mixed-3000` : at least 1500 distinct images for the official run (mixed mode adds 1500 generated 1536 px PNG itself, :1603-1636).
   Duplicate contents with different names do not count (:1537-1546).

## 2. Existing benchmarks: exact commands, order, what to copy out

Run each command from `C:\mp`, one at a time, nothing else running. `:raw` variants skip the rebuild. Every run gets its own id.

```powershell
# 2.1 WebGL smoke (about 1-2 min)
$env:MAGICPOT_TEST_RUN_ID = "pc-webgl-1"; npm run benchmark:project-canvas:webgl:raw
#   -> .magicpot-trash\pc-webgl-1\webgl-benchmark-report.json
#   copy: interactionBenchmark.p50RenderDurationMs / p95 / p99 / maxRenderDurationMs, maxResidentTextureBytes, exit code
#   (CPU time per render call, NOT frame time)

# 2.2 Overlay and video accounting (about 1-2 min each)
$env:MAGICPOT_TEST_RUN_ID = "pc-overlay-1"; npm run benchmark:project-canvas:overlay:raw   # -> overlay-benchmark-report.json
$env:MAGICPOT_TEST_RUN_ID = "pc-video-1";   npm run benchmark:project-canvas:video:raw     # -> video-benchmark-report.json
#   copy: exit code only (they gate accounting, not speed)

# 2.3 Real board, generated 1536 px PNG, 300 images: the only size where the frame p95 gate is active
$env:MAGICPOT_TEST_RUN_ID = "pc-seeded-300-1"
$env:MAGICPOT_REAL_BOARD_MODE = "seeded-hires"; $env:MAGICPOT_REAL_BOARD_IMAGE_COUNT = "300"
$env:MAGICPOT_REAL_BOARD_PRESSURE_DURATION_MS = "30000"
npm run benchmark:project-canvas:real-board:raw

# 2.4 Real board, real corpus, 1800 images (import mode)
$env:MAGICPOT_TEST_RUN_ID = "pc-import-1800-1"; $env:MAGICPOT_REAL_BOARD_IMAGE_DIR = "D:\mp-corpus\refs-small"
npm run benchmark:project-canvas:real-board:import-1800:raw

# 2.5 Official acceptance (mixed 3000, cold + warm cache; the longest run, budget an hour)
$env:MAGICPOT_TEST_RUN_ID = "pc-official-1"; $env:MAGICPOT_REAL_BOARD_IMAGE_DIR = "D:\mp-corpus\mixed-3000"
npm run benchmark:project-canvas:real-board:official
Remove-Item Env:MAGICPOT_REAL_BOARD_*      # before the next block
```

Real-board output tree: `.magicpot-trash\<runId>\real-board\aggregate-report.json`, `memory-watchdog-report.json`, and per pass
`real-board\<corpusLabel>\<mode>-<count>\<cold-cache|warm-cache>\real-board-benchmark-report.json`, `renderer-diagnostics.json`, `real-board-screenshot.png`.
Copy per pass: `acceptance.passed` and `acceptance.failures`; `frameTime.p50/p95/p99/max`; `interactionBurst.hotPathReactCommits`, `postIdleReactCommits`;
`webgl.residentTextureBytes`, `webgl.residentTextureBudgetBytes`, `webgl.sourceCount`; `jsHeapBytes`; `pressure.summary.jsHeapBytes`, `pressure.summary.residentTextureBytes`,
`pressure.sustainedMonotonicGrowth.breached`; `sourceUpgradeLatencyMs`; `thumbnailCache.cacheHitCount`, `cacheGeneratedCount`; `memoryWatchdog.peak.usedPercent`;
`gpuFeatureStatus` (must say `webgl: enabled`, `gpu_compositing: enabled`; otherwise the run measured software rendering and is void). Time each command with
`Measure-Command { ... }` and record it.
Check once (medium-confidence suspicion): in `interactionBenchmark.samples[]` the twelve `renderDurationMs` values are often identical. The sample waits 180 ms after a wheel (:2563) while the
canvas keeps the gesture "interacting" for 240 ms after the last wheel (useCanvasStageInteraction.ts:36, :433-438) and does not publish render metrics while interacting
(ProjectCanvasWebGLImageLayer.tsx:1924-1928), so a sample can read the value of an older render.

## 3. New measurements (canvasSmoothBench.mjs)

What it adds (all inside the real built app, real CDP input, no app change):
- presented-frame cadence from `requestAnimationFrame` timestamps in the canvas page during each gesture: p50/p95/p99/max interval, frames over 25/33/50/100 ms; plus the app's own WebGL render rate from `data-project-canvas-webgl-render-count`;
- `PerformanceObserver` `long-animation-frame` entries (blocking time and the top script attributions) and `longtask`;
- WebGL counters by wrapping `WebGL2RenderingContext.prototype` / `WebGLRenderingContext.prototype` before the app loads: draw calls per frame, `texImage2D`/`texSubImage2D` uploads and bytes, `bufferData` bytes, textures created/deleted, `generateMipmap`, estimated live texture bytes (RGBA8 assumption);
- React commits of the whole tree through a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__` installed with `addInitScript` + reload (the app's own counter only sees StageScene renders);
- memory per process from Electron `app.getAppMetrics()` (working set everywhere, private bytes on Windows; renderer identified by `webContents.getOSProcessId()`), JS heap and DOM nodes from CDP `Performance.getMetrics`, a forced GC (`HeapProfiler.collectGarbage`) before every point; optional Chromium memory-infra totals (`MB_MEMORY_INFRA=1`, through `contentTracing`, works on Windows) for the `gpu`, `skia`, `cc`, `v8`, `partition_alloc`, `malloc`, `discardable` allocators;
- import timing (in-page 50 ms poller): first item, first pixels, all items, complete board (no pending / placeholder / missing, stable 500 ms), source upgrades settled; the same on reopen after a relaunch on the same profile;
- soak: N minutes of pan + zoom cycles, memory every `MB_SOAK_SAMPLE_S`, least-squares slope in MB/min with R2 per process.
Gestures (each followed by a measured settle window): idle 2 s, zoom-out-to-all (wheel until every image is visible), pan-overview (middle-button drag, 12 px per 16 ms), zoom-wobble (alternating wheel), zoom-in-near (to scale 1), pan-near, zoom-back-out. Memory points: baseline (empty canvas), imported (still selected: selected images get full-size sources), settled (Escape, 5 s, GC), after gestures, soak points, reopened.
Not covered yet: `performance.measureUserAgentSpecificMemory()` needs a cross-origin-isolated page, which the app's renderer is not; use process metrics + memory-infra instead. Event Timing does not report wheel / pointermove, so input latency for pan is not measured here (PresentMon or a high-speed camera for that).

Commands (PowerShell, from `C:\mp` after `npm run build:pure`; the corpus is copied/generated under `MB_OUT`):

```powershell
$B = "C:\mp\scripts\projectCanvas\canvasSmoothBench.mjs"
$env:MP_REPO = "C:\mp"; $env:MB_WINDOW = "visible"; $env:MB_WIDTH = "1600"; $env:MB_HEIGHT = "1000"

# 3.1 synthetic boards (reproducible): small 1024x768 PNG and large 4096x3072 PNG
$env:MB_OUT = "C:\mp\.magicpot-trash\csb-small-1"; $env:MB_SIZES = "small"; $env:MB_COUNTS = "100,500,2000"; node $B
$env:MB_OUT = "C:\mp\.magicpot-trash\csb-large-1"; $env:MB_SIZES = "large"; $env:MB_COUNTS = "100,500,2000"; node $B
#    synthetic files: 1024x768 = 0.07 MB, 4096x3072 = 1.07 MB on disk (generated once per MB_OUT, 0.09 s / 0.28 s each here);
#    decoded RGBA: 3 MB and 48 MB per image. 2000 large = 96 GB if anything kept full-resolution copies of all of them,
#    which is exactly what the LOD policy must prevent. Real JPEG/PNG corpora (3.2) are needed for realistic file-read and decode cost.

# 3.2 real corpora (what the artists drop on the board)
Remove-Item Env:MB_SIZES
$env:MB_IMAGE_DIR = "D:\mp-corpus\refs-small"; $env:MB_OUT = "C:\mp\.magicpot-trash\csb-refs-small-1"; $env:MB_COUNTS = "100,500,2000"; node $B
$env:MB_IMAGE_DIR = "D:\mp-corpus\refs-large"; $env:MB_OUT = "C:\mp\.magicpot-trash\csb-refs-large-1"; $env:MB_COUNTS = "100,500";      node $B

# 3.3 leak run: 10 minutes of pan/zoom on 500 real images, memory every 30 s
$env:MB_IMAGE_DIR = "D:\mp-corpus\refs-small"; $env:MB_OUT = "C:\mp\.magicpot-trash\csb-soak-1"; $env:MB_COUNTS = "500"
$env:MB_SOAK_MIN = "10"; $env:MB_SOAK_SAMPLE_S = "30"; $env:MB_MEMORY_INFRA = "1"; node $B
Remove-Item Env:MB_SOAK_MIN, Env:MB_MEMORY_INFRA

# 3.4 import of 200 files (the "drop a folder" moment), three repetitions
$env:MB_COUNTS = "200"; $env:MB_REOPEN = "1"
1..3 | % { $env:MB_OUT = "C:\mp\.magicpot-trash\csb-import200-$_"; node $B }
```

Output per board: `<MB_OUT>\<class>-<count>\result.json` (all numbers), `board.png`, `reopened.png`, `main-output-*.log`; per run `<MB_OUT>\summary.md` and `summary.json`.
Copy out per board (all in result.json):
- `display` (DPR, size, visibility must be `visible`), `glRenderer` (must name the real GPU, not SwiftShader / llvmpipe), `gpu`;
- `import.firstPixelsMs`, `import.completeMs`, `import.sourceSettledMs`, `import.responsiveness.frames.p95/max`, `import.responsiveness.loaf.blockingMs`;
- `reopen.firstPixelsMs`, `reopen.completeMs`;
- per gesture `gestures[].during.frames.{fps,p50,p95,p99,max,over33,over50}`, `during.appWebglRendersPerS`, `during.gl.drawsPerFrame`, `during.gl.texUploads`, `during.gl.texUploadMB`, `during.reactCommits`, `during.loaf.blockingMs`, and the same for `settle`;
- `perImageMB.renderer`, `perImageMB.gpu`, `perImageMB.all` (settled, deselected), `perImageMB.selectedAll`, and `memory.settled.totals`, `memory.reopened.totals`, `memory.*.liveTexMB` vs `memory.*.canvas.residentTexBytes` (the app's own estimate);
- soak: `soak.slopeMBPerMin.{renderer,gpu,all,jsHeap,liveTex}.perMin` and `.r2`, `soak.frameP95.first/last/worst`.
Repeat every board three times on a quiet PC and report the median; discard the first run after a reboot (disk cache).

Window modes: `MB_WINDOW=visible` (default) shows the window at 0,0 on the primary display with the test-window variables removed, so the app behaves as for a user. `offscreen`, `secondary-display` and `hidden` use the app's test-window policy (testUiPolicy.ts:236-262); the script always passes `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` and `--disable-background-timer-throttling`, because Windows occlusion tracking otherwise throttles an off-screen window. Frame numbers are valid only from `visible` (or a visible window on a second monitor). If `idle` reports a rAF fps far below the display refresh rate, the run is not valid.

Reading the numbers correctly (learned from proof runs):
- `during.appWebglRendersPerS` comes from `data-project-canvas-webgl-render-count`, which the WebGL layer publishes only after the gesture has idled (ProjectCanvasWebGLImageLayer.tsx:1924-1929), so it reads 0 during most gestures. Use `during.gl.draws` / `drawsPerFrame` (counted at the WebGL API) for work done during the gesture, and `settle.*` for what happens after.
- For the same reason the stage's `scale` / `visible` attributes freeze while a gesture runs; `zoom-out-to-all` and `zoom-in-near` therefore pause `MB_IDLE_READ_MS` (default 320 ms, longer than the 240 ms idle of useCanvasStageInteraction.ts:36) every 6 wheel steps before reading them. Those pauses are part of the gesture's frame list; `pan-*` and `zoom-wobble` have no pauses and are the cleanest frame-time numbers.
- `reactCommits` counts commits of every React root in the window (the Agent column included); `stageSceneRenders` is the app's own counter (StageScene renders only). Commits in `idle` mean something renders without input.
- `import.firstItemMs` is the time until the first image exists on the stage at all; if it equals `completeMs`, the import path added the whole batch at once (no progressive appearance).
- No `performance.measureUserAgentSpecificMemory()`: it needs a cross-origin-isolated page and the app sets no COOP/COEP header anywhere in packages/app/src.

## 4. PresentMon and Windows counters (frames on screen, GPU memory, PureRef)

```powershell
# frames actually presented by Chromium's GPU process (electron.exe) during a gesture run; 25 s capture
PresentMon-2.x-x64.exe --process_name electron.exe --output_file C:\mp\.magicpot-trash\pm-magicpot.csv --timed 25 --terminate_after_timed
# dedicated + shared GPU memory per process (all electron.exe and PureRef.exe processes), once per second for 20 s
Get-Counter '\GPU Process Memory(*)\Dedicated Usage','\GPU Process Memory(*)\Shared Usage' -SampleInterval 1 -MaxSamples 20 |
  % { $_.CounterSamples | ? { $_.CookedValue -gt 0 } | select Timestamp, InstanceName, @{n='MB';e={[math]::Round($_.CookedValue/1MB,1)}} } |
  Export-Csv C:\mp\.magicpot-trash\gpu-mem.csv -NoTypeInformation
# process memory, any app
Get-Process electron, PureRef -ErrorAction SilentlyContinue | select Name, Id, @{n='WS_MB';e={[math]::Round($_.WorkingSet64/1MB)}}, @{n='Private_MB';e={[math]::Round($_.PrivateMemorySize64/1MB)}}
```
The GPU counter instance names start with `pid_<pid>_`; map them to the processes listed in `result.json -> memory.*.procs`.
From PresentMon take the present-to-present interval column (`MsBetweenPresents` in v1 output, `FrameTime` in v2) during the pan window: p50 / p95 / p99 / max and the count over 33 ms.
PresentMon sees D3D/DXGI presents; Chromium on Windows presents through ANGLE/D3D11. Whether it sees PureRef depends on PureRef's renderer and the driver: if PureRef shows no presents, record that and compare memory only.

PureRef comparison with the same corpus folder: start PureRef, drag the same 100 / 500 / 2000 files in, wait until it stops loading (time it with a stopwatch: first image visible, everything loaded), wait 30 s, record `Get-Process PureRef` and the GPU counters; pan and zoom by hand for 25 s while PresentMon records; save, close, reopen the .pur file and time it again. Same window size and display.

## 5. Proposed targets (to be confirmed against the PureRef numbers measured in section 4)

| Quantity | Target | Source of the number |
|---|---|---|
| Pan / zoom presented frame interval at 100 / 500 / 2000 images, small and large | p95 <= 1.25 x refresh interval (20.8 ms at 60 Hz, 10.4 ms at 120 Hz), p99 <= 2 x, max <= 50 ms, zero intervals > 100 ms | canvasSmoothBench `gestures[].during.frames`, PresentMon |
| Work per pan/zoom frame | 0 React commits, 0 texture uploads while the content was already resident, draw calls flat with board size at overview | `during.reactCommits`, `during.gl.*` |
| Settle after a gesture | done within 1 s: no React commits and no texture uploads 1 s after the input stops (except source upgrades for newly visible images) | `settle.*` |
| Import 200 files | first pixels < 500 ms, complete board < PureRef's time, no rAF interval > 100 ms during import | `import.*`, `import.responsiveness` |
| Reopen a 2000-image board | first pixels < 1 s, complete < 5 s on warm cache | `reopen.*` |
| Memory per image after settle (renderer + GPU, deselected) | <= 1.33 x RGBA bytes of the level actually displayed + 0.5 MB metadata; total <= 1.2 x PureRef for the same corpus | `perImageMB`, Windows counters |
| 10 min pan/zoom | slope within +/-1 MB/min for renderer, GPU and JS heap after the first 2 min (R2 reported), frame p95 of the last cycle within 10 % of the first | `soak.*` |

## 6. Proposed changes to the existing repository benchmarks

| # | Where | Change | API |
|---|---|---|---|
| 7.1 | webglBenchmark.mjs:750-772 and the gate at :865 | Rename `steadyStateFps` to `cpuRenderCallsPerSecondBound` and stop gating on it; gate on presented-frame cadence from rAF timestamps over a 3 s continuous wheel + pan burst instead. Use more than one 82 px image (:192-204): at least 200 unique 1-2 MP files. | `requestAnimationFrame` timestamps collected in-page (`page.evaluate`) |
| 7.2 | realBoardBenchmark.mjs:2561-2579 (`runInteractionBenchmark`) | The 180 ms wait (:2564) is shorter than `VIEWPORT_INTERACTION_IDLE_MS = 240` (useCanvasStageInteraction.ts:36, :433-438), and the WebGL layer does not publish metrics while interacting (ProjectCanvasWebGLImageLayer.tsx:1924-1929), so a sample can read an older render. Either wait >= 300 ms, or (better) let the layer keep a ring buffer of the last 512 `{at, cpuMs}` render records behind the existing `MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK` gate and read it once after the burst. | ring buffer on `window`, read by `page.evaluate` |
| 7.3 | realBoardBenchmark.mjs:2596-2699 (burst) and :2221-2356 (pressure) | Both send only synthetic `WheelEvent`s. Add a pan phase (middle-button drag via `page.mouse.down({ button: 'middle' })` + `page.mouse.move` every 16 ms) and record rAF intervals for both phases: p50 / p95 / p99 / max, count > 33 ms and > 50 ms. | rAF, Playwright mouse |
| 7.4 | realBoardBenchmark.mjs:3555-3560 | Remove the `REAL_BOARD_IMAGE_COUNT <= 300` condition so the official 3000-image run also has a frame gate (rAF p95/p99 from 7.3), and make the gate conditional on `gpuFeatureStatus.webgl` starting with `enabled` (software-GL runs report, but are not gated). | `app.getGPUFeatureStatus()` (already read at :846-851) |
| 7.5 | realBoardBenchmark.mjs, next to the memory watchdog (:283-308 reads only `os.freemem()`) | Add per-process memory points: baseline (empty canvas), after import (selected), settled (deselected, GC), after pressure, after reopen. Copy the pattern of scripts/chat/chatImageMemoryBenchmark.mjs:283 (`app.getAppMetrics()`), identify the canvas renderer by `webContents.getOSProcessId()`, use `privateBytes` on Windows; force GC first with CDP `HeapProfiler.collectGarbage`. Report MB per image for renderer and GPU. | `app.getAppMetrics()`, CDP |
| 7.6 | realBoardBenchmark.mjs:98, :151-170, :1787-1842 | Pressure is 30 s with a "4 consecutive rising samples over 16 MiB" rule. Add an opt-in soak profile (`MAGICPOT_REAL_BOARD_SOAK_MINUTES=10`): memory point every 30 s with GC, least-squares slope in MB/min with R2 per process, frame p95 first vs last minute. | as 7.5 |
| 7.7 | largeImageResourceMetrics.mjs:9-14, :445-450 | `firstThumbnailMs` is read from `metricsSnapshot.largeImageResources` but nothing in packages/app/src writes it (grep finds no producer). Either have the import path set it, or measure milestones in the benchmark with an in-page 50 ms poller of the stage data attributes (first item, first pixels, complete, sources settled) as canvasSmoothBench does; repeat after a relaunch on the same profile (reopen). | `performance.now()`, stage `data-*` attributes |
| 7.8 | realBoardBenchmark.mjs:1976, :2265, :2629 (`reactCommits` = `data-project-canvas-react-commit-count`) | That counter is a render-phase counter of ProjectCanvasPageStageScene only (ProjectCanvasPageStageScene.tsx:860-861, published at :1776). Count whole-tree commits too, with a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot` installed by `addInitScript` before the app loads. | React DevTools global hook |
| 7.9 | all four benchmarks | Observe Long Animation Frames during every gesture and during import, with script attribution, and report blocking time and the top 5 functions. | `PerformanceObserver({ type: 'long-animation-frame' })`, `longtask` |
| 7.10 | benchmarkPolicy.mjs:70-80 | Every benchmark runs `MAGICPOT_TEST_WINDOW_MODE=hidden`; the window is never shown (mainWindow.ts:142, :187-189) and its size comes from window-state.json (:134-141). Add a `MAGICPOT_BENCHMARK_WINDOW=visible` profile that shows the window at a fixed content size and records DPR, refresh rate and `document.visibilityState`; only that profile may produce frame-time evidence. | `BrowserWindow.setContentSize`, `screen.getPrimaryDisplay().displayFrequency` |
| 7.11 | realBoardBenchmark.mjs (new) | WebGL truth beside the app's own estimate `webgl.residentTextureBytes`: wrap `WebGL2RenderingContext.prototype` (`texImage2D`, `texSubImage2D`, `texStorage2D`, `generateMipmap`, `deleteTexture`, `draw*`, `bufferData`) in an init script; report uploads and MB per gesture, draw calls per frame, live texture estimate; plus `contentTracing` memory-infra `gpu` allocator totals once per run. | WebGL prototype wrap, `contentTracing` |
