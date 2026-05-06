# Windows Runtime Dependencies

The Windows ComfyUI runtime requires the Microsoft Visual C++ Redistributable.

MagicPot does not distribute `VC_redist.x64.exe` in the open source candidate repository. Users or installers should obtain the redistributable from Microsoft's official page:

https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist

Redistribution is governed by the Microsoft Software License Terms for Visual Studio and the Visual C++ Redistributable. Keep this licensing constraint in mind before bundling the installer in any public source or release artifact.

Maintainer embedded Windows packaging may look for `vendor/windows/VC_redist.x64.exe` when building a bundled runtime installer. Do not commit that Microsoft binary to the public source candidate; provide it only in authorized maintainer build environments or ask users to install it from Microsoft.
