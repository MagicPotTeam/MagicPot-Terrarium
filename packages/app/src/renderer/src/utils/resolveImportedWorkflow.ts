import { buildQAppCfgFromAppMode, extractAppModeMetadata } from '@shared/comfy/appModeInterop'
import { normalizeExecutableWorkflow } from '@shared/comfy/funcs'
import { convertGuiWorkflowToPrompt, isGuiWorkflow } from '@shared/comfy/guiWorkflowToPrompt'
import { isWorkflow } from '@shared/comfy/typeGuards'
import { ObjectInfoMap, Workflow } from '@shared/comfy/types'
import { QAppCfg } from '@shared/qApp/cfgTypes'
import { api } from './windowUtils'

type ResolveImportedWorkflowOptions = {
  objectInfos?: ObjectInfoMap
}

export type ResolveImportedWorkflowResult = {
  workflow: Workflow
  cfg: QAppCfg
  isAppMode: boolean
  warnings: string[]
}

let objectInfoPromise: Promise<ObjectInfoMap> | null = null

function createEmptyQAppCfg(): QAppCfg {
  return {
    icon: '',
    inputs: [],
    autoInputs: []
  }
}

function hasObjectInfos(objectInfos?: ObjectInfoMap): objectInfos is ObjectInfoMap {
  return !!objectInfos && Object.keys(objectInfos).length > 0
}

async function getObjectInfos(): Promise<ObjectInfoMap> {
  if (!objectInfoPromise) {
    objectInfoPromise = api()
      .svcComfy.getObjectInfo({})
      .catch((error) => {
        objectInfoPromise = null
        throw error
      })
  }
  return objectInfoPromise
}

function unwrapCandidates(input: unknown): { prompt?: Workflow; gui?: unknown } {
  if (isWorkflow(input)) {
    return { prompt: input }
  }
  if (isGuiWorkflow(input)) {
    return { gui: input }
  }
  if (!input || typeof input !== 'object') {
    return {}
  }

  const dict = input as Record<string, unknown>
  const prompt = isWorkflow(dict.prompt)
    ? (dict.prompt as Workflow)
    : isWorkflow(dict.workflow)
      ? (dict.workflow as Workflow)
      : undefined
  const gui = isGuiWorkflow(dict.workflow)
    ? dict.workflow
    : isGuiWorkflow(dict.prompt)
      ? dict.prompt
      : undefined

  return { prompt, gui }
}

export async function resolveImportedWorkflow(
  input: unknown,
  options: ResolveImportedWorkflowOptions = {}
): Promise<ResolveImportedWorkflowResult> {
  const { prompt: promptCandidate, gui } = unwrapCandidates(input)
  let workflow: Workflow | undefined = promptCandidate
    ? normalizeExecutableWorkflow(promptCandidate)
    : undefined
  let objectInfos = options.objectInfos

  if (!workflow && gui) {
    if (!hasObjectInfos(objectInfos)) {
      try {
        objectInfos = await getObjectInfos()
      } catch (error) {
        throw new Error('无法读取 ComfyUI 节点定义，请先连接 ComfyUI 后再导入该工作流')
      }
    }

    workflow = convertGuiWorkflowToPrompt(gui, objectInfos) ?? undefined
  }

  if (!workflow) {
    throw new Error('无法识别该工作流格式')
  }

  const isAppMode = !!gui && !!extractAppModeMetadata(gui)
  const warnings: string[] = []
  let cfg = createEmptyQAppCfg()

  if (gui && isAppMode) {
    if (!hasObjectInfos(objectInfos)) {
      try {
        objectInfos = await getObjectInfos()
      } catch (error) {
        void error
      }
    }

    const appCfgResult = buildQAppCfgFromAppMode(gui, workflow, objectInfos ?? {})
    if (appCfgResult) {
      cfg = appCfgResult.cfg
      warnings.push(...appCfgResult.warnings)
    }
  }

  return {
    workflow,
    cfg,
    isAppMode,
    warnings
  }
}
