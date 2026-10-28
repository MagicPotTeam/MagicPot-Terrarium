import { describe, expect, it } from 'vitest'
import { figmaAppearance, photoshopTextAppearance, hostAppearanceSchema } from './hostAppearance'
import { hostContextSchema, type HostContext } from './hostPlan'

const solid = () => ({ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3 } })
const gradient = () => ({
  type: 'GRADIENT_LINEAR',
  gradientTransform: [
    [1, 0, 0],
    [0, 1, 0]
  ],
  gradientStops: [
    { position: 0, color: { r: 1, g: 0, b: 0, a: 0.5 } },
    { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }
  ]
})
const image = () => ({
  type: 'IMAGE',
  imageHash: 'a'.repeat(40),
  scaleMode: 'CROP',
  imageTransform: [
    [1, 0, 0],
    [0, 1, 0]
  ],
  filters: { exposure: -0.25, contrast: 1 }
})
function paints(fills: unknown) {
  const result = figmaAppearance(fills, [], 'DISPLAY_P3')
  if (result.status !== 'available' || result.kind !== 'figma-paints')
    throw Error('Missing appearance')
  return result.fills
}
function first(fill: unknown) {
  const result = paints([fill])
  if (result.status !== 'available') throw Error('Missing paints')
  return result.paints[0]
}
const context = (host: 'figma' | 'photoshop'): HostContext => ({
  version: 1,
  host,
  documentId: 'doc',
  scopeId: 'scope',
  captureId: 'a'.repeat(32),
  nodes: [
    {
      id: 'target',
      type: host === 'figma' ? 'RECTANGLE' : 'text',
      name: 'Owned',
      parentId: null,
      ancestors: [],
      locked: false,
      visible: true,
      commands: ['node.rename']
    }
  ]
})

describe('bounded appearance observations', () => {
  it('copies solid projection and actual profile without invented defaults or native extra fields', () => {
    const input = {
      ...solid(),
      visible: false,
      opacity: 0,
      blendMode: 'MULTIPLY',
      color: { ...solid().color, sourceColor: { secret: 'PRIVATE' } },
      privatePath: 'PRIVATE'
    }
    const result = first(input)
    expect(result).toEqual({
      type: 'SOLID',
      visible: false,
      opacity: 0,
      blendMode: 'MULTIPLY',
      color: solid().color
    })
    expect(first(solid())).not.toHaveProperty('opacity')
    expect(first(solid())).not.toHaveProperty('visible')
    expect(figmaAppearance([], [], undefined)).toMatchObject({ documentColorProfile: 'unknown' })
  })
  it('preserves bounded gradient stops, alpha and transform', () => {
    expect(first(gradient())).toEqual(gradient())
  })
  it('retains image references and filters without paths, bytes, URLs or private fields', () => {
    const raw = { ...image(), url: 'PRIVATE', bytes: [1, 2, 3], data: 'PRIVATE' }
    Object.defineProperty(raw, 'getBytesAsync', {
      get() {
        throw Error('Must not read')
      }
    })
    expect(first(raw)).toEqual({ ...image(), coverage: 'reference-only' })
    expect(first({ ...image(), imageHash: null })).toMatchObject({ imageHash: null })
  })
  it('keeps genuinely empty, mixed and unavailable paint collections distinct', () => {
    const mixed = Symbol('mixed')
    expect(paints([])).toEqual({ status: 'available', paints: [] })
    expect(paints(undefined)).toEqual({ status: 'unavailable' })
    expect(figmaAppearance(mixed, [], 'SRGB', mixed)).toMatchObject({ fills: { status: 'mixed' } })
    expect(first({ type: 'FUTURE_PAINT', private: 'PRIVATE' })).toEqual({ type: 'unavailable' })
  })
  it.each([NaN, Infinity, -0.01, 1.01, '0.5', null])(
    'rejects invalid normalized channel %s without coercion',
    (value) => {
      expect(first({ type: 'SOLID', color: { r: value, g: 0, b: 0 } })).toEqual({
        type: 'unavailable'
      })
    }
  )
  it('enforces paint and gradient caps before accessing elements, without silent truncation', () => {
    const tooMany = new Array(17)
    Object.defineProperty(tooMany, 0, {
      get() {
        throw Error('Over-limit element read')
      }
    })
    expect(paints(tooMany)).toEqual({ status: 'unavailable' })
    expect(first({ ...gradient(), gradientStops: tooMany })).toEqual({ type: 'unavailable' })
    expect(paints(new Array(16).fill(solid()))).toMatchObject({ status: 'available' })
  })
  it.each([
    'https://example.invalid/secret',
    'C:\\private.png',
    '../private',
    'a\n',
    'a'.repeat(129)
  ])('never treats an invalid reference as a resource path: %s', (imageHash) => {
    expect(first({ ...image(), imageHash })).toEqual({ type: 'unavailable' })
  })
  it('catches throwing getters without revealing exception data', () => {
    const raw = {
      type: 'SOLID',
      get color() {
        throw Error('PRIVATE DESIGN PATH')
      }
    }
    expect(first(raw)).toEqual({ type: 'unavailable' })
    expect(
      photoshopTextAppearance({
        get typename() {
          throw Error('PRIVATE')
        }
      })
    ).toEqual({ status: 'unavailable' })
  })
  it('does not invoke a custom iterator or hide a nonempty native stack', () => {
    const raw = [solid()]
    Object.defineProperty(raw, Symbol.iterator, {
      value: function* () {
        yield { ...solid(), color: { r: 1, g: 1, b: 1 } }
      }
    })
    expect(paints(raw)).toEqual({ status: 'available', paints: [solid()] })
  })
  it('does not invoke raw array map/some hooks for transforms or stops', () => {
    const raw = gradient()
    raw.gradientTransform.map = (() => {
      throw Error('Do not invoke native map')
    }) as typeof raw.gradientTransform.map
    raw.gradientTransform.some = (() => {
      throw Error('Do not invoke native some')
    }) as typeof raw.gradientTransform.some
    raw.gradientStops.map = (() => {
      throw Error('Do not invoke native map')
    }) as typeof raw.gradientStops.map
    expect(first(raw)).toEqual(gradient())
  })
  it('rejects missing entries and invalid gradient values instead of inventing stops', () => {
    expect(first({ ...gradient(), gradientStops: new Array(2) })).toEqual({ type: 'unavailable' })
    expect(first({ ...gradient(), gradientTransform: [[], []] })).toEqual({ type: 'unavailable' })
    expect(first({ ...image(), filters: { exposure: -1.01 } })).toEqual({ type: 'unavailable' })
  })
  it.each([
    [
      { typename: 'RGBColor', red: 0, green: 128.5, blue: 255 },
      { model: 'RGB', red: 0, green: 128.5, blue: 255 }
    ],
    [
      { typename: 'CMYKColor', cyan: 10, magenta: 20, yellow: 30, black: 40 },
      { model: 'CMYK', cyan: 10, magenta: 20, yellow: 30, black: 40 }
    ],
    [
      { typename: 'GrayColor', gray: 25 },
      { model: 'GRAYSCALE', gray: 25 }
    ],
    [
      { typename: 'LabColor', l: 50, a: -128, b: 127 },
      { model: 'LAB', l: 50, a: -128, b: 127 }
    ],
    [
      { typename: 'HSBColor', hue: 360, saturation: 0, brightness: 100 },
      { model: 'HSB', hue: 360, saturation: 0, brightness: 100 }
    ]
  ])('preserves native Photoshop components without conversion (%s)', (input, expected) => {
    expect(photoshopTextAppearance(input)).toEqual({
      status: 'available',
      kind: 'photoshop-text-color',
      coverage: 'primary-style-only',
      colorEncoding: 'native-unconverted',
      color: expected
    })
  })
  it.each([
    undefined,
    null,
    {},
    { typename: 'NoColor' },
    { typename: 'RGBColor', red: -1, green: 0, blue: 0 },
    { typename: 'RGBColor', red: '1', green: 0, blue: 0 },
    { typename: 'CMYKColor', cyan: 101, magenta: 0, yellow: 0, black: 0 },
    { typename: 'LabColor', l: 50, a: 128, b: 0 }
  ])('marks unsupported or invalid Photoshop data unavailable (%s)', (value) => {
    expect(photoshopTextAppearance(value)).toEqual({ status: 'unavailable' })
  })
  it('bounds direct wire data, rejects extra fields and never grants a new command', () => {
    const appearance = figmaAppearance([solid()], [], 'SRGB')
    expect(hostAppearanceSchema.safeParse({ ...appearance, write: true }).success).toBe(false)
    const ctx = context('figma')
    ctx.nodes[0].appearance = appearance
    expect(hostContextSchema.parse(ctx).nodes[0].commands).toEqual(['node.rename'])
    expect(hostContextSchema.safeParse(context('figma')).success).toBe(true)
    const ps = context('photoshop')
    ps.nodes[0].appearance = appearance
    expect(hostContextSchema.safeParse(ps).success).toBe(false)
    const color = photoshopTextAppearance({ typename: 'RGBColor', red: 0, green: 0, blue: 0 })
    ctx.nodes[0].appearance = color
    expect(hostContextSchema.safeParse(ctx).success).toBe(false)
    ps.nodes[0].appearance = color
    ps.nodes[0].type = 'pixel'
    expect(hostContextSchema.safeParse(ps).success).toBe(false)
  })
  it.each([NaN, -1, 0.5, '0', Infinity])(
    'rejects invalid array length %s before elements',
    (length) => {
      let reads = 0
      const raw = new Proxy([solid()], {
        get(target, key, receiver) {
          if (key === 'length') return length
          if (key === '0') reads++
          return Reflect.get(target, key, receiver)
        }
      })
      expect(paints(raw)).toEqual({ status: 'unavailable' })
      expect(first({ ...gradient(), gradientStops: raw })).toEqual({ type: 'unavailable' })
      expect(reads).toBe(0)
    }
  )
  it('snapshots gradient length once before traversal', () => {
    let lengths = 0,
      reads = 0
    const raw = new Proxy([gradient().gradientStops[0]], {
      get(target, key, receiver) {
        if (key === 'length') return ++lengths < 3 ? 1 : 100
        if (typeof key === 'string' && /^[0-9]+$/.test(key)) reads++
        return Reflect.get(target, key, receiver)
      }
    })
    expect(first({ ...gradient(), gradientStops: raw })).toMatchObject({ type: 'GRADIENT_LINEAR' })
    expect(lengths).toBe(1)
    expect(reads).toBe(1)
  })
  it('wire schema rejects excessive arrays before accessing elements', () => {
    let reads = 0
    const tooMany = new Array(1000)
    Object.defineProperty(tooMany, 0, {
      get() {
        reads++
        return solid()
      }
    })
    const value = figmaAppearance([], [], 'SRGB')
    expect(
      hostAppearanceSchema.safeParse({ ...value, fills: { status: 'available', paints: tooMany } })
        .success
    ).toBe(false)
    expect(
      hostAppearanceSchema.safeParse({
        ...value,
        fills: { status: 'available', paints: [{ ...gradient(), gradientStops: tooMany }] }
      }).success
    ).toBe(false)
    expect(reads).toBe(0)
  })
  it('does not let repeated style data exceed the existing overall context budget', () => {
    const ctx = context('figma')
    const fill = { ...gradient(), gradientStops: new Array(16).fill(gradient().gradientStops[0]) }
    const appearance = figmaAppearance(new Array(4).fill(fill), [], 'SRGB')
    expect(appearance.status).toBe('available')
    ctx.nodes = new Array(20)
      .fill(null)
      .map((_, i) => ({ ...ctx.nodes[0], id: String(i), appearance }))
    expect(hostContextSchema.safeParse(ctx).success).toBe(false)
  })
})
