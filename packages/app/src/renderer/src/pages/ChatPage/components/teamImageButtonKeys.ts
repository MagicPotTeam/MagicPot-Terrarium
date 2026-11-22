export type TeamImageButtonKeyState = {
  readonly nextId: number
  readonly entries: readonly { readonly url: string; readonly key: string }[]
}

/** Match the old `${index}:${attachment.url}` identity without embedding URL data in keys. */
export function reconcileTeamImageButtonKeys(
  previous: TeamImageButtonKeyState,
  urls: readonly string[]
): TeamImageButtonKeyState {
  if (previous.entries.length === urls.length && urls.every((url, index) => previous.entries[index].url === url)) return previous
  let nextId = previous.nextId
  const entries = urls.map((url, index) => {
    const prior = previous.entries[index]
    return prior?.url === url ? prior : { url, key: `team-image:${nextId++}` }
  })
  return { nextId, entries }
}
