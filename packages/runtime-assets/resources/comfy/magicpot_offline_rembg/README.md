# D04 opt-in offline background removal — UNWIRED

This directory is an **unwired runtime asset**, not an enabled application feature.
Nothing here edits staging, package scripts, workflows, the TS gate/runner/source,
Comfy installations or application startup. Discovery exposes exactly
`MagicPotOfflineInspyrenetV1` and `MagicPotSaveRgba8V1`. Import, schema lookup,
namespace import and construction do not load a model, inspect a checkpoint,
probe devices, install dependencies or read environment/home configuration.

## Trusted owned-launch contract

Only a trusted launcher in the **same owned Python process and same imported
package instance** may call:

```python
from magicpot_offline_rembg import OwnedLaunchPolicy, install_trusted_owned_launch_policy

install_trusted_owned_launch_policy(OwnedLaunchPolicy(
    managed_checkpoint_root=managed_absolute_directory,
    checkpoint_filename=exact_absolute_filename,
    checkpoint_bytes=exact_positive_integer_byte_count,
    checkpoint_sha256=canonical_lowercase_sha256,
    device=explicit_device,
    owned_output_root=owned_absolute_existing_output_directory,
))
```

All six fields are mandatory; the record is frozen/slotted and exact-type checked.
The byte count excludes bool and must be 1..536870912 (512 MiB). The digest is
exactly 64 lowercase hex characters. Device is exactly `cpu` or `cuda:N`, where
N is a canonical nonnegative decimal (no leading zero except `0`). No defaults,
device discovery or CUDA availability probe. Paths are absolute; checkpoint must
be strictly inside the managed root. Dot traversal, Windows device/UNC paths,
alternate streams and reserved names are rejected. Root directories must already
exist when used. Installation performs **lexical validation only**, no stat/open,
checkpoint read, dependency import or model construction. It does not establish
ownership or validate an OS ACL. The launcher must establish those conditions.

No workflow input can supply paths, sizes, hashes, device, filename or prefix.
There is no automatic environment policy, JSON policy parser, model search,
checkpoint cache, retry, backend fallback, JIT, downloader or dependency manager.
Missing policy raises `UNAVAILABLE`. Failed installation, artifact inspection,
execution or output validation disables the process-local policy. The trusted
launcher must deliberately reinstall it; teardown can call
`disable_owned_launch_policy()`. Installation/teardown and execution must be
serialized by the launcher. Synthetic tiny checkpoint bytes are allowed through
this same explicit trusted interface **for tests**, never as a production manifest.

## File verification is not runtime attestation

`offline_loader.inspect_checkpoint_file()` is stdlib-only and returns exactly a
frozen `FileVerification(file_verified, byte_count, sha256)`. It is **only file
verification**, never runtime identity, readiness, capability or authorization.
It checks containment, every ancestor for links/reparse points, regular-file type,
single link count, bounded exact size and SHA-256. It uses one open handle with
before/after stat and pathname identity checks. On Windows, ctime comparisons
stay within the same stat API: CPython 3.14 may report creation/change timestamps
differently for lstat/fstat. Handle ctime is still checked before/after reading.

Execution takes immutable bytes from that same verified handle and closes it.
Only then are dependencies/private model imported. Those **same bytes** are hashed
again immediately before `torch.load(BytesIO(bytes), weights_only=True,
map_location='cpu')`; the checkpoint pathname is never reopened for deserialization.
Hashing a file earlier does not grandfather a later execution. A changed pathname
after the snapshot cannot change the bytes sent to deserialization. Shape checks precede
checkpoint access. After artifact verification, image execution imports torch and checks
tensor type, dtype/layout and every sample before private model import, deserialization,
model construction or device migration. Invalid pixels cannot trigger model loading;
the artifact-first gate is retained. Direct model-loader tests may omit image preflight.

These checks assume an ordinary owned local filesystem, **not adversarial atomic
filesystem or network-volume certification**. A mapped/network volume is not
certified by accepting an absolute path. They do not defend against hostile Python,
native libraries, tensor subclasses or malicious changes inside the process.
Third-party imports/deserialization may have their own effects and resource costs;
`weights_only=True` and a hash are not a full hostile-code/side-effect guarantee.
Public failures expose stable codes without underlying exception text; local
Python tracebacks still reveal this bundle's source paths.

## Concrete execution contract

The actual lazy loader constructs bundled `InSPyReNet_SwinB(depth=64,
pretrained=False, base_size=[1024, 1024], threshold=None)`, loads the state dict
with `strict=True`, calls `eval()`, then `.to(exact_policy_device)`. No wrappers,
key rewriting or fallback checkpoint interpretation. Dependencies are torch,
numpy, cv2, kornia and timm; none are installed by this bundle. The private snapshot
never imports the `transparent_background` package, Remover, GUI, download/home
configuration, albumentations or upstream utils. Its namespaces are inert.

Input is one concrete dense floating Comfy-style `[1,H,W,3|4]` tensor, all samples
finite in [0,1], maximum dimension 4096 and at most 4194304 pixels. RGB is resized
to 1024x1024 using bilinear `align_corners=False`, then normalized with mean
(.485,.456,.406) and std (.229,.224,.225). Inference runs under `inference_mode()`;
prediction is bilinearly resampled to original dimensions. Original RGB is kept,
not multiplied by alpha. For RGBA, output alpha = prediction * existing alpha.
All input/output samples are checked, not sampled. RGBA8 uses explicit round-half-up
quantization. All-zero or all-255 alpha after quantization is rejected, including
almost-blank/almost-opaque predictions that quantize that way.

Output is the frozen stdlib `Rgba8(width,height,pixels)` value on custom socket
`MAGICPOT_RGBA8_V1`, **not a raw IMAGE tensor or MASK socket**. Sparse/meta/quantized,
complex/integer, symbolic/ragged and multi-batch inputs are unsupported. Other
nodes must not assume this custom output is a tensor. Tensor conversion and
maximum-size memory/performance have not been proven with real torch here.
Model/checkpoint allocations can greatly exceed checkpoint byte size.

The bundled model mathematics are compared as ASTs against the six local source
files, excluding documented import/device/pretraining changes and docstrings.
This is **not** a GPU/numerical proof or a claim of exact upstream Remover visual
equivalence: its preprocessing differs from this deliberately fixed adapter.

## Narrow PNG writer and owned output

`rgba8_png.encode_rgba8(Rgba8(...))` is a stdlib bytes API: exact immutable bytes,
non-bool integer dimensions, exact 4*width*height length, nonblank/nonopaque alpha,
PNG signature and only IHDR/IDAT/IEND, color type 6, depth 8, filter 0,
noninterlaced, CRCs and zlib. No PIL, color profile, EXIF, text or metadata.
Encoded size is capped at 4194304 bytes (4 MiB); valid large/noisy images can fail.

Save requires the installed owned output root. It creates exactly one
`magicpot-rgba8-<32 random lowercase hex>.png` with `O_EXCL`, no overwrite or
collision retry. It checks all directory ancestors, writes/flushes/fsyncs the same
handle and checks file identity/size. Failed-file cleanup is best effort and
only removes the file whose recorded identity matches; it never removes an
existing collision or an observed replacement. This is not a generic secure
filesystem API or hostile concurrent namespace guarantee. Crash leftovers and
root lifecycle remain launcher responsibilities.

The OUTPUT_NODE returns the usual Comfy `ui.images` locator with filename,
empty subfolder and type `output`. **Future backend exact-file binding is still
required**: the launcher must arrange the owned output root relative to its
Comfy serving contract, and the backend must validate/bind the exact created file
rather than treating a locator as a trusted path, managed publication or provenance.

## Validation and provenance

Run only the existing isolated stdlib interpreter, with HOME/TEMP/TMP explicitly
pointing at a unique private-trash `d04-offline-node-worker-*` root:

```text
C:/Python314/python.exe -I -S -B tests/comfy_offline_rembg/test_runtime.py green
```

The test script writes GREEN.txt and report.json (source/bundle raw SHA-256s) there.
Initial RED was recorded before implementation (25 missing-bundle errors).
The original expanded suite had 29 tests. The 2026-10-01 input-preflight increment
adds two tests, for 31 total (30 passed and one Windows symlink-privilege skip in the
scoped rerun). It uses actual tiny local files for verification,
actual PNG roundtrips, Windows junction/hardlink checks, and import guards plus
`sys.modules` fake torch/model for execution orchestration. The fake resize is a
representative-value protocol test, **not bilinear numerical validation**. There
is no real model instantiation, installed torch/Comfy/server import, GPU, download,
network or subprocess. Symlink creation is skipped explicitly if Windows denies
its privilege; the separate real junction test still covers reparse rejection.

`provenance.json` records all six local sources and the local distribution MIT
license, their raw hashes and adaptation descriptions. `LICENSE.inspyrenet` is the
verbatim Taehun Kim 2022 MIT text; this text-writing tool changes LF to CRLF on
Windows, disclosed separately from text identity. `LICENSE.swin`/NOTICE retain
Microsoft 2021 attribution and the original Swin header is preserved. Raw bundle
hashes reflect this workspace's bytes, not portable checkout newline normalization.
No model weights/license rights are inferred from the code license.

Remaining integration: reviewed dependency/runtime packaging, trusted launcher
policy installation, approved production checkpoint manifest/rights, OS ownership
and lifecycle, real tensor/CPU/CUDA smoke and visual review, Comfy graph/type/root
integration, backend exact-file binding and managed publication. None are enabled
or certified by this bundle.
