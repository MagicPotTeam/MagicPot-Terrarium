# Project Canvas Benchmark Policy

## Scope

This document defines documentation-only acceptance policy for Project Canvas Asset Resource Engine performance evidence. It covers the real-board benchmarks, especially large image-count import and mixed interaction scenarios. It complements `docs/architecture/project-canvas-asset-resource-engine.md`.

## Official acceptance profile

Official acceptance must use the scenario defaults documented in the repository scripts unless the benchmark policy is deliberately revised and reviewed.

For the current real-board large-board target, official evidence must include:

- built candidate application for the commit under review;
- `benchmark:project-canvas:real-board:mixed-3000` or the equivalent raw command with `MAGICPOT_REAL_BOARD_MODE=mixed`, `MAGICPOT_REAL_BOARD_IMAGE_COUNT=3000`, and the official pressure duration;
- a real corpus with enough unique image contents for the requested count;
- required cold-cache and warm-cache passes when a real corpus is configured;
- default memory watchdog enabled and reporting no official failure;
- aggregate/report artifacts containing acceptance status, cache metrics, pressure metrics, visual metrics, and memory-watchdog report.

Official pass criteria include no missing images, no permanent placeholders after settling, no source-upgrade failures, no maximum-update-depth errors, no right-side occlusion failure, React commit counts within configured limits, no sustained monotonic growth during pressure sampling, warm-cache hits covering imported images, and warm-cache generation near zero within the official limit.

## Diagnostic-only profile

Diagnostic runs are allowed for smoke testing and failure isolation. They must be labeled diagnostic in logs, issue comments, and summaries. They are not official acceptance evidence.

The following are diagnostic only:

- `MAGICPOT_REAL_BOARD_ALLOW_REPEAT=1` or any `ALLOW_REPEAT` workload behavior;
- increasing memory watchdog soft/hard thresholds;
- disabling the memory watchdog;
- reducing `MAGICPOT_REAL_BOARD_IMAGE_COUNT` below the official scenario target;
- lowering uniqueness requirements such as `MAGICPOT_REAL_BOARD_REPEAT_MIN_UNIQUE_FRACTION`;
- skipping required warm-cache passes;
- shortening the official pressure duration.

A benchmark that passes only after `ALLOW_REPEAT`, watchdog relaxation/disablement, or lower image count is still a failure for official acceptance.

## Evidence labeling

Every benchmark report should record or summarize:

| Field | Official expectation |
| --- | --- |
| Scenario | `mixed-3000` or reviewed official scenario name. |
| Image count | Official target, currently 3000 for mixed large-board acceptance. |
| Corpus | Real corpus path/label with sufficient unique content; no broad sync root or trash/artifact root. |
| Cache passes | Cold cache plus warm cache for configured real corpora. |
| Watchdog | Enabled with default official thresholds. |
| Repeat behavior | Disabled for official acceptance. |
| Pressure | Official duration and sampling enabled. |
| Result | Aggregate acceptance all passed, with artifacts retained. |

If any field is relaxed, the report is diagnostic.

## Criteria A-M acceptance checklist

| Criterion | Official evidence requirement |
| --- | --- |
| A. Boundary separation | Benchmark uses built app and public IPC paths, not test-only direct module calls for privileged work. |
| B. Source canonicalization | Corpus paths are resolved and rejected when they target workspace, trash, or overly broad sync roots. |
| C. Cache-root confinement | Artifact/cache roots remain under the benchmark artifact root or user-data cache root. |
| D. Manifest validation | Warm-cache metrics demonstrate complete manifest-backed thumbnail reuse. |
| E. Thumbnail-first import | Import succeeds through thumbnail/previews before source-resolution upgrades. |
| F. Deferred source upgrade | Tiny zoom/overview does not retain source textures for the whole board. |
| G. Resource budgets | Memory watchdog, pressure samples, and frame metrics remain within official limits. |
| H. Sidecar containment | If a sidecar is enabled in future runs, its limits and failures are captured as part of artifacts. |
| I. Cache poisoning resistance | Stale/incomplete cache entries are not counted as hits. |
| J. Official benchmark integrity | No `ALLOW_REPEAT`, watchdog relaxation, image-count reduction, or skipped required pass. |
| K. Diagnostic labeling | Any relaxed run is labeled diagnostic and excluded from acceptance claims. |
| L. Observability | Logs include actionable failures and report paths without unnecessary secret/path leakage. |
| M. Open/private neutrality | Evidence can be produced from the open repository plus user-provided corpus; no private-only code path is required. |
