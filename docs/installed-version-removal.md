# Installed-version inventory and removal

The desktop app inventories launcher installations from `apps/<buildId>/app-installed.json` and `runtimes/<runtimeId>/runtime-installed.json`. JSON reads are size-bounded, directory and file links are rejected, and resolved paths must remain contained by the launcher root. Node.js can identify symbolic links but cannot reliably classify every Windows reparse-point type; the native launcher remains the authority for mutations.

Inventory size values are declarations from signed/validated installed manifests. They are not live filesystem usage measurements and may be `null`. Corrupt or untrusted installation directories are omitted and reported through `inventoryIssues`. If health history is absent, a version is `unknown`; active and previous build IDs are always non-removable.

## Removal safety status

Installed-version removal is currently disabled (`capabilities.removeVersion = false`). The launcher command handler returns a correlated failed result because the existing launch lease is not an exclusive installed-tree/process lease and therefore cannot safely prove that executables and manifests are unused. No recursive path deletion is performed.

Runtime cleanup is deliberately deferred. It must not be enabled until the launcher can prove zero references across every valid app manifest and conservatively treat corrupt or unknown app directories as potential references, while holding exclusive leases and using the retention-safe tree deletion implementation.
