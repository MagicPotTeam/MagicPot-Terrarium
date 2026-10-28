import { describe, expect, it } from 'vitest'
import {
  figmaTypography,
  photoshopTypography,
  hostTypographySchema,
  requiredFigmaFonts,
  typographyFontKey
} from './hostTypography'
import { hostContextSchema } from './hostPlan'
const font = { family: 'Owned 字体', style: 'Regular' }
const segment = (start = 0, end = 3) => ({
  start,
  end,
  fontName: font,
  fontSize: 14,
  characters: 'do not duplicate'
})
const good = () => figmaTypography('abc', false, [segment()])
const context = () => ({
  version: 1,
  host: 'figma',
  documentId: '0:0',
  scopeId: '0:1',
  captureId: 'a'.repeat(32),
  nodes: [
    {
      id: '1:2',
      type: 'TEXT',
      name: 'Owned',
      parentId: '0:1',
      ancestors: [],
      locked: false,
      visible: true,
      commands: ['text.content'],
      text: 'abc',
      typography: good(),
      fontKey: typographyFontKey(good())
    }
  ]
})
describe('bounded native font observations', () => {
  it('retains exact font names and ranges, not source text or host object properties', () => {
    expect(good()).toEqual({
      status: 'available',
      kind: 'figma-font-runs',
      characterCount: 3,
      hasMissingFont: false,
      runs: [{ start: 0, end: 3, font, fontSizePx: 14 }]
    })
    expect(JSON.stringify(good())).not.toContain('duplicate')
    expect(requiredFigmaFonts(good())).toEqual([font])
  })
  it('handles an empty text node using an explicit insertion font, not a default', () => {
    const value = figmaTypography('', false, [segment(0, 0)])
    expect(value.status).toBe('available')
    expect(requiredFigmaFonts(value)).toEqual([font])
    expect(figmaTypography('', false, [])).toEqual({ status: 'unavailable' })
  })
  it('deduplicates fonts and preserves variable axes with deterministic identity', () => {
    const one = { family: 'Variable', style: 'Custom', variationSettings: { wght: 600, slnt: -7 } }
    const two = { ...one, variationSettings: { slnt: -7, wght: 600 } }
    const value = figmaTypography('abcd', false, [
      { ...segment(0, 2), fontName: one },
      { ...segment(2, 4), fontName: two }
    ])
    expect(requiredFigmaFonts(value)).toEqual([two])
    expect(typographyFontKey(value)).toBe(
      typographyFontKey(figmaTypography('ab', false, [{ ...segment(0, 2), fontName: two }]))
    )
  })
  it.each([
    null,
    [],
    [segment(1, 3)],
    [segment(0, 2)],
    [segment(0, 2), segment(1, 3)],
    [segment(0, 0), segment(0, 3)],
    [{ ...segment(), fontSize: '14' }],
    [{ ...segment(), fontSize: NaN }],
    [{ ...segment(), fontName: { family: 'Missing style' } }],
    [{ ...segment(), fontName: { ...font, sourceUrl: 'https://forbidden.invalid/font' } }],
    [{ ...segment(), fontName: { ...font, variationSettings: { weight: 200 } } }],
    [{ ...segment(), fontName: { ...font, variationSettings: { wght: Infinity } } }],
    Array.from({ length: 65 }, (_, i) => segment(i, i + 1))
  ])('unavailable means unavailable; no clipping, coercion or invented font: %j', (segments) => {
    expect(figmaTypography('abc', false, segments)).toEqual({ status: 'unavailable' })
  })
  it('bounds unique faces and rejects oversized text without traversing segments', () => {
    const segments = Array.from({ length: 17 }, (_, i) => ({
      ...segment(i, i + 1),
      fontName: { family: 'F' + i, style: 'R' }
    }))
    expect(figmaTypography('x'.repeat(17), false, segments)).toEqual({ status: 'unavailable' })
    let read = false
    const segments2 = [
      {
        get start() {
          read = true
          throw Error('private')
        }
      }
    ]
    expect(figmaTypography('x'.repeat(4097), false, segments2)).toEqual({ status: 'unavailable' })
    expect(read).toBe(false)
  })
  it('missing fonts are recorded but never loadable; exceptions do not leak', () => {
    const missing = figmaTypography('abc', true, [segment()])
    expect(missing.status).toBe('available')
    expect(() => requiredFigmaFonts(missing)).toThrow('FONT_UNAVAILABLE')
    expect(figmaTypography('abc', undefined, [segment()])).toEqual({ status: 'unavailable' })
    expect(
      figmaTypography('abc', false, [
        {
          get fontName() {
            throw Error('PRIVATE_PATH')
          }
        }
      ])
    ).toEqual({ status: 'unavailable' })
  })
  it('Photoshop primary style has explicit coverage and 72ppi-referenced size', () => {
    const value = photoshopTypography('ArialMT', 14)
    expect(value).toEqual({
      status: 'available',
      kind: 'photoshop-character-style',
      coverage: 'primary-style-only',
      fontPostScriptName: 'ArialMT',
      size: { value: 14, unit: 'px-at-72ppi' }
    })
    expect(typographyFontKey(value)).toBe('{"postScriptName":"ArialMT"}')
    expect(() => requiredFigmaFonts(value)).toThrow()
  })
  it.each([undefined, null, '14', 0, Infinity, NaN, 1297])(
    'rejects unknown/out-of-bound Photoshop size %s',
    (size) => {
      expect(photoshopTypography('ArialMT', size)).toEqual({ status: 'unavailable' })
    }
  )
  it('wire rejects authority, install paths and cross-host font representations', () => {
    expect(hostTypographySchema.safeParse({ ...good(), path: 'private.ttf' }).success).toBe(false)
    expect(hostContextSchema.safeParse(context()).success).toBe(true)
    const c = context()
    c.nodes[0].typography = photoshopTypography('ArialMT', 14)
    expect(hostContextSchema.safeParse(c).success).toBe(false)
  })
  it('font identity and character coverage are bound to the submitted node', () => {
    for (const change of ['font', 'length', 'kind', 'missing']) {
      const c = context()
      if (change === 'font') c.nodes[0].fontKey = 'substituted'
      if (change === 'length') c.nodes[0].text = 'longer'
      if (change === 'kind') c.nodes[0].type = 'RECTANGLE'
      if (change === 'missing') c.nodes[0].typography = figmaTypography('abc', true, [segment()])
      expect(hostContextSchema.safeParse(c).success).toBe(false)
    }
  })
  it('unavailable metadata can still support non-text commands and old context stays compatible', () => {
    const c = context()
    c.nodes[0].commands = ['node.rename']
    c.nodes[0].typography = { status: 'unavailable' }
    delete c.nodes[0].fontKey
    expect(hostContextSchema.safeParse(c).success).toBe(true)
    const old = context()
    Reflect.deleteProperty(old.nodes[0], 'typography')
    Reflect.deleteProperty(old.nodes[0], 'fontKey')
    expect(hostContextSchema.safeParse(old).success).toBe(true)
  })
})
