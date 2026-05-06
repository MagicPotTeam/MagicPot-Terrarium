# ComfyUI Source Submodules

This directory tracks ComfyUI and the bundled custom nodes as Git submodules.

Tracked here:

- `ComfyUI`
- `comfyui_data/custom_nodes/*` source repositories

Not tracked here:

- `python_embeded`
- model files
- generated input, output, workflow, cache, and user data
- `ComfyUI_windows_portable`
- Microsoft `VC_redist.x64.exe`

Initialize the source repositories after cloning:

```bash
git submodule update --init --recursive
```

For embedded package preparation, run:

```bash
npm run prepare:embedded-sources
```

The embedded preparation scripts use these submodule checkouts as source input and keep
runtime data out of Git.
