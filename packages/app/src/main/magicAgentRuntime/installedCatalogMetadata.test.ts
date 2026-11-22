import { describe, expect, it } from 'vitest'
import { INSTALLED_CATALOG_METADATA_MAX_BYTES, projectInstalledCatalogMetadata } from './installedCatalogMetadata'

const metadata = () => ({
  id: 'demo.package', name: 'Demo Package', version: '1.0.0', description: 'Not executable',
  installedAt: '2026-01-01T00:00:00.000Z', sourcePath: '/absent/never-read', packagePath: '/old/relocated/package',
  manifest: { manifestVersion: 1, id: 'demo.package', name: 'Demo Package', version: '1.0.0', description: 'Not executable' }
})
const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value), 'utf8')
const expected = { id: 'demo.package', name: 'Demo Package', version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z' }

describe('bounded pure projection of actual final-installed metadata, not executable manifest or catalog authority', () => {
  it('projects exactly four fields from the actual writer shape, without requiring paths or package contents to exist', () => {
    const input = metadata(), raw = bytes(input), before = Buffer.from(raw)
    const row = projectInstalledCatalogMetadata('demo.package', raw)
    expect(row).toEqual(expected); expect(Object.keys(row!).sort()).toEqual(['id', 'installedAt', 'name', 'version'])
    expect(Object.isFrozen(row)).toBe(true); expect(Buffer.from(raw)).toEqual(before)
    expect(input).not.toHaveProperty('schemaVersion')
    expect(JSON.stringify(row)).not.toMatch(/sourcePath|packagePath|manifest|executable/)
  })

  it.each(['author', 'unicode', 'prerelease', 'build', 'contributions', 'bom', 'relocated'] as const)('accepts writer-compatible %s metadata while discarding non-display fields', kind => {
    const input = metadata()
    if (kind === 'author') Object.assign(input, { author: 'Example' })
    if (kind === 'unicode') input.name = input.manifest.name = '绘图助手 🌱'
    if (kind === 'prerelease') input.version = input.manifest.version = '1.0.0-rc.1'
    if (kind === 'build') input.version = input.manifest.version = '1.0.0+build.1'
    if (kind === 'contributions') Object.assign(input.manifest, { contributions: [{ id: 'agent', kind: 'agent', title: 'Agent', entry: 'agent.json', config: { systemPrompt: 'never projected', command: 'never executed' } }], keywords: ['one'] })
    if (kind === 'relocated') { input.sourcePath = 'C:\\old\\source'; input.packagePath = 'D:\\previous\\installed\\demo.package' }
    const raw = kind === 'bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(input)]) : bytes(input)
    const row = projectInstalledCatalogMetadata(input.id, raw)
    expect(row).toEqual({ ...expected, name: input.name, version: input.version })
    expect(JSON.stringify(row)).not.toMatch(/never projected|command|author|keywords|[A-Z]:/)
  })

  it.each(['', '../escape', 'demo..package', 'Demo.Package', '.install-demo', '.backup-demo', '.store-lock', 'demo.package.', 'demo.package ', 'con', 'nul.txt', 'aux', 'com1', 'lpt9', 'demo:stream', 'x'.repeat(65)])('rejects unsafe/noncanonical directory name %s without alias normalization', directory => {
    const input = metadata(); input.id = input.manifest.id = directory
    expect(projectInstalledCatalogMetadata(directory, bytes(input))).toBeNull()
  })

  it.each(['id', 'name', 'version', 'installedAt', 'sourcePath', 'packagePath', 'manifest'] as const)('requires actual writer field %s rather than defaulting missing state', key => {
    const input: Record<string, unknown> = metadata(); delete input[key]
    expect(projectInstalledCatalogMetadata('demo.package', bytes(input))).toBeNull()
  })

  it.each(['id', 'name', 'version', 'nestedId', 'nestedName', 'nestedVersion', 'manifestVersion', 'topVersion', 'nameWhitespace', 'versionWhitespace'] as const)('rejects inconsistent or unsupported %s without normalization/repair', field => {
    const input = metadata()
    if (field === 'id') input.id = 'other.package'
    if (field === 'name') input.name = 'Other'
    if (field === 'version') input.version = '2.0.0'
    if (field === 'nestedId') input.manifest.id = 'other.package'
    if (field === 'nestedName') input.manifest.name = 'Other'
    if (field === 'nestedVersion') input.manifest.version = '2.0.0'
    if (field === 'manifestVersion') input.manifest.manifestVersion = 2
    if (field === 'topVersion') Object.assign(input, { schemaVersion: 1 })
    if (field === 'nameWhitespace') input.name = input.manifest.name = ' Demo '
    if (field === 'versionWhitespace') input.version = input.manifest.version = ' 1.0.0 '
    expect(projectInstalledCatalogMetadata('demo.package', bytes(input))).toBeNull()
  })

  it.each(['2026-01-01', '2026-02-30T00:00:00.000Z', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00.000+01:00', 'invalid', '', 123, null])('requires canonical actual ISO installedAt %s', installedAt => {
    expect(projectInstalledCatalogMetadata('demo.package', bytes({ ...metadata(), installedAt }))).toBeNull()
  })

  it.each(['nameEmpty', 'nameLong', 'versionLong', 'badVersion', 'sourceType', 'sourceLong', 'packageType', 'descriptionType', 'authorType', 'manifestArray', 'unknownTop', 'unknownManifest', 'dangerousKey'] as const)('fails closed for bounded-envelope/schema error %s', field => {
    const input = metadata()
    if (field === 'nameEmpty') input.name = input.manifest.name = ''
    if (field === 'nameLong') input.name = input.manifest.name = 'x'.repeat(121)
    if (field === 'versionLong') input.version = input.manifest.version = '1.0.0+' + 'x'.repeat(129)
    if (field === 'badVersion') input.version = input.manifest.version = 'latest'
    if (field === 'sourceType') Object.assign(input, { sourcePath: {} })
    if (field === 'sourceLong') input.sourcePath = 'x'.repeat(8193)
    if (field === 'packageType') Object.assign(input, { packagePath: null })
    if (field === 'descriptionType') Object.assign(input, { description: null })
    if (field === 'authorType') Object.assign(input, { author: 12 })
    if (field === 'manifestArray') Object.assign(input, { manifest: [] })
    if (field === 'unknownTop') Object.assign(input, { secret: 'never project' })
    if (field === 'unknownManifest') Object.assign(input.manifest, { futureSchema: true })
    if (field === 'dangerousKey') Object.defineProperty(input, '__proto__', { value: { allowed: true }, enumerable: true })
    expect(projectInstalledCatalogMetadata('demo.package', bytes(input))).toBeNull()
  })

  it('strictly decodes bounded UTF8/JSON and does not treat malformed/unreadable metadata as an empty row', () => {
    const invalid = [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x7b, 0x7d]), Buffer.from('{'), Buffer.from('null'), Buffer.from('[]'), Buffer.from('true'), Buffer.from('{}'), Buffer.from(JSON.stringify(metadata()) + '\u0000'), Buffer.alloc(INSTALLED_CATALOG_METADATA_MAX_BYTES + 1, 0x20)]
    for (const raw of invalid) expect(projectInstalledCatalogMetadata('demo.package', raw)).toBeNull()
  })

  it.each(['top', 'nested', 'author'] as const)('accepts writer-compatible ignored multiline %s text, not display-label sanitation', field => {
    const input = metadata(), text = 'First line\nSecond line\tDetails'
    if (field === 'top') input.description = text
    if (field === 'nested') input.manifest.description = text
    if (field === 'author') Object.assign(input, { author: text })
    expect(projectInstalledCatalogMetadata(input.id, bytes(input))).toEqual(expected)
  })

  const withConfig = (data: unknown) => {
    const input = metadata()
    Object.assign(input.manifest, { contributions: [{ id: 'agent', kind: 'agent', entry: 'agent.json', config: { data } }] })
    return input
  }
  const shape = (value: unknown, depth = 0): { nodes: number; depth: number } => {
    const children = value && typeof value === 'object' ? Object.values(value).map(item => shape(item, depth + 1)) : []
    return { nodes: 1 + children.reduce((sum, child) => sum + child.nodes, 0), depth: Math.max(depth, ...children.map(child => child.depth)) }
  }

  it.each([16384, 16385])('enforces independent ignored-config string length boundary %i under the file byte cap', length => {
    const raw = bytes(withConfig('x'.repeat(length)))
    expect(raw.byteLength).toBeLessThan(INSTALLED_CATALOG_METADATA_MAX_BYTES)
    expect(projectInstalledCatalogMetadata('demo.package', raw)).toEqual(length === 16384 ? expected : null)
  })
  it.each([256, 257])('enforces independent ignored-config key length boundary %i', length => {
    const raw = bytes(withConfig({ ['k'.repeat(length)]: 0 }))
    expect(projectInstalledCatalogMetadata('demo.package', raw)).toEqual(length === 256 ? expected : null)
  })
  it.each(['object', 'array'] as const)('enforces independent ignored-config %s entry limit at 256 and 257', kind => {
    for (const length of [256, 257]) {
      const data = kind === 'array' ? Array.from({ length }, () => 0) : Object.fromEntries(Array.from({ length }, (_, index) => ['k' + index, 0]))
      expect(projectInstalledCatalogMetadata('demo.package', bytes(withConfig(data)))).toEqual(length === 256 ? expected : null)
    }
  })
  it.each([16, 17])('enforces independent JSON depth boundary %i including the metadata envelope', depth => {
    let data: unknown = 0
    for (let index = 0; index < depth - 5; index++) data = { child: data }
    const input = withConfig(data)
    expect(shape(input).depth).toBe(depth)
    expect(projectInstalledCatalogMetadata('demo.package', bytes(input))).toEqual(depth === 16 ? expected : null)
  })
  it.each([4096, 4097])('enforces independent JSON node count boundary %i below depth, entries, and byte limits', nodes => {
    const data = Array.from({ length: 16 }, (_, index) => Array.from({ length: index === 15 ? nodes - 3862 : 255 }, () => 0))
    const input = withConfig(data), raw = bytes(input)
    expect(shape(input)).toEqual({ nodes, depth: 7 })
    expect(raw.byteLength).toBeLessThan(INSTALLED_CATALOG_METADATA_MAX_BYTES)
    expect(projectInstalledCatalogMetadata('demo.package', raw)).toEqual(nodes === 4096 ? expected : null)
  })
  it.each(['__proto__', 'constructor', 'prototype'])('rejects dangerous nested ignored-config key %s without interpreting it', key => {
    const data = Object.create(null); data[key] = { value: 'untrusted' }
    expect(projectInstalledCatalogMetadata('demo.package', bytes(withConfig(data)))).toBeNull()
  })

  it('does not coerce malformed manifest contributions into display success', () => {
    for (const contributions of [{}, [{ kind: 'agent', id: '../bad', entry: '/outside' }], [{ id: 'agent', kind: 'unknown', config: {} }]]) {
      const input = metadata(); Object.assign(input.manifest, { contributions })
      expect(projectInstalledCatalogMetadata('demo.package', bytes(input))).toBeNull()
    }
  })
})
