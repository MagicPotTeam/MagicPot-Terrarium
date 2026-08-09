import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const core = readFileSync(new URL('../../packages/launcher-dotnet/src/MagicPot.Launcher/BootstrapInstallerCore.cs', import.meta.url), 'utf8')
const facade = readFileSync(new URL('../../packages/launcher-dotnet/src/MagicPot.Launcher/BootstrapExecutableFacade.cs', import.meta.url), 'utf8')
const program = readFileSync(new URL('../../packages/launcher-dotnet/src/MagicPot.Bootstrap/Program.cs', import.meta.url), 'utf8')
const builder = readFileSync(new URL('./build-bootstrap-descriptor.ts', import.meta.url), 'utf8')

test('schema 1 binds safe relative colocated payload names', () => {
  assert.match(core, /Protocol\.IsSafeRelativePath\(source\)/)
  assert.match(core, /source\.Contains\('\/'\)/)
  assert.match(core, /Stable payload sourcePath must be a safe relative filename/)
  assert.doesNotMatch(core, /"url" or "sourcePath"/)
  assert.match(builder, /MagicPot\.Launcher\.exe/)
  assert.match(builder, /MagicPot\.Uninstall\.exe/)
})

test('bootstrap CLI has no payload path overrides or migration claim', () => {
  assert.doesNotMatch(program, /--launcher|--uninstaller|--legacy-root/)
  assert.match(program, /--legacy-source-label/)
  assert.doesNotMatch(facade, /File\.ReadAllBytes|File\.ReadAllText/)
})

test('bootstrap double-click mode resolves its signed descriptor beside the process executable', () => {
  assert.match(
    program,
    /args\.Length == 0\s*\? BootstrapCommandLine\.FromExecutablePath\(Environment\.ProcessPath\)\s*: BootstrapCommandLine\.Parse\(args\)/,
  )
  assert.match(program, /DescriptorFileName = "MagicPot\.Bootstrap\.json"/)
  assert.match(program, /SignatureFileName = "MagicPot\.Bootstrap\.sig"/)
  assert.match(program, /Path\.GetDirectoryName\(fullExecutablePath\)/)
  assert.match(program, /Path\.Combine\(executableDirectory, DescriptorFileName\)/)
  assert.match(program, /Path\.Combine\(executableDirectory, SignatureFileName\)/)
  assert.doesNotMatch(program, /Environment\.CurrentDirectory|Directory\.GetCurrentDirectory|AppContext\.BaseDirectory/)
  assert.match(program, /BootstrapExecutableFacade\.InstallAsync\(options\.Descriptor, options\.Signature/)
})

test('bootstrap default path fails closed and explicit arguments remain strict', () => {
  assert.match(program, /string\.IsNullOrWhiteSpace\(executablePath\) \|\| !Path\.IsPathFullyQualified\(executablePath\)/)
  assert.match(program, /string\.IsNullOrWhiteSpace\(executableDirectory\) \|\| !Path\.IsPathFullyQualified\(executableDirectory\)/)
  assert.match(program, /args\.Count % 2 != 0/)
  assert.match(program, /if \(!allowed\.Contains\(option\)\) throw/)
  assert.match(program, /if \(!values\.TryAdd\(option, value\)\) throw/)
  assert.match(program, /Need\("--descriptor"\), Need\("--signature"\)/)
  assert.match(program, /Path\.IsPathFullyQualified\(value\)/)
})

test('bounded raw signature and same-handle payload hash checks are present', () => {
  assert.match(facade, /SignatureBytes = 64/)
  assert.match(facade, /FileShare\.None/)
  assert.match(core, /signature\.Length != 64/)
  assert.match(core, /SHA256\.HashData\(stream\)/)
  assert.match(core, /stream\.Length != size/)
})

test('bundle artifact names are deterministic', () => {
  for (const name of ['MagicPot.Bootstrap.json', 'MagicPot.Bootstrap.sig', 'MagicPot.Launcher.exe', 'MagicPot.Uninstall.exe']) assert.match(builder, new RegExp(name.replaceAll('.', '\\.')))
})
