# MagicPot Photoshop UXP local development artifact source

There are two distinct artifacts. Neither source directory is an installed plugin, and
`npm run dev` starts MagicPot, not Photoshop or the UXP Developer Tool.

| Source                                 | Mode         | Boundary                                                                                                                                                             |
| -------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html` + `main.js`               | Offline v1   | Read-only selection metadata; no network, pairing or document writes.                                                                                                |
| `bridge/index.html` + `bridge/main.js` | Connected v2 | Desktop pairing, approved plans, supported native commands, visual evidence and task-property recovery. Requires a prepared manifest with the exact loopback origin. |

The connected source is no longer the old read-only placeholder. It still does not authorize
itself: model submission and native document writes require separate MagicPot desktop approval.
Supported operations are layer name, visibility, opacity and text content; this is not full
resource/layout editing or a full PSD backup. Validate the required workflows in your host environment;
source presence alone is not production acceptance.

The unresolved `manifest.template.json` retains `__PHOTOSHOP_PLUGIN_ID__`; import the
prepared `manifest.json`, not this template. No `.ccx` is provided.

## Prepare a development plugin

Use `scripts/prepare-figplugin-host.mjs` from the repository root. Supply your project's own
Photoshop plugin identifier and signing metadata; do not reuse another publisher's identity.
The six required flags are `--host photoshop`, `--plugin-id`, `--publisher-id`, `--key-id`,
`--issued-at` (UTC ISO timestamp), and `--output` (a new absolute directory with an existing parent).

Omitting `--bridge-origin` deliberately selects offline v1. For the connected artifact, provide
`--bridge-origin http://127.0.0.1:PORT` matching the configured MagicPot bridge. Only this exact
origin is added to the native network permissions. No wildcard, alternative Provider URL or
credential is embedded. The builder produces `manifest.json`, `index.html`, `main.js` and an
unsigned `package.template.json`; it does not install the plugin or grant publisher trust.
Existing output directories are never overwritten. The separately signed MagicPot package and
native artifact must come from the same prepared bytes.

## Load normally, not as a standalone script

Use Photoshop 23.3 or newer and Adobe UXP Developer Tool. Add the resolved `manifest.json`,
load the plugin and open its MagicPot panel. Enabling Adobe developer mode changes local
settings and may request elevation: do it explicitly, not through a silent startup workaround.
No application-wide developer settings are written by this repository's preparation command.

A standalone `.psjs` script can exercise some real Photoshop APIs, but its permissions are not
the same as a loaded plugin. In the verified Photoshop 27.5 environment, scripts cannot use
Network. A script-based host fixture must never be reported as connected-plugin acceptance.

## Diagnose connectivity before pairing

In the connected panel, click **检查桌面连接 / Check desktop connection**. Opening the panel
does not send this request automatically. The check sends only `{protocol, nonce}` to the
prepared loopback origin, without reading a document, consuming a pairing ticket, invoking a
model or creating a session. It distinguishes a bounded successful echo, native permission
refusal, unavailable service, incompatible response, timeout and cancellation.

The Bridge listener normally starts when MagicPot creates a pairing ticket. A failed check
before the desktop pairing service is started is not evidence of a broken model. A successful
check is only a reachability observation: it is not server authentication, Provider readiness,
pairing or write permission. It does not renew any existing approval or session. Checks stop
after five seconds and do not retry automatically; closing/cancelling ignores late responses.

After a successful check, use a fresh desktop pairing ticket and follow the normal context,
model-send approval and separate document-write approval flow. Update both desktop source and
the prepared native plugin when the contract changes. Restarting MagicPot does not replace an
old plugin copy inside Photoshop.

## Verification

```sh
node scripts/build-figplugin-bridge-readiness.mjs --check
node scripts/build-figplugin-plan-preview.mjs --check
node --test scripts/figplugin-host-bridge.test.mjs scripts/prepare-figplugin-host.test.mjs
```

These automated scripts use fixtures. The separate real-host acceptance records explicitly
state whether the native API, network, desktop approval UI and Provider were real. Tests must
use owned documents and preserve unrelated user files and settings.

Official references:

- https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/installation
- https://developer.adobe.com/photoshop/uxp/2022/scripting/how-it-works/
- https://developer.adobe.com/photoshop/uxp/2022/guides/uxp-guide/uxp-misc/manifest-v5/
