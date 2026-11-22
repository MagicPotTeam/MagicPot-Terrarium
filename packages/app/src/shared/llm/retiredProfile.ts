// Tombstones for removed browser-provider profiles. These are not runtime
// adapters: keeping old saved records inert prevents accidental API fallback.
const retiredBrowserKinds = new Set([
  ['chat', 'gpt', '-web'].join(''),
  ['chat', 'gpt', '-web-playwright'].join('')
])
export type RetirableProfile = {
  call_type?: string
  provider?: string
  model_name?: string
  auth_mode?: string
}

export function retiredProfileKind(profile?: RetirableProfile | null): string | undefined {
  if (!profile) return undefined
  for (const value of [profile.call_type, profile.provider, profile.model_name, profile.auth_mode]) {
    if (typeof value !== 'string') continue
    const kind = value.trim().toLowerCase()
    if (retiredBrowserKinds.has(kind)) return kind
  }
  return undefined
}

export function assertProfileNotRetired(profile: RetirableProfile): void {
  if (retiredProfileKind(profile)) {
    throw Object.assign(new Error('This browser-based model provider has been removed. Choose a supported API or Codex profile; saved conversations and login data have not been deleted.'), { code: 'LLM_PROFILE_RETIRED' })
  }
}
