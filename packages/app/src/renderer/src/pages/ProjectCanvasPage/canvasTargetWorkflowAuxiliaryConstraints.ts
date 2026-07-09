import {
  CANVAS_TARGET_AUXILIARY_INPUT_KINDS,
  formatCanvasTargetAuxiliaryInput,
  formatCanvasTargetAuxiliaryOutputFormat,
  formatCanvasTargetAuxiliaryOutputFormats,
  formatCanvasTargetAuxiliaryResponsibility,
  type CanvasTargetAuxiliaryInputKind,
  type CanvasTargetAuxiliaryOutputFormat
} from './canvasTargetTypes'
import type { CanvasTargetControlStageCandidate } from './canvasTargetWorkflow'
import { normalizeCanvasTargetOutputFormats } from './canvasTargetWorkflowPromptContext'

export function normalizeAuxiliaryAllowedInputs(
  allowedInputs: CanvasTargetControlStageCandidate['allowedInputs']
): CanvasTargetAuxiliaryInputKind[] {
  if (!Array.isArray(allowedInputs) || allowedInputs.length === 0) {
    return [...CANVAS_TARGET_AUXILIARY_INPUT_KINDS]
  }

  return Array.from(new Set(allowedInputs.filter(Boolean)))
}

export function hasAuxiliaryAllowedInput(
  profile: CanvasTargetControlStageCandidate | undefined,
  inputKind: CanvasTargetAuxiliaryInputKind
): boolean {
  return normalizeAuxiliaryAllowedInputs(profile?.allowedInputs).includes(inputKind)
}

function appendUniqueReferenceNotes(
  referenceNotes: string[],
  notesToAppend: Array<string | null | undefined>
): string[] {
  return notesToAppend.reduce<string[]>((notes, note) => {
    const normalizedNote = note?.trim()
    if (!normalizedNote) return notes
    return notes.some((entry) => entry.trim() === normalizedNote)
      ? notes
      : [...notes, normalizedNote]
  }, referenceNotes)
}

export function normalizeAuxiliaryOutputFormats(
  profile: Pick<CanvasTargetControlStageCandidate, 'outputFormats' | 'outputFormat'> | undefined
): CanvasTargetAuxiliaryOutputFormat[] {
  if (Array.isArray(profile?.outputFormats) && profile.outputFormats.length > 0) {
    return normalizeCanvasTargetOutputFormats(profile.outputFormats)
  }

  return profile?.outputFormat ? [profile.outputFormat] : []
}

function buildAuxiliaryConstraintNotes(
  profile: CanvasTargetControlStageCandidate | undefined
): string[] {
  if (!profile) return []
  const outputFormats = normalizeAuxiliaryOutputFormats(profile)
  const backendNote =
    profile.executionBackend === 'local_model'
      ? 'Execution backend: local model. This auxiliary stage runs a user-selected local backend over supplied inputs and returns structured model output.'
      : profile.executionBackend
        ? `Execution backend: ${profile.executionBackend}`
        : null

  return [
    backendNote,
    profile.responsibilityType
      ? `Auxiliary responsibility: ${formatCanvasTargetAuxiliaryResponsibility(profile.responsibilityType)}`
      : null,
    profile.mustFollow?.trim() ? `Must follow: ${profile.mustFollow.trim()}` : null,
    profile.forbiddenActions?.trim()
      ? `Forbidden actions: ${profile.forbiddenActions.trim()}`
      : null,
    `Allowed inputs: ${normalizeAuxiliaryAllowedInputs(profile.allowedInputs)
      .map((inputKind) => formatCanvasTargetAuxiliaryInput(inputKind))
      .join(', ')}`,
    outputFormats.length === 1
      ? `Additional requested output format: ${formatCanvasTargetAuxiliaryOutputFormat(outputFormats[0])}`
      : outputFormats.length > 1
        ? `Additional requested output formats: ${formatCanvasTargetAuxiliaryOutputFormats(outputFormats)}`
        : null,
    profile.executionRule?.trim()
      ? `Auxiliary execution rule: ${profile.executionRule.trim()}`
      : null
  ].filter((note): note is string => Boolean(note))
}

export function appendAuxiliaryConstraintNotes(
  referenceNotes: string[],
  profile: CanvasTargetControlStageCandidate | undefined
): string[] {
  return appendUniqueReferenceNotes(referenceNotes, buildAuxiliaryConstraintNotes(profile))
}

export function appendAuxiliaryPromptContract(
  prompt: string,
  profile: CanvasTargetControlStageCandidate | undefined,
  stageIndex: number
): string {
  if (!profile) return prompt
  const outputFormats = normalizeAuxiliaryOutputFormats(profile)
  const backendLines =
    profile.executionBackend === 'local_model'
      ? [
          'This candidate does not run as a chat model.',
          'It runs a local model backend over the supplied inputs. The current built-in implementation is the duplicate-check visual analyzer.',
          'Do not assign it arbitrary prose generation or tasks that require inputs outside its allowed input contract.'
        ]
      : []

  return [
    prompt.trim(),
    `This stage is assigned to auxiliary model ${stageIndex + 1}: ${profile.label}.`,
    ...backendLines,
    profile.responsibilityType
      ? `Primary responsibility: ${formatCanvasTargetAuxiliaryResponsibility(profile.responsibilityType)}.`
      : null,
    profile.mustFollow?.trim() ? `You must follow: ${profile.mustFollow.trim()}.` : null,
    profile.forbiddenActions?.trim()
      ? `You must not do the following: ${profile.forbiddenActions.trim()}.`
      : null,
    'Always preserve your complete native result in the response, but do not treat prose as a substitute for an explicitly requested media, JSON, or table deliverable.',
    `Only use these additional inputs when they are supplied: ${normalizeAuxiliaryAllowedInputs(
      profile.allowedInputs
    )
      .map((inputKind) => formatCanvasTargetAuxiliaryInput(inputKind))
      .join(', ')}.`,
    outputFormats.length === 1
      ? `The user requested this stage deliverable format: ${formatCanvasTargetAuxiliaryOutputFormat(outputFormats[0])}. Treat it as a hard output contract for this stage. For media formats, only an actual attachment or imageUrl/video/model3d URL counts as that media output. For JSON or table formats, return actual structured content or a matching file attachment. Do not describe a planned deliverable as completed. If the runtime cannot produce the requested deliverable, start with NOT_EXECUTABLE and explain the missing capability.`
      : outputFormats.length > 1
        ? `The user requested these stage deliverable formats: ${formatCanvasTargetAuxiliaryOutputFormats(outputFormats)}. Treat them as hard output contracts for this stage. For media formats, only actual attachments or imageUrl/video/model3d URLs count as those media outputs. For JSON or table formats, return actual structured content or matching file attachments. Do not describe planned deliverables as completed. If the runtime cannot produce requested deliverables, start with NOT_EXECUTABLE and explain the missing capability.`
        : null
  ]
    .filter(Boolean)
    .join(' ')
}
