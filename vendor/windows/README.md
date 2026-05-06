# Windows Runtime Dependencies

The Windows ComfyUI runtime requires the Microsoft Visual C++ Redistributable.

MagicPot does not distribute `VC_redist.x64.exe` in the open source repository or public release artifacts. Users or installers should obtain the redistributable from Microsoft's official page:

https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist

Redistribution is governed by the Microsoft Software License Terms for Visual Studio and the Visual C++ Redistributable. Keep this licensing constraint in mind before bundling the installer in any public source or release artifact.

Do not commit or bundle that Microsoft binary in public source or release artifacts. The application should check whether the runtime is already installed, prompt users to install it, or direct them to Microsoft's official download page.

The Windows `pure` NSIS installer includes an optional checkbox that downloads `VC_redist.x64.exe` from Microsoft and runs it during installation. This keeps the Microsoft binary out of Git and public artifacts while still giving Windows users a one-step setup path when they need local ComfyUI support.
