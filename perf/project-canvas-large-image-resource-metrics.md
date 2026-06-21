# Project Canvas large image resource diagnostic metrics MVP

This benchmark-side MVP adds a diagnostic-only schema for optional large image resource telemetry. It does not change official benchmark thresholds, watchdog behavior, renderer imports, or the main thumbnail service.

## Schema

Schema name: `project-canvas-large-image-resource-diagnostics`  
Schema version: `1`  
Acceptance impact: `officialAcceptanceImpact: false`, `thresholdsChanged: false`

Optional fields:

- `first-thumbnail-ms`
- `cache-hit-count`
- `native-generated-count`
- `sidecar-generated-count`
- `resident-texture-bytes`
- `source-upgrade-count`
- `eviction-count`
- `eviction-reasons`
- `last-eviction-reason`
- `object-url-count`

Missing optional telemetry is preserved as `null` and marked unavailable. The collector does not manufacture zeroes for fields that are absent.

## Integration points

- `scripts/projectCanvas/largeImageResourceMetrics.mjs` defines parsing, formatting, and validation helpers.
- `scripts/projectCanvas/webglBenchmark.mjs` attaches the schema under `largeImageResourceMetrics` and `diagnosticMetrics.largeImageResources` in the existing WebGL report payload.
- `scripts/projectCanvas/realBoardBenchmark.mjs` attaches the same diagnostic object to per-scenario and aggregate real-board reports.

## Official vs diagnostic

Existing benchmark pass/fail logic continues to use the existing acceptance fields and thresholds. The new schema is diagnostic-only metadata for post-run analysis and trend dashboards.

Self-check command:

```bash
npx vitest run --config config/vitest/vitest.node.config.mjs scripts/projectCanvas/largeImageResourceMetrics.test.js scripts/projectCanvas/webglBenchmark.test.js scripts/projectCanvas/realBoardBenchmark.test.js
```
