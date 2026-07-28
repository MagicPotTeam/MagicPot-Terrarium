# MagicPot .NET launcher

Windows x64 的 .NET 8 launcher。默认编译配置为 `Disabled`，不会读取示例配置，也不会在运行时读取更新配置。

## Production release integration

The release tooling can optionally generate compiled bootstrap trust, publish the Bootstrap/Launcher/Uninstall executables, and assemble a signed colocated bootstrap bundle. Schema 1 binds deterministic relative filenames (`MagicPot.Launcher.exe` and `MagicPot.Uninstall.exe`) in `MagicPot.Bootstrap.json`; URL and caller-supplied payload-path modes are rejected. Integration remains opt-in and fail-closed, so ordinary builds continue using the disabled compiled default.

The bootstrap installs a new launcher-owned app/runtime store and preserves external user-data roots by never deleting them. It does not discover, move, convert, or automatically migrate an existing NSIS installation. `--legacy-source-label` is informational metadata only.

## 本地命令

从仓库根目录运行：

```sh
npm run launcher:config:test
npm run launcher:config:check
npm run launcher:build
npm run launcher:test
npm run launcher:publish
npm run launcher:tools:publish
npm run launcher:safe-file-ops:test
```

Windows production release tools require `MagicPot.SafeFileOps.exe` for all temporary/output cleanup. Publish it to `dist/launcher-tools/win-x64` or set `MAGICPOT_SAFE_FILE_OPS` to an absolute executable path. If unavailable (including non-Windows/offline cross-platform signing), publication fails closed and preserves output/temp for quarantine. The helper is a CI/release build tool only and is never included in the Launcher user artifact.

SafeFileOps 在 inspect/delete 的整个目标操作期间固定从卷根到目标父目录的每一级目录句柄。目录句柄不共享 delete，并拒绝 reparse point、非目录、canonical 路径不一致、跨卷或 root 外目标，因此 root/中间目录不能在检查与删除之间被 rename/replacement。每个固定目录还必须通过 `GetFileInformationByHandleEx(FileCaseSensitiveInfo)` 明确确认不是 case-sensitive；查询失败或任一级启用 case-sensitive 都会 fail closed，只有全部确认后才进行 `OrdinalIgnoreCase` containment，且目标最终父目录会再次确认属于已固定且 case-insensitive 的 chain。目标文件仍以 `OPEN_REPARSE_POINT` 打开，并且其最终父目录必须与固定父目录完全一致。Windows 自测包含多层正常路径、root 外路径、symlink/junction 中间目录、case-sensitive `Owned`/`owned` sibling 绕过、root/中间目录 rename 竞争和 100 次目标 replacement 竞争；case-sensitive 功能在权限或文件系统不支持时明确 skip。使用 `dotnet build ... -warnaserror` 构建 Core 与 SelfTest 后运行 `MagicPot.SafeFileOps.SelfTest`。

`build`、`test`、`publish` 要求本机已有 .NET 8 SDK。runner 只执行 `dotnet --list-sdks` 并明确失败；它不会安装软件、联网下载 SDK 或请求 UAC。发布目标是 `win-x64`、Release、自包含单文件，输出到 `dist/launcher-dotnet/win-x64`，该固定目录会在发布前清空。

## 正式更新配置

正式配置仅在构建时读取。设置绝对路径和与 JSON 完全一致的 SemVer：

```powershell
$env:MAGICPOT_LAUNCHER_UPDATE_CONFIG = 'C:\secure\launcher-update-config.local.json'
$env:MAGICPOT_LAUNCHER_VERSION = '1.2.3'
npm run launcher:publish
```

未设置 `MAGICPOT_LAUNCHER_UPDATE_CONFIG` 时无需配置，构建使用源码中的 disabled 实现。相对路径、缺失文件、unknown 字段、非 HTTPS URL、不可信 release 路径和错误公钥均被拒绝。生成源码位于项目 `obj/launcher-config.g.cs`，由 MSBuild 属性替换默认实现。

`launcher-update-config.example.json` 只包含 `example.invalid` 和 32 个零字节的明显测试公钥（DO NOT USE），runner 从不默认读取它。

## 信任边界

配置只能包含三个 channel manifest URL、受信任 HTTPS origin/GitHub repository path prefix、launcher 版本和 Ed25519 **公钥**。channel URL 必须位于某受信任仓库的 `/releases/download/` 或 `/releases/tag/` 路径下。配置 schema 严格拒绝额外字段，并递归拒绝字段名中包含 `private`、`secret`、`seed` 或 `token` 的内容，以降低私钥误入风险。

私钥、签名 seed、访问 token 和其他 secret 永远不得写入配置、生成源码或仓库。构建输出仅嵌入公开 URL、受信任来源、版本和公钥字节。

## 离线签名 channel manifest

Channel manifest 使用离线 Ed25519 PKCS#8 PEM 私钥签名。未签名 JSON 必须且只能包含 `schema`、`channel`、`generatedAt` 和 `releases`；签名器会先用应用共用的协议解析器验证内容，并拒绝任意层级的重复 JSON key。

```text
npm run launcher:manifest:sign -- \
  --input <absolute-unsigned-json-path> \
  --output <absolute-new-signed-json-path> \
  --private-key <absolute-pkcs8-pem-path> \
  --key-id <trusted-key-id> \
  [--expected-public-key-base64 <32-byte-raw-public-key-base64>]
```

输出路径必须不存在；签名器绝不覆盖现有文件。发布使用同目录临时文件和原子 no-replace hard link，随后从已打开的输出文件描述符重新解析并验证签名。若发布后的自检失败，不会按路径自动删除文件，操作者必须人工隔离并调查该输出。NTFS 环境需支持 Node.js `linkSync`。

正式签名建议始终提供 `--expected-public-key-base64`，以发现误选离线私钥。成功日志只包含 key ID、公钥 SHA-256 指纹的前 16 个十六进制字符和输出文件名，不输出私钥材料或私钥路径。

私钥必须保持离线，优先使用硬件保护存储或受访问控制的 secret manager。不得将私钥放入仓库、GitHub Actions、CI artifact、release artifact、日志或构建输出。该工具不生成私钥，也不属于 CI 发布流程。

## 公钥轮换

Manifest 只有一个签名，因此轮换依靠 Launcher 信任集合的重叠期，而不是双签名：

1. 先将旧、新公钥同时加入 Launcher，并发布该 Launcher。
2. 等待新版 Launcher 达到足够部署比例，再使用新 key ID 签名 manifest。
3. 只要 release 仍可能面向旧 Launcher，就继续信任旧公钥。
4. 仅当 `minimumLauncherVersion` 已排除所有不信任新公钥的 Launcher 后，才撤销或删除旧公钥。

示例和仓库 fixture 不得包含真实 release URL 或生产公钥。

## Windows current-user install integration and uninstaller

`WindowsInstallIntegration` writes only HKCU uninstall metadata and current-user Start Menu/Desktop links. The stable product id is suffixed with the install id short form, while full `OperationId` and `InstallId` values gate rollback. Inspection treats all-absent and matching partial state as recoverable `Missing`; any mismatching existing value/link is `Conflict`. Apply never overwrites conflicts and publishes links through a temporary `.partial` path.

`MagicPot.Uninstall` is a `net8.0-windows`/`win-x64` single-file executable. Phase 1 copies and hash/size verifies itself outside the install root, then starts detached phase 2. Phase 2 waits boundedly for its parent, rebuilds and revalidates `UninstallCapability`, removes only matching integration, and deletes the owned tree while preserving external user data. Locked launcher files produce an incomplete-cleanup error suitable for retry. Temp cleanup is scheduled with `MoveFileEx(..., DELAY_UNTIL_REBOOT)`; failure is non-destructive.

SelfTests inject fake adapters and do not instantiate or execute real registry/shortcut adapters.
