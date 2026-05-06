// packages/app/src/renderer/src/store/slices/projectConfigSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'

/* ──────────────────────────────────────────
 *  工作流类型定义
 * ────────────────────────────────────────── */
export type WorkflowType = 'sd1.5' | 'sdxl' | 'sd3' | 'flux' | 'custom'

export interface WorkflowPreset {
  id: WorkflowType
  label: string
  description: string
  icon: string // emoji
  defaultSteps: number
  defaultCfg: number
  defaultSampler: string
  defaultScheduler: string
  supportedSamplers: string[]
  supportedSchedulers: string[]
  defaultWidth: number
  defaultHeight: number
  supportsNegativePrompt: boolean
}

/* ──────────────────────────────────────────
 *  生成参数
 * ────────────────────────────────────────── */
export interface GenerationParams {
  prompt: string
  negativePrompt: string
  steps: number
  cfgScale: number
  width: number
  height: number
  sampler: string
  scheduler: string
  seed: number
  seedLocked: boolean
  batchSize: number
  batchCount: number
}

/* ──────────────────────────────────────────
 *  预设数据
 * ────────────────────────────────────────── */
export const WORKFLOW_PRESETS: WorkflowPreset[] = [
  {
    id: 'sd1.5',
    label: 'Stable Diffusion 1.5',
    description: '经典 SD 模型，轻量快速，社区生态丰富',
    icon: '🎨',
    defaultSteps: 25,
    defaultCfg: 7,
    defaultSampler: 'euler_ancestral',
    defaultScheduler: 'normal',
    supportedSamplers: [
      'euler',
      'euler_ancestral',
      'dpmpp_2m',
      'dpmpp_2m_sde',
      'dpmpp_sde',
      'ddim',
      'lms',
      'heun',
      'uni_pc'
    ],
    supportedSchedulers: ['normal', 'karras', 'exponential', 'sgm_uniform'],
    defaultWidth: 512,
    defaultHeight: 512,
    supportsNegativePrompt: true
  },
  {
    id: 'sdxl',
    label: 'Stable Diffusion XL',
    description: '高分辨率模型，画质细腻，适合精细创作',
    icon: '🖼️',
    defaultSteps: 30,
    defaultCfg: 7,
    defaultSampler: 'dpmpp_2m',
    defaultScheduler: 'karras',
    supportedSamplers: [
      'euler',
      'euler_ancestral',
      'dpmpp_2m',
      'dpmpp_2m_sde',
      'dpmpp_sde',
      'ddim',
      'lms',
      'heun',
      'uni_pc'
    ],
    supportedSchedulers: ['normal', 'karras', 'exponential', 'sgm_uniform'],
    defaultWidth: 1024,
    defaultHeight: 1024,
    supportsNegativePrompt: true
  },
  {
    id: 'sd3',
    label: 'Stable Diffusion 3',
    description: '最新架构，三通道文本编码，文字渲染优秀',
    icon: '⚡',
    defaultSteps: 28,
    defaultCfg: 4.5,
    defaultSampler: 'dpmpp_2m',
    defaultScheduler: 'sgm_uniform',
    supportedSamplers: [
      'euler',
      'euler_ancestral',
      'dpmpp_2m',
      'dpmpp_2m_sde',
      'dpmpp_sde',
      'ddim',
      'lms',
      'heun',
      'uni_pc'
    ],
    supportedSchedulers: ['normal', 'karras', 'exponential', 'sgm_uniform'],
    defaultWidth: 1024,
    defaultHeight: 1024,
    supportsNegativePrompt: true
  },
  {
    id: 'flux',
    label: 'Flux',
    description: 'Black Forest Labs 新一代模型，构图精准，无需负向提示词',
    icon: '🔥',
    defaultSteps: 20,
    defaultCfg: 1.0,
    defaultSampler: 'euler',
    defaultScheduler: 'normal',
    supportedSamplers: ['euler', 'euler_ancestral', 'dpmpp_2m', 'heun'],
    supportedSchedulers: ['normal', 'simple', 'sgm_uniform'],
    defaultWidth: 1024,
    defaultHeight: 1024,
    supportsNegativePrompt: false
  },
  {
    id: 'custom',
    label: '自定义工作流',
    description: '手动配置所有参数，适合高级用户',
    icon: '🔧',
    defaultSteps: 20,
    defaultCfg: 7,
    defaultSampler: 'euler',
    defaultScheduler: 'normal',
    supportedSamplers: [
      'euler',
      'euler_ancestral',
      'dpmpp_2m',
      'dpmpp_2m_sde',
      'dpmpp_sde',
      'ddim',
      'lms',
      'heun',
      'uni_pc'
    ],
    supportedSchedulers: ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple'],
    defaultWidth: 1024,
    defaultHeight: 1024,
    supportsNegativePrompt: true
  }
]

/* ──────────────────────────────────────────
 *  Slice State
 * ────────────────────────────────────────── */
export interface ProjectConfigState {
  dialogOpen: boolean
  activeSubPage: 'workflow' | 'params'
  selectedWorkflow: WorkflowType
  params: GenerationParams
  /** 是否已用户手动修改过参数（否则切换工作流时重置为默认） */
  paramsModified: boolean
}

const STORAGE_KEY = 'projectConfig'

function loadState(): Partial<ProjectConfigState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* ignore */
  }
  return {}
}

function defaultParams(workflow: WorkflowType): GenerationParams {
  const preset = WORKFLOW_PRESETS.find((p) => p.id === workflow) || WORKFLOW_PRESETS[0]
  return {
    prompt: '',
    negativePrompt: '',
    steps: preset.defaultSteps,
    cfgScale: preset.defaultCfg,
    width: preset.defaultWidth,
    height: preset.defaultHeight,
    sampler: preset.defaultSampler,
    scheduler: preset.defaultScheduler,
    seed: -1,
    seedLocked: false,
    batchSize: 1,
    batchCount: 1
  }
}

const saved = loadState()

const initialState: ProjectConfigState = {
  dialogOpen: false,
  activeSubPage: 'workflow',
  selectedWorkflow: saved.selectedWorkflow || 'flux',
  params: saved.params || defaultParams(saved.selectedWorkflow || 'flux'),
  paramsModified: false
}

/* ──────────────────────────────────────────
 *  Slice
 * ────────────────────────────────────────── */
const projectConfigSlice = createSlice({
  name: 'projectConfig',
  initialState,
  reducers: {
    openProjectConfig(state) {
      state.dialogOpen = true
    },
    closeProjectConfig(state) {
      state.dialogOpen = false
    },
    setSubPage(state, action: PayloadAction<'workflow' | 'params'>) {
      state.activeSubPage = action.payload
    },
    selectWorkflow(state, action: PayloadAction<WorkflowType>) {
      state.selectedWorkflow = action.payload
      // 如果参数没有手动修改过，自动重置为新工作流的默认值
      if (!state.paramsModified) {
        state.params = defaultParams(action.payload)
      } else {
        // 即使手动修改过，也同步一些工作流强关联的属性
        const preset = WORKFLOW_PRESETS.find((p) => p.id === action.payload)
        if (preset) {
          // 如果新工作流不支持负向提示词，清空之
          if (!preset.supportsNegativePrompt) {
            state.params.negativePrompt = ''
          }
        }
      }
    },
    updateParams(state, action: PayloadAction<Partial<GenerationParams>>) {
      state.params = { ...state.params, ...action.payload }
      state.paramsModified = true
    },
    resetParamsToDefault(state) {
      state.params = defaultParams(state.selectedWorkflow)
      state.paramsModified = false
    },
    randomizeSeed(state) {
      state.params.seed = Math.floor(Math.random() * 2 ** 32)
    }
  }
})

/* ──────────────────────────────────────────
 *  持久化（仅持久化 workflow + params）
 * ────────────────────────────────────────── */
export function saveProjectConfigState(state: ProjectConfigState): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        selectedWorkflow: state.selectedWorkflow,
        params: state.params
      })
    )
  } catch {
    /* ignore */
  }
}

export const {
  openProjectConfig,
  closeProjectConfig,
  setSubPage,
  selectWorkflow,
  updateParams,
  resetParamsToDefault,
  randomizeSeed
} = projectConfigSlice.actions

export default projectConfigSlice
