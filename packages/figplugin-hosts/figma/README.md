# MagicPot Figma local development artifact source

This directory contains native Figma plugin source, not an installed, paired, published, or
production-ready plugin. It does not implement a HostAdapter, desktop pairing, dialogue, rembg,
or document writes. The broader host integration remains incomplete.

## Resolve the template before importing

1. Use Figma's development-plugin creation flow to obtain a plugin ID assigned to **your own**
   plugin. You must use your assigned ID; do not invent an ID or borrow another plugin's ID.
2. In a separate local development staging directory, place `code.js` and `ui.html` alongside
   a copy of `manifest.template.json` named `manifest.json`. Replace
   `__FIGMA_ASSIGNED_PLUGIN_ID__` with that user-provided assigned ID. The template itself is
   deliberately not an importable manifest. Keep the source template unresolved.
3. In Figma desktop, use **Plugins > Development > Import plugin from manifest** and select
   the resolved `manifest.json`. Run MagicPot in a Figma design document.

The parent package builder/installer is developed separately and must require a valid,
user-supplied assigned ID before producing an importable artifact. No builder, installer,
credentials, generated IDs, or user-data-directory writes are provided here.

## Read-only boundary

Opening the plugin only shows its UI. **Read selection** sends the sole read command and reads
only `figma.currentPage.selection` at that moment, visiting at most 100 selected nodes without
recursion. The reply is `{ kind: 'selection-context', protocol: 1, host: 'figma', nodes,
truncated }`. Each node contains only `id`, `type`, `name`, `locked`, and finite numeric geometry
(`x`, `y`, `width`, `height`, `rotation`, when available). All labels are limited to 120 UTF-16
code units; control and directional-formatting characters are stripped. No full text, fills,
images, plugin user data, child nodes, or other pages are accessed. Names can themselves contain
sensitive information; the UI keeps this snapshot local and does not persist it.

**Close** closes the plugin. All other commands, extra payload fields, and oversized command
types are ignored. An unavailable/stale selection produces the same fixed empty context as no
selection, never raw host exception details. The UI displays plain JSON through `textContent`.

The manifest uses API `1.0.0`, `dynamic-page` document access, and `allowedDomains: ["none"]`.
No network route, including a desktop/loopback bridge route, is enabled. This is intentional:
a future approved, gated extension must separately address any HostAdapter and pairing flow.
The visible **Desktop not paired** / **Capabilities disabled** notices are not a dialogue UI.

## Verification boundary

From the repository root with Node 24:

```sh
node --test scripts/figplugin-host-artifacts.test.mjs
```

These tests execute the source with VM host/DOM fixtures only; they do not validate actual Figma
installation, UI rendering, permissions enforcement, or desktop interoperability. Native-host
manual validation is still required: import with your assigned ID, open without reading, click
with empty/small/over-100 selections (including groups and text), verify the bounded local
snapshot and disabled capabilities, and close. Confirm no document edits occur. Do not treat
fixture tests as completion of the larger integration goal.

Manifest reference: https://developers.figma.com/docs/plugins/manifest/
