#!/usr/bin/env node
import { access, mkdir, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { main as generate } from './generate-update-config.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const launcherRoot = path.join(repo, 'packages', 'launcher-dotnet')
const project = path.join(launcherRoot, 'src', 'MagicPot.Launcher', 'MagicPot.Launcher.csproj')
const bootstrapProject = path.join(launcherRoot, 'src', 'MagicPot.Bootstrap', 'MagicPot.Bootstrap.csproj')
const solution = path.join(launcherRoot, 'MagicPot.Launcher.sln')
const generated = path.join(launcherRoot, 'src', 'MagicPot.Launcher', 'obj', 'launcher-config.g.cs')
const generatedBootstrapTrust = path.join(launcherRoot, 'src', 'MagicPot.Launcher', 'obj', 'bootstrap-trust.g.cs')
const safeFileOpsProject = path.join(launcherRoot, 'tools', 'MagicPot.SafeFileOps', 'MagicPot.SafeFileOps.csproj')
const version = process.env.MAGICPOT_LAUNCHER_VERSION || '0.0.0'
function die(message) { console.error(message); process.exit(1) }
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: repo, env, stdio: 'inherit', shell: false })
  if (result.error) die(`无法启动 ${command} / Failed to start ${command}: ${result.error.message}`)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
function dotnet() {
  const command = process.env.DOTNET_HOST_PATH || 'dotnet'
  const probe = spawnSync(command, ['--list-sdks'], { encoding: 'utf8', shell: false })
  if (probe.error) die('未找到 .NET SDK。需要本机已安装的 .NET 8 SDK；本脚本不会安装、联网或请求管理员权限。\n.NET SDK not found. Install .NET 8 SDK locally; this script never installs, downloads, or requests elevation.')
  if (probe.status !== 0 || !probe.stdout.split(/\r?\n/).some(line => /^8\.\d+\.\d+\s/.test(line))) die('未检测到 .NET 8 SDK。请先在本机安装 8.x SDK。\n.NET 8 SDK was not detected. Install an 8.x SDK first.')
  return command
}
async function exists(file) { try { await access(file, constants.R_OK); return true } catch { return false } }
async function prepareConfig() {
  const input = process.env.MAGICPOT_LAUNCHER_UPDATE_CONFIG
  if (input) {
    if (!path.isAbsolute(input)) die('MAGICPOT_LAUNCHER_UPDATE_CONFIG 必须是绝对路径 / must be an absolute path.')
    if (!(await exists(input))) die('更新配置文件不存在 / update configuration file does not exist.')
    await generate(['--input', input, '--output', generated, '--launcher-version', version])
    return [`-p:LauncherGeneratedUpdateConfig=${generated}`]
  }
  return []
}
async function prepareBootstrapTrust() {
  const descriptorKey = process.env.MAGICPOT_BOOTSTRAP_DESCRIPTOR_PUBLIC_KEY_BASE64
  const keyId = process.env.MAGICPOT_BOOTSTRAP_KEY_ID
  const manifestKey = process.env.MAGICPOT_BOOTSTRAP_MANIFEST_PUBLIC_KEY_BASE64
  if (![descriptorKey, keyId, manifestKey].some(Boolean)) return []
  if (![descriptorKey, keyId, manifestKey].every(Boolean)) die('Bootstrap trust requires one key ID and descriptor and manifest public keys.')
  const { main: generateTrust } = await import('./generate-bootstrap-trust-config.mjs')
  await generateTrust(['--output', generatedBootstrapTrust, '--key-id', keyId, '--descriptor-public-key-base64', descriptorKey, '--manifest-public-key-base64', manifestKey])
  return [`-p:BootstrapGeneratedTrustConfig=${generatedBootstrapTrust}`]
}
async function main() {
  const command = process.argv[2]
  if (!['check-config', 'build', 'test', 'publish', 'publish-bootstrap', 'publish-tools'].includes(command)) die('usage: run.mjs <check-config|build|test|publish|publish-bootstrap|publish-tools>')
  const props = [...await prepareConfig(), ...await prepareBootstrapTrust()]
  if (command === 'publish-bootstrap' && !props.some(value => value.startsWith('-p:BootstrapGeneratedTrustConfig='))) die('publish-bootstrap requires explicit bootstrap trust configuration.')
  if (command === 'publish-tools') {
    const dn = dotnet(), output = path.join(repo, 'dist', 'launcher-tools', 'win-x64')
    await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true })
    run(dn, ['publish', safeFileOpsProject, '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=true', '-o', output])
    return
  }
  if (command === 'check-config') { console.log(process.env.MAGICPOT_LAUNCHER_UPDATE_CONFIG ? 'launcher update configuration: valid' : 'launcher update configuration: disabled'); return }
  const dn = dotnet()
  run(dn, ['restore', solution, '-r', 'win-x64', ...props])
  if (command === 'build') run(dn, ['build', solution, '-c', 'Release', '-r', 'win-x64', '--no-restore', ...props])
  if (command === 'test') {
    const fake = path.join(launcherRoot, 'tests', 'MagicPot.Launcher.FakeApp', 'MagicPot.Launcher.FakeApp.csproj')
    run(dn, ['build', fake, '-c', 'Release', '-r', 'win-x64', '--no-restore'])
    const env = { ...process.env, MAGICPOT_FAKE_APP_DIR: path.join(launcherRoot, 'tests', 'MagicPot.Launcher.FakeApp', 'bin', 'Release', 'net8.0-windows', 'win-x64') }
    const tests = ['MagicPot.Launcher.SelfTest', 'MagicPot.Launcher.ArtifactDownloader.SelfTest', 'MagicPot.Launcher.ArtifactPreparer.SelfTest', 'MagicPot.Launcher.AutoUpdateCoordinator.SelfTest', 'MagicPot.Launcher.ChannelManifestClient.SelfTest', 'MagicPot.Launcher.LocalSmokeActivation.SelfTest', 'MagicPot.Launcher.OfflineUpdateDecision.SelfTest', 'MagicPot.Launcher.PreparedArtifactInstaller.SelfTest', 'MagicPot.Launcher.UpdateCheck.SelfTest', 'MagicPot.Launcher.IntegrationHarness']
    for (const name of tests) run(dn, ['run', '--project', path.join(launcherRoot, 'tests', name, `${name}.csproj`), '-c', 'Release', '-r', 'win-x64', '--no-restore', ...props], env)
  }
  if (command === 'publish' || command === 'publish-bootstrap') {
    const output = path.join(repo, 'dist', command === 'publish' ? 'launcher-dotnet' : 'bootstrap-dotnet', 'win-x64')
    await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true })
    const target = command === 'publish' ? project : bootstrapProject
    run(dn, ['publish', target, '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true', '--no-restore', '-o', output, ...props])
  }
}
main().finally(() => rm(generatedBootstrapTrust, { force: true })).catch(error => die(error.message))
