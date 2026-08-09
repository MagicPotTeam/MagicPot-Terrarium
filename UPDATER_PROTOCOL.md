# Launcher updater release protocol

The .NET launcher consumes a signed channel manifest and separate immutable app/runtime ZIP artifacts. `scripts/launcher-dotnet/package-signed-launcher-release.ts` composes the existing hardened packer, unsigned manifest builder, and Ed25519 signer; it does not implement parallel signing or archive logic.

## Reusable release workflow configuration

Set `launcher_update_enabled: true` only when all values below are configured for `.github/workflows/call-release.yml`:

- secret `launcher_manifest_private_key_pem`: PKCS#8 Ed25519 private key PEM used only through a runner-temp file.
- secret `launcher_update_config_json`: generator input containing channel URLs, trusted release source, and validated public-key fields. The release workflow separately compiles the supplied `launcher_public_key_base64` into both bootstrap descriptor and embedded-manifest trust dictionaries.
- input `launcher_base_url`: credential-free HTTPS GitHub release-download directory, ending in `/`; artifact URLs are derived from it.
- input `launcher_key_id`: key ID matching `publicKeys` in the generated configuration.
- input `launcher_public_key_base64`: canonical Base64 raw 32-byte manifest public key; the signer verifies it against the private key.
- inputs `launcher_version` and `launcher_minimum_version`: SemVer values for compiled configuration and manifest compatibility.
- optional input `launcher_channel`: `stable`, `beta`, or `nightly`. Empty maps tags containing `nightly` to nightly, other prereleases to beta, and all remaining releases to stable.

When launcher integration is disabled, normal NSIS/embedded assets are unchanged and the repository's compiled default remains `LauncherUpdateConfiguration.Disabled`. When enabled, any missing value aborts the job; it never silently emits unsigned launcher assets. The private key and generated configuration are deleted in an `always()` cleanup step.

## Produced release assets

Immutable app/runtime and release-index names include channel, version, build ID, platform, and ABI. The channel manifest uses the deterministic per-channel name expected by compiled channel URLs. The workflow publishes those files and the unsigned signing input for audit alongside the final bootstrap bundle: `MagicPot.Bootstrap.exe`, `MagicPot.Launcher.exe`, `MagicPot.Uninstall.exe`, `MagicPot.Bootstrap.json`, and the raw 64-byte `MagicPot.Bootstrap.sig`.

## Bootstrap bundle and migration limitations

Bootstrap schema 1 uses a signed, colocated bundle. The descriptor names only safe relative basenames for `MagicPot.Launcher.exe` and `MagicPot.Uninstall.exe`; URL sources, absolute paths, traversal, reserved names, and command-line payload overrides are rejected. Release tooling generates both C# sources in `packages/launcher-dotnet/src/MagicPot.Launcher`, publishes Launcher and Uninstall first, and publishes Bootstrap with `-p:BootstrapGeneratedTrustConfig=<absolute-generated-source>` so the project reference receives the compiled trust property. Both generated sources and the temporary private-key file are removed by unconditional cleanup.

After the signed app/runtime archives and channel manifest exist, the descriptor command is invoked with the exact selection used by that manifest:

```text
npm run launcher:bootstrap:bundle -- --manifest <signed-channel-manifest> --launcher <MagicPot.Launcher.exe> --uninstaller <MagicPot.Uninstall.exe> --channel <stable|beta|nightly> --build-id <build-id> --runtime-id <runtime-id> --launcher-version <semver> --uninstaller-version <semver> --private-key <ed25519-pkcs8.pem> --key-id <key-id> --expected-public-key-base64 <raw-32-byte-public-key-base64> --output-dir <launcher-bundle-dir>
```

The release workflow intentionally uses the same Ed25519 private key, key ID, and public key for this descriptor and the selected channel manifest. The final colocated launcher bundle is exactly the Bootstrap executable, launcher, uninstaller, descriptor, and signature; app/runtime ZIPs, signed/unsigned manifests, and release index remain in the release artifact directory. The disabled compiled trust implementation remains the default unless release inputs explicitly enable it.

This is a fresh launcher-store installer, not an NSIS migration tool. It does not automatically discover, move, import, or remove old NSIS application roots. External user-data roots are preserved because BootstrapInstallerCore owns and deletes only its selected install root. Any legacy source label is informational metadata and must not be described as migration.
