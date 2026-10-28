// The selected LLM Party fixed file predates PEFT's clear_device_cache import.
// Generate a build-owned compatibility input; never edit vendor source files or
// discard its other pins. Fail closed if the audited upstream pin changes.
export function compatibleEmbeddedRequirements(text, relativePath) {
  if (relativePath.replaceAll('\\', '/') !== 'comfyui_LLM_party/requirements_fixed.txt') {
    return text
  }
  const lines = text.split(/\r?\n/)
  if (lines.some((line) => /^\s*(?:-|\.|\/|[A-Za-z]:|git\+|https?:)/.test(line))) {
    throw new Error(
      'Relocated LLM Party requirements contain path or pip directives; review required'
    )
  }
  if (lines.filter((line) => line.trim() === 'accelerate==0.30.1').length !== 1) {
    throw new Error('LLM Party Accelerate compatibility pin changed; review required')
  }
  return lines
    .map((line) => (line.trim() === 'accelerate==0.30.1' ? 'accelerate==1.15.0' : line))
    .join('\n')
}
