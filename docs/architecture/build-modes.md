# Build Modes

## Modes

MagicPot has two build/package modes. The mode is chosen during build and packaging; users cannot switch a packaged app between modes at runtime.

| Mode       | Description                                                                                        | Primary audience                                                       |
| ---------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pure`     | Does not bundle Python or ComfyUI. Users configure their own Python and ComfyUI paths in settings. | Developers and users who already maintain a local ComfyUI environment. |
| `embedded` | Can bundle Python and ComfyUI and use bundled defaults when paths are not configured.              | Maintainer-produced end-user packages intended to work out of the box. |

The public source candidate's default verifiable path is `pure` mode.

## Mode selection points

Mode affects two stages:

1. **Source build**: `electron-vite build --mode <pure|embedded>`. The app reads build-time environment such as `VITE_BUILD_MODE`, `VITE_PACKAGE_MODE`, and `VITE_BUILD_MODE_NAME`.
2. **Application packaging**: `PACKAGE_MODE=<pure|embedded>` controls `config/electron/electron-builder.config.js` packaging behavior and output layout. If `PACKAGE_MODE` is not set, packaging defaults to `pure`.

## Common scripts

| Operation            | Script(s)                                                                                               | Notes                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Install dependencies | `npm ci`                                                                                                | Recommended for new machines and CI because it follows `package-lock.json`. |
| Default development  | `npm run dev`                                                                                           | README defines this as the default `pure` development path.                 |
| Explicit development | `npm run dev:pure`, `npm run dev:embedded`                                                              | Embedded development sets embedded build/package mode environment values.   |
| Preview built output | `npm run start:pure`, `npm run start:embedded`                                                          | Runs electron-vite preview for the chosen mode.                             |
| Build source         | `npm run build:pure`, `npm run build:embedded`                                                          | Both run type checks before building.                                       |
| Package by platform  | `npm run package:win`, `npm run package:mac`, `npm run package:linux`, `npm run package:all`            | Use `PACKAGE_MODE` to select package mode; default is `pure`.               |
| Release package      | `npm run release:pure`, `npm run release:embedded`, `npm run release:embedded:win`                      | Embedded release is currently Windows-oriented in package scripts.          |
| Quality checks       | `npm run check:text-encoding`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run smoke:startup` | README lists these as common validation commands.                           |

## Embedded preparation scripts

Embedded packaging uses `.staging/embedded` as a staging directory. The public source candidate does not include the required runtime data by default.

| Script                                     | Purpose                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `npm run prepare:embedded-sources`         | Prepare embedded ComfyUI sources.                                                    |
| `npm run prepare:embedded-sources:dry-run` | Show source preparation actions without applying them.                               |
| `npm run prepare:embedded-staging`         | Clone/copy ComfyUI source and custom nodes into `.staging/embedded`.                 |
| `npm run prepare:embedded-python`          | Prepare Windows embedded Python, install dependencies, and run a ComfyUI quick test. |
| `npm run prepare:embedded-python:dry-run`  | Inspect embedded Python preparation without performing it.                           |
| `npm run prepare:embedded`                 | Run sources, staging, and Python preparation in sequence.                            |

The README states that public candidates do not include embedded ComfyUI runtime, ComfyUI submodules, local runtime data, or `vendor/windows/VC_redist.x64.exe`. `release:embedded` is for maintainer workspaces or local environments that have prepared the required runtime inputs.

## Runtime path conventions

Windows embedded packages follow the README path convention:

```text
ComfyUI_windows_portable/python_embeded/python.exe
ComfyUI_windows_portable/ComfyUI
```

macOS embedded packaging still expects a Python directory shaped like:

```text
ComfyUI_windows_portable/python_embedded_macos
```

The repository does not currently auto-generate the macOS embedded Python directory.

## Release assets and updates

The README describes a dual-package release model for GitHub Releases:

| Asset                                   | Purpose                                               | Updated by in-app updater |
| --------------------------------------- | ----------------------------------------------------- | ------------------------- |
| `magicpot-<version>-win.7z`             | First-time full package with bundled Windows runtime. | No                        |
| `magicpot-<version>-setup.exe`          | App-body installer used by `electron-updater`.        | Yes                       |
| `magicpot-<version>-setup.exe.blockmap` | Differential metadata for the app-body installer.     | Yes                       |
| `latest.yml`                            | Update feed read by packaged builds.                  | Yes                       |

The app-body updater does not update, delete, or overwrite embedded runtime directories such as `ComfyUI_windows_portable`. If the embedded runtime must be refreshed, maintainers publish a new embedded `.7z` and users replace or reinstall the runtime explicitly.

## User data location

Default user data is stored outside the app installation directory under the OS app-data location. `MAGICPOT_USER_DATA_DIR` can override this explicitly. This protects settings, chat records, cache, QApps, skills, and target schemes from app-body installer updates.

## Maintainer-only release workflows

GitHub release workflows can require signing, upload, Aliyun OSS publishing, and Discord notification credentials. Public forks and source checkouts can build locally but should not expect those workflows to publish without maintainer-provided secrets and variables.
