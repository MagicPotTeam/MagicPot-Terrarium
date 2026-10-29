import fs from 'node:fs'
import path from 'node:path'

// Build-owned requirements keep vendor checkouts immutable. Each exception is
// restricted to an audited input; a changed upstream declaration needs review.
export function compatibleEmbeddedRequirements(text, relativePath) {
  const normalizedPath = relativePath.replaceAll('\\', '/')
  const isLlmParty = normalizedPath === 'comfyui_LLM_party/requirements_fixed.txt'
  const isControlnetAux = normalizedPath === 'comfyui_controlnet_aux/requirements.txt'
  if (!isLlmParty && !isControlnetAux) return text

  const lines = text.split(/\r?\n/)
  if (lines.some((line) => /^\s*(?:-|\.|\/|[A-Za-z]:|git\+|https?:)/.test(line))) {
    throw new Error(
      'Relocated embedded requirements contain path or pip directives; review required'
    )
  }

  if (isControlnetAux) {
    // AlbumentationsX and the legacy distribution both own `albumentations/`.
    // transparent-background still requires the legacy distribution. Resolving
    // both can backtrack to albumentations 1.4.15 with an incompatible albucore,
    // and pip check cannot detect their overlapping Python files. Use the pair
    // already validated with our nodes: albumentations 2.0.8 pins albucore 0.0.24.
    // Only the two audited bare declarations are accepted (old and refreshed
    // ControlNet Aux). Do not silently discard future extras, bounds or markers.
    const declarations = lines.filter((line) => /^\s*albumentations/i.test(line))
    if (
      declarations.length !== 1 ||
      !['albumentations', 'albumentationsx'].includes(declarations[0].trim())
    ) {
      throw new Error(
        'ControlNet Aux Albumentations compatibility declaration changed; review required'
      )
    }
    return lines
      .map((line) => (line === declarations[0] ? 'albumentations==2.0.8' : line))
      .join('\n')
  }

  // The selected LLM Party fixed file predates PEFT's clear_device_cache import.
  // Retain every other pin and fail closed if the audited upstream pin changes.
  if (lines.filter((line) => line.trim() === 'accelerate==0.30.1').length !== 1) {
    throw new Error('LLM Party Accelerate compatibility pin changed; review required')
  }
  return lines
    .map((line) => (line.trim() === 'accelerate==0.30.1' ? 'accelerate==1.15.0' : line))
    .join('\n')
}

// pip's metadata consistency check does not detect two distributions writing
// the same import namespace. Verify the installed pair before the full smoke
// test, including duplicate metadata and later requirements reintroducing X.
export function validateEmbeddedAugmentationPackages(packages) {
  if (
    !Array.isArray(packages) ||
    packages.some(
      (item) => !item || typeof item.name !== 'string' || typeof item.version !== 'string'
    )
  ) {
    throw new Error('Invalid embedded augmentation package inventory')
  }
  const normalized = packages.map((item) => ({ ...item, name: item.name.toLowerCase() }))
  if (normalized.some((item) => item.name === 'albumentationsx')) {
    throw new Error('AlbumentationsX cannot share the embedded albumentations namespace')
  }
  const expected = { albumentations: '2.0.8', albucore: '0.0.24' }
  for (const [name, version] of Object.entries(expected)) {
    const matches = normalized.filter((item) => item.name === name)
    if (matches.length !== 1 || matches[0].version !== version) {
      throw new Error(`Expected exactly one embedded ${name}==${version}; review required`)
    }
  }
  return expected
}

// Each preparation owns a fresh directory. Retried installs never overwrite or
// reuse an earlier generated input, and leave evidence of interrupted attempts.
export function createEmbeddedRequirementsInput(file, relativePath, compatibilityRoot) {
  const original = fs.readFileSync(file, 'utf8')
  const compatible = compatibleEmbeddedRequirements(original, relativePath)
  if (compatible === original) return file
  fs.mkdirSync(compatibilityRoot, { recursive: true })
  const owned = fs.mkdtempSync(path.join(compatibilityRoot, 'requirements-'))
  const output = path.join(owned, 'requirements.txt')
  fs.writeFileSync(output, compatible, { flag: 'wx' })
  return output
}
