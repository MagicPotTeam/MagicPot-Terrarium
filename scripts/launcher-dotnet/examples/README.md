# Launcher release-tool examples

> **DO NOT USE these files as-is.** They contain `example.invalid`/test identities, placeholder repository URLs, timestamps, and paths. Copy them outside this directory and replace every placeholder with release-specific values. CI deliberately does not execute these examples.

The JSON files intentionally contain only fields accepted by the strict CLI schemas; documentation markers are kept here because unknown JSON fields are rejected. In `release-descriptor.example.json`, both `archive` values must be absolute paths on the machine running the manifest builder. `C:\ABSOLUTE\...` is only a Windows placeholder and cannot be portable across machines. Artifact and release-notes URLs must remain under a repository allowed by `release-source.example.json`; the examples consistently use `https://github.com/example/repository`.

## 1. Pack the app artifact

After replacing placeholders and preparing an app payload containing `MagicPot.exe`:

```powershell
npm run launcher:artifact:pack -- --kind app --input-dir C:\release\app --output C:\release\magicpot-app.zip --identity C:\release\app-identity.json
```

## 2. Pack the runtime artifact

After preparing a runtime payload containing the declared Python and ComfyUI entrypoints:

```powershell
npm run launcher:artifact:pack -- --kind runtime --input-dir C:\release\runtime --output C:\release\magicpot-runtime.zip --identity C:\release\runtime-identity.json
```

The app and runtime identities must use the same `runtimeId`. Output ZIP paths must not already exist. For the integrated signed-release command, pass the full unpacked application directory as `--app-dir`, the runtime directory nested inside it as `--runtime-dir`, and that exact nested location as `--runtime-relative-path`. The packager copies the app into a secure temporary staging tree while excluding that runtime subtree; it never mutates the original build and never embeds the runtime in the app ZIP.

Runtime entrypoints are relative to the runtime artifact root, not the application root. The Python default is `python.exe`; `--comfyui-entrypoint` is required because layouts where ComfyUI remains outside a Python-only runtime cannot truthfully declare a runtime-local ComfyUI entrypoint. If the runtime root is `ComfyUI_windows_portable`, use explicit values such as `--python-entrypoint python_embeded/python.exe --comfyui-entrypoint ComfyUI/main.py`.

## 3. Build an unsigned channel manifest

Replace the descriptor archive paths with the actual absolute ZIP paths and make its GitHub URLs match the source configuration:

```powershell
npm run launcher:manifest:build -- --descriptor C:\release\release-descriptor.json --output C:\release\stable.unsigned.json --channel stable --generated-at 2026-01-02T04:00:00Z --release-source-config C:\release\release-source.json
```

## 4. Sign offline

Keep the Ed25519 PKCS#8 private key on the offline signing machine. The output path must not already exist:

```powershell
npm run launcher:manifest:sign -- --input C:\release\stable.unsigned.json --output C:\release\stable.json --private-key D:\offline\release-ed25519-private.pem --key-id release-test --expected-public-key-base64 REPLACE_WITH_32_BYTE_ED25519_PUBLIC_KEY_BASE64
```

The expected public key is the canonical base64 encoding of the raw 32-byte Ed25519 public key. Never commit the private key.

## 5. Configure the launcher public key

The launcher update configuration consumed by `scripts/launcher-dotnet/generate-update-config.mjs` must use the same key ID/public key and trusted source as the signed manifest, for example:

```json
{
  "schema": 1,
  "launcherVersion": "0.0.0-test",
  "channels": {
    "stable": "https://github.com/example/repository/releases/download/v0.0.0-test/stable.json",
    "beta": "https://github.com/example/repository/releases/download/v0.0.0-test/beta.json",
    "nightly": "https://github.com/example/repository/releases/download/v0.0.0-test/nightly.json"
  },
  "trustedSources": [
    {
      "origin": "https://github.com",
      "repoPathPrefix": "/example/repository"
    }
  ],
  "publicKeys": {
    "release-test": "REPLACE_WITH_32_BYTE_ED25519_PUBLIC_KEY_BASE64"
  },
  "bootstrapPublicKeys": {
    "release-test": "REPLACE_WITH_32_BYTE_ED25519_PUBLIC_KEY_BASE64"
  }
}
```

This inline configuration is illustrative and is also not directly runnable until all test values are replaced.
