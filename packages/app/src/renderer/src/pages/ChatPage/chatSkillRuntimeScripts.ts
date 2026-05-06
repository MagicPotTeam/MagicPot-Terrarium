import type { SkillRuntimeSpec } from './chatSkillRuntime'

export type SkillRuntimeScriptPhase = 'pre' | 'post'

type RunSkillRuntimeScriptsInput = {
  runtime: SkillRuntimeSpec
  content: string
  phase: SkillRuntimeScriptPhase
}

export type SkillRuntimeScriptStep = {
  script: string
  phase: SkillRuntimeScriptPhase
  supported: boolean
  beforeLength: number
  afterLength: number
  changed: boolean
  note?: string
}

export type SkillRuntimeScriptExecutionReport = {
  phase: SkillRuntimeScriptPhase
  content: string
  steps: SkillRuntimeScriptStep[]
}

const SUPPORTED_PRE_SCRIPTS = new Set(['pre:strip-markdown-fences', 'pre:trim-text'])
const SUPPORTED_POST_SCRIPTS = new Set(['post:strip-markdown-fences', 'post:trim-text'])

const stripMarkdownFences = (value: string): string => {
  let next = value.trim()
  const fencedBlock = /^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/m

  while (fencedBlock.test(next)) {
    next = next.replace(fencedBlock, '$1').trim()
  }

  return next
}

const resolveSupportedScriptsForPhase = (phase: SkillRuntimeScriptPhase): Set<string> =>
  phase === 'pre' ? SUPPORTED_PRE_SCRIPTS : SUPPORTED_POST_SCRIPTS

const resolveRuntimeScriptsForPhase = (
  runtime: SkillRuntimeSpec,
  phase: SkillRuntimeScriptPhase
): string[] => runtime.scripts.filter((script) => script.startsWith(`${phase}:`))

const resolveSkillRuntimeScripts = (
  input: RunSkillRuntimeScriptsInput
): SkillRuntimeScriptExecutionReport => {
  const supportedScripts = resolveSupportedScriptsForPhase(input.phase)
  const scriptsForPhase = resolveRuntimeScriptsForPhase(input.runtime, input.phase)
  let nextContent = input.content
  const steps: SkillRuntimeScriptStep[] = []

  for (const script of scriptsForPhase) {
    const beforeContent = nextContent
    let note: string | undefined

    if (supportedScripts.has(script)) {
      switch (script) {
        case 'pre:strip-markdown-fences':
        case 'post:strip-markdown-fences':
          nextContent = stripMarkdownFences(nextContent)
          break
        case 'pre:trim-text':
        case 'post:trim-text':
          nextContent = nextContent.trim()
          break
        default:
          break
      }
    } else {
      note = `Unsupported ${input.phase} script; skipped.`
    }

    steps.push({
      script,
      phase: input.phase,
      supported: supportedScripts.has(script),
      beforeLength: beforeContent.length,
      afterLength: nextContent.length,
      changed: beforeContent !== nextContent,
      ...(note ? { note } : {})
    })
  }

  return {
    phase: input.phase,
    content: nextContent,
    steps
  }
}

export const resolveSkillRuntimePreScripts = (
  input: Omit<RunSkillRuntimeScriptsInput, 'phase'>
): SkillRuntimeScriptExecutionReport =>
  resolveSkillRuntimeScripts({
    ...input,
    phase: 'pre'
  })

export const runSkillRuntimePreScripts = (
  input: Omit<RunSkillRuntimeScriptsInput, 'phase'>
): string => resolveSkillRuntimePreScripts(input).content

export const resolveSkillRuntimePostScripts = (
  input: Omit<RunSkillRuntimeScriptsInput, 'phase'>
): SkillRuntimeScriptExecutionReport =>
  resolveSkillRuntimeScripts({
    ...input,
    phase: 'post'
  })

export const runSkillRuntimePostScripts = (
  input: Omit<RunSkillRuntimeScriptsInput, 'phase'>
): string => resolveSkillRuntimePostScripts(input).content

const buildSkillRuntimeScriptContext = (
  runtime: SkillRuntimeSpec,
  phase: SkillRuntimeScriptPhase,
  report?: SkillRuntimeScriptExecutionReport
): string | undefined => {
  const scriptsForPhase = resolveRuntimeScriptsForPhase(runtime, phase)
  if (scriptsForPhase.length === 0) {
    return undefined
  }

  const resolvedReport =
    report ||
    resolveSkillRuntimeScripts({
      runtime,
      content: '',
      phase
    })
  const supportedCount = resolvedReport.steps.filter((step) => step.supported).length
  const unsupportedCount = resolvedReport.steps.length - supportedCount

  return [
    `Skill ${phase} scripts (supported=${supportedCount}, unsupported=${unsupportedCount}):`,
    ...resolvedReport.steps.map(
      (step) =>
        `- ${step.script} [${step.supported ? 'supported' : 'unsupported'}; ${
          step.changed ? 'changed' : 'unchanged'
        }; before=${step.beforeLength}; after=${step.afterLength}]${
          step.note ? ` ${step.note}` : ''
        }`
    )
  ].join('\n')
}

export const buildSkillRuntimePreScriptContext = (
  runtime: SkillRuntimeSpec,
  report?: SkillRuntimeScriptExecutionReport
): string | undefined => buildSkillRuntimeScriptContext(runtime, 'pre', report)

export const buildSkillRuntimePostScriptContext = (
  runtime: SkillRuntimeSpec,
  report?: SkillRuntimeScriptExecutionReport
): string | undefined => buildSkillRuntimeScriptContext(runtime, 'post', report)
