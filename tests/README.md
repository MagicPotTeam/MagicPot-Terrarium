# Tests

## Launcher release-tool safety

Run the aggregate release-tool tests and TypeScript check with:

```sh
npm run launcher:release-tools:test
npm run launcher:tools:typecheck
```

Publication cleanup is fail-closed: cleanup permission errors are reported as an `AggregateError`, replaced output paths are retained for quarantine, and an already-absent output preserves the original publication failure. CLI failures always exit non-zero and only expose an output basename (never private-key or other private paths).

Top-level test support files live here. Source-adjacent unit and component tests stay beside the code they cover.

Launcher channel-manifest and artifact-packer security tests are source-adjacent under `scripts/launcher-dotnet`. Run `npm run launcher:release-tools:test` to execute the artifact, builder, and signer suites. Artifact cleanup coverage keeps the temporary descriptor open while matching the live descriptor identity against the path, verifies link-count transition after unlink, and exercises path replacement with inode churn so attacker-owned replacements are preserved. Builder coverage includes immutable archive snapshots and same-size rewrite races, exact ZIP/manifest membership, payload SHA-256 and size verification, full uncompressed-size accounting, CRC corruption, Windows device/ADS/trailing-name rules, case and NFC collisions, file-directory prefix conflicts, encrypted/symlink entries, deadline enforcement, and a valid exact archive.

The production builder budgets are fixed in code: archive size 8 GiB (rejected from metadata before source contents are read), single ZIP entry 16 GiB, total unpacked size 64 GiB, compression ratio 200:1, 100,000 entries, and a 30-minute end-to-end deadline measured from CLI processing start through publication. Environment variables and release descriptors cannot raise these values. Internal test hooks may only make entry/deadline limits stricter. Any production budget increase requires a reviewed code change plus boundary-test and documentation updates.
