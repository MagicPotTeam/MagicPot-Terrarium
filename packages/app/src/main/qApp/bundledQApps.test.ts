import { describe, expect, it } from 'vitest'

const promptSuffix = '.prompt.json'
const cfgSuffix = '.qacfg.json'

const bundledQApps = import.meta.glob('../../../../qapps/**/*.json', {
  eager: true,
  query: '?raw',
  import: 'default'
}) as Record<string, string>

function parseJson(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, ''))
}

function getBundledQAppKey(path: string, suffix: string): string {
  return path.replace(/^.*\/(?:packages\/)?qapps\//, '').slice(0, -suffix.length)
}

function getControlNetModelName(node: {
  class_type?: string
  inputs?: unknown
}): string | undefined {
  const inputs = node.inputs as
    | { control_net_name?: unknown; cnet?: unknown; name?: unknown }
    | undefined
  const name =
    node.class_type === 'ControlNetLoader'
      ? inputs?.control_net_name
      : node.class_type === 'ACN_ControlNetLoaderAdvanced'
        ? inputs?.cnet
        : node.class_type === 'ACN_ControlNet++LoaderSingle'
          ? inputs?.name
          : undefined

  return typeof name === 'string' && name.length > 0 ? name : undefined
}

function getRuntimeDownloadedModelNames(node: { class_type?: string; inputs?: unknown }): string[] {
  const inputs = node.inputs as { preprocessor?: unknown } | undefined

  if (node.class_type === 'AIO_Preprocessor') {
    switch (inputs?.preprocessor) {
      case 'AnyLineArtPreprocessor_aux':
        return ['MTEED.pth']
      case 'DepthAnythingV2Preprocessor':
        return ['depth_anything_v2_vitl.pth']
      default:
        return []
    }
  }

  if (node.class_type === 'InspyrenetRembg' || node.class_type === 'InspyrenetRembgAdvanced') {
    return ['ckpt_base.pth']
  }

  return []
}

const runtimeModelExpectations = {
  'MTEED.pth': {
    dir: 'custom_nodes/comfyui_controlnet_aux/ckpts/TheMistoAI/MistoLine/Anyline',
    baseDir: undefined
  },
  'depth_anything_v2_vitl.pth': {
    dir: 'custom_nodes/comfyui_controlnet_aux/ckpts/depth-anything/Depth-Anything-V2-Large',
    baseDir: undefined
  },
  'ckpt_base.pth': {
    dir: '.transparent-background',
    baseDir: 'portableHome'
  }
} as const

describe('bundled qApp fixtures', () => {
  it('keeps every checked-in qApp JSON file parseable', async () => {
    for (const text of Object.values(bundledQApps)) {
      expect(() => parseJson(text)).not.toThrow()
    }
  })

  it('lists every bundled ControlNet model as a required model', async () => {
    const cfgByKey = new Map<string, Record<string, unknown>>()

    for (const [path, text] of Object.entries(bundledQApps)) {
      if (!path.endsWith(cfgSuffix)) continue
      cfgByKey.set(getBundledQAppKey(path, cfgSuffix), parseJson(text) as Record<string, unknown>)
    }

    for (const [path, text] of Object.entries(bundledQApps)) {
      if (!path.endsWith(promptSuffix)) continue

      const key = getBundledQAppKey(path, promptSuffix)
      const cfg = cfgByKey.get(key)
      if (!cfg) continue

      const workflow = parseJson(text) as Record<string, { class_type?: string; inputs?: unknown }>
      const controlNetNames = new Set(
        Object.values(workflow)
          .map(getControlNetModelName)
          .filter((name): name is string => typeof name === 'string')
      )
      const requiredModels = Array.isArray(cfg.requiredModels)
        ? cfg.requiredModels
            .map((model) => (model as { name?: unknown }).name)
            .filter((name): name is string => typeof name === 'string')
        : []

      expect(requiredModels, key).toEqual(expect.arrayContaining([...controlNetNames]))
    }
  })

  it('lists runtime-downloaded node models as required models', async () => {
    const cfgByKey = new Map<string, Record<string, unknown>>()

    for (const [path, text] of Object.entries(bundledQApps)) {
      if (!path.endsWith(cfgSuffix)) continue
      cfgByKey.set(getBundledQAppKey(path, cfgSuffix), parseJson(text) as Record<string, unknown>)
    }

    for (const [path, text] of Object.entries(bundledQApps)) {
      if (!path.endsWith(promptSuffix)) continue

      const key = getBundledQAppKey(path, promptSuffix)
      const cfg = cfgByKey.get(key)
      if (!cfg) continue

      const workflow = parseJson(text) as Record<string, { class_type?: string; inputs?: unknown }>
      const runtimeModelNames = new Set(
        Object.values(workflow).flatMap(getRuntimeDownloadedModelNames)
      )
      const requiredModelEntries = Array.isArray(cfg.requiredModels) ? cfg.requiredModels : []
      const requiredModels = requiredModelEntries
        .map((model) => (model as { name?: unknown }).name)
        .filter((name): name is string => typeof name === 'string')

      expect(requiredModels, key).toEqual(expect.arrayContaining([...runtimeModelNames]))

      for (const modelName of runtimeModelNames) {
        const expectation =
          runtimeModelExpectations[modelName as keyof typeof runtimeModelExpectations]
        const model = requiredModelEntries.find(
          (entry) => (entry as { name?: unknown }).name === modelName
        ) as { baseDir?: unknown; dir?: unknown; url?: unknown } | undefined

        expect(model?.dir, key).toBe(expectation.dir)
        expect(model?.baseDir, key).toBe(expectation.baseDir)
        expect(typeof model?.url, key).toBe('string')
        expect(model?.url, key).not.toBe('')
      }
    }
  })
})
