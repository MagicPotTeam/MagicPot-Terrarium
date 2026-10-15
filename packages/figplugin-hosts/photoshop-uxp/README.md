# MagicPot Photoshop UXP local development artifact source

This directory contains native Photoshop UXP panel source, not an installed, paired, published,
or production-ready plugin. There is no HostAdapter, desktop pairing, dialogue, rembg, or document
write capability. The broader host integration remains incomplete. No `.ccx` is provided.

## Resolve the template before importing

1. Supply your own Photoshop UXP plugin identifier from your separately managed developer
   project. Do not invent an assigned identity or reuse someone else's plugin identity.
2. The parent package builder/installer is developed separately. It must resolve the supplied
   identifier into a real `manifest.json`, replacing `__PHOTOSHOP_PLUGIN_ID__`, and stage it with
   `index.html` and `main.js`. For local development the same three files can be staged manually
   in a separate directory. Keep `manifest.template.json` unresolved in this source directory;
   it is not the manifest to import directly.
3. Use Photoshop **23.3.0 or newer** and the Adobe **UXP Developer Tool**. Enable developer mode
   in Photoshop's Plugins preferences if required by your installation, then restart Photoshop.
   In UXP Developer Tool, add the plugin by selecting the resolved `manifest.json`, load it,
   and open its MagicPot panel in Photoshop's Plugins menu.

No build script, installer, credentials, generated IDs, or user-data-directory writes are
included here. This is a development import workflow, not a distribution/install claim.

## Read-only boundary

Opening the panel only registers the **Read selection** button; it does not read a document.
Clicking reads `require('photoshop').app.activeDocument.activeLayers` at that moment and visits
at most 100 active layers without recursion. Plain JSON is displayed using `textContent` with
`kind: 'selection-context'`, `protocol: 1`, `host: 'photoshop'`, `nodes`, and `truncated`.
Each node contains only a safe integer `id` (otherwise `null`), `kind`, `name`, and `locked`.
Labels are limited to 120 UTF-16 code units with control and directional-formatting characters
stripped. `locked` reflects Photoshop's `Layer.allLocked` boolean, not individual partial-lock
flags. Geometry is deliberately omitted; no unit conversions, pixel/image data, text contents,
document metadata, descendants, or other documents are accessed. No document, or an unavailable
selection, gives a fixed empty context without host error details. Names can themselves contain
sensitive information; snapshots stay local and are not persisted.

Manifest version 5 requires only `localFileSystem: 'plugin'`; the code does not use filesystem
APIs. There is no network permission or network/desktop bridge route, no modal execution, and
no host modifications. The absent bridge is deliberate: any future HostAdapter/pairing route
requires a separately approved, gated extension. The **Desktop not paired** and **Capabilities
disabled** notices do not implement or simulate dialogue.

## Verification boundary

From the repository root with Node 22:

```sh
node --test scripts/figplugin-host-artifacts.test.mjs
```

These tests run actual source against VM host/DOM fixtures only, not Photoshop or UXP Developer
Tool. Native-host import, UI rendering, permissions enforcement, and real API compatibility still
need manual validation. Check that opening reads nothing, then click with no document and with
empty/small/over-100 active-layer selections (including groups/text and unusual names); verify
bounded plain output, disabled capabilities, and unchanged documents. No desktop interoperability
or completion of the larger integration goal is established by the fixture tests.

References:

- https://developer.adobe.com/photoshop/uxp/2022/guides/uxp_guide/uxp-misc/manifest-v5/
- https://developer.adobe.com/photoshop/uxp/2022/ps_reference/classes/document/
- https://developer.adobe.com/photoshop/uxp/2022/ps_reference/classes/layer/
