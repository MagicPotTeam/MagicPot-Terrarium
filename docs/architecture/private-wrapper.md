# Private Wrapper Boundary

## Scope

This document defines the public/private split principles for MagicPot. It does not describe any private implementation internals. The open repository must remain independently buildable and reviewable with empty extension registries and without private assets.

## Split of responsibilities

| Area               | Open repository                                                                                             | Private wrapper or maintainer workspace                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Core app           | Electron/React application, shared API contracts, public main services, public renderer UI, tests, docs.    | Optional product-specific integrations that consume public extension seams.                       |
| Build modes        | `pure` and `embedded` mode definitions and scripts.                                                         | Supplies any non-public embedded runtime inputs when building private/maintainer artifacts.       |
| Extensions         | Empty generated registries and typed V1 extension contracts.                                                | Populates generated registries with private provider/profile/proxy/UI hooks when needed.          |
| Secrets            | No release secrets, provider secrets, signing keys, or private credentials.                                 | CI/release environment may provide signing, upload, OSS publishing, and notification credentials. |
| Runtime assets     | Public source candidate excludes ComfyUI submodule/runtime data and Microsoft VC Redistributable installer. | Maintainer workspace may prepare permitted runtime assets and must honor third-party licenses.    |
| Release automation | Scripts are present, but public forks are not expected to publish official releases.                        | Maintainer-only workflows can publish signed/uploaded release assets.                             |

## Required open behavior

The open repository must support the default public path:

```bash
npm ci
npm run dev
npm run build:pure
```

The public README states that the default verifiable path is `pure` mode, where users configure Python and ComfyUI paths themselves. Public source candidates do not assume `.gitmodules`, ComfyUI submodules, local runtime data, or `vendor/windows/VC_redist.x64.exe` are present.

## Wrapper integration model

A private wrapper should integrate by composition rather than by hidden assumptions:

1. Start from the open workspace or a generated open candidate.
2. Populate extension registries or package-time inputs using documented V1 extension contracts.
3. Supply private runtime assets, signing credentials, upload credentials, and release metadata through the maintainer environment.
4. Run the same public build/package scripts with appropriate mode variables.
5. Keep private code and secrets outside the open repository and out of generated public artifacts unless the license/release policy explicitly allows distribution.

## Open-candidate scripts

`package.json` includes:

- `npm run create:open-candidate`
- `npm run check:open-candidate`

These scripts are part of the public/private hygiene workflow. They should ensure that an open candidate can be produced and verified without private-only files.

## Constraints for private additions

Private additions must not require open implementation files to import private modules. If a new public seam is needed, add a typed extension point or shared API contract in the open repository first.

Private additions must not place secrets in:

- renderer extension hooks,
- public docs,
- checked-in config files,
- logs visible to normal renderer UI,
- release assets that are intended for public source distribution.

Provider credentials, signing keys, and upload tokens belong in maintainer-controlled configuration or CI secrets.

## Embedded runtime and third-party licensing

The open README states that embedded release preparation may require `vendor/comfyui/ComfyUI`, `vendor/comfyui/comfyui_data/custom_nodes`, Windows embedded Python, and a VC Redistributable installation path. Public source candidates do not distribute those runtime inputs.

Maintainers who package embedded runtime assets are responsible for:

- Ensuring third-party licenses permit redistribution.
- Keeping large/generated runtime data out of public source candidates unless intentionally published.
- Preserving the app-body update policy: app updates do not overwrite the embedded runtime directory.

## Boundary checklist

Before merging an open change that supports private functionality, verify:

- The open build works with empty extension registries.
- The feature is useful or harmless without private assets.
- Any private behavior is behind a documented extension hook or package-time input.
- No private provider name, credential, endpoint, or implementation path is required for the open app to start.
- Tests and docs describe the public contract, not private internals.
