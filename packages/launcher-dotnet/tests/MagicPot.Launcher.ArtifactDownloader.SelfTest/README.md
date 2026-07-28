# ArtifactDownloader SelfTest

This Windows x64-only executable tests the downloader through its verified-manifest capability boundary. Every download input is produced by a freshly signed, Node-schema-compatible channel manifest: a deterministic Bouncy Castle `Ed25519PrivateKeyParameters` seed creates the public verifier, `ParseAndVerifyChannelManifest` creates a `VerifiedChannelManifestProof`, `SelectLatestArtifacts` selects the release, and proof-bound app/runtime requests are passed to the internal `ArtifactDownloader.DownloadAsync(VerifiedArtifactRequest)` overload.

The fixture builder varies payload bytes and matching SHA-256/size, app/runtime URLs, build and runtime identities, unpacked size, entrypoint, `createdAt`, `generatedAt`, raw JSON formatting, and signing key. It re-signs every variant. Tests never construct `VerifiedArtifactRequest` or `ArtifactDownloadIdentity` directly.

Coverage includes:

- first download, read-only verified lease, zero-network cache reuse, and metadata rebuild;
- exact content length, stream size, SHA-256, final URL, redirect, trusted-source, cancellation, timeout, and cleanup validation;
- cache quarantine/redownload after payload tampering;
- same-request serialization and different-request parallelism;
- metadata corruption recovery and metadata identity-conflict fail-closed behavior;
- lease/path TOCTOU behavior plus hard-link and reparse-point defenses;
- app and runtime proof-derived identities;
- cache isolation for artifact fields, different Ed25519 verifier keysets, exact raw-manifest digest (including semantically equivalent JSON formatting), and re-signed `generatedAt` changes;
- rejection of selections copied from another manifest or assembled as ordinary DTOs;
- reflection checks that `ArtifactDownloader` is non-public, has no app/runtime DTO overload, and downloads only a `VerifiedArtifactRequest` capability.

`lease.Path` is diagnostic only. Consumers must use `lease.Stream`, which is the already-verified open file object; reopening the pathname is not a verified operation.

The SelfTest has implicit usings disabled and warnings treated as errors. Bouncy Castle is obtained transitively through the launcher `ProjectReference`, keeping the test on the exact cryptography dependency used by production.

Run from the repository root on Windows x64:

```powershell
dotnet build packages/launcher-dotnet/tests/MagicPot.Launcher.ArtifactDownloader.SelfTest/MagicPot.Launcher.ArtifactDownloader.SelfTest.csproj -p:TreatWarningsAsErrors=true
dotnet run --project packages/launcher-dotnet/tests/MagicPot.Launcher.ArtifactDownloader.SelfTest/MagicPot.Launcher.ArtifactDownloader.SelfTest.csproj -c Release
```
