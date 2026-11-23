/**
 * Backtracking-free path glob matching for .gitignore rules and files.glob/grep patterns.
 * Untrusted patterns (any cloned repository's .gitignore, model-supplied globs) run on the
 * main process, so matching never compiles to a RegExp and never recurses: one segment is
 * matched with the greedy single-star scan, a whole path with a table over
 * (pattern item, path segment), O(items x segments), and runs of ** collapse into one item.
 */

/** One UTF-16 unit test inside a segment: a literal, ? (any), * or a bracket class. */
export type SegmentToken =
  | Readonly<{ kind: 'char'; value: string }>
  | Readonly<{ kind: 'any' }>
  | Readonly<{ kind: 'star' }>
  | Readonly<{
      kind: 'class'
      negated: boolean
      chars: string
      ranges: readonly (readonly [number, number])[]
    }>

/** A path item: one segment, or a run of ** matching at least `min` whole segments. */
export type PathGlobItem =
  | Readonly<{ kind: 'segment'; tokens: readonly SegmentToken[] }>
  | Readonly<{ kind: 'many'; min: number }>

const tokenMatches = (token: SegmentToken, char: string): boolean => {
  switch (token.kind) {
    case 'char':
      return token.value === char
    case 'any':
      return true
    case 'star':
      return false
    case 'class': {
      const code = char.charCodeAt(0)
      const hit =
        token.chars.includes(char) ||
        token.ranges.some(([low, high]) => code >= low && code <= high)
      return hit !== token.negated
    }
  }
}

/**
 * Greedy single-star scan: on a mismatch only the latest * is retried, so the cost is at
 * most O(tokens x length) and never exponential, however many stars the segment has.
 */
export function matchSegment(tokens: readonly SegmentToken[], value: string): boolean {
  let ti = 0,
    vi = 0,
    star = -1,
    mark = 0
  while (vi < value.length) {
    const token = tokens[ti]
    if (token && token.kind !== 'star' && tokenMatches(token, value[vi])) {
      ti++
      vi++
    } else if (token?.kind === 'star') {
      star = ti++
      mark = vi
    } else if (star >= 0) {
      ti = star + 1
      vi = ++mark
    } else return false
  }
  while (tokens[ti]?.kind === 'star') ti++
  return ti === tokens.length
}

/** Merge consecutive ** runs, so `**` repeated eight times costs the same as one. */
export function collapsePathGlob(items: readonly PathGlobItem[]): PathGlobItem[] {
  const out: PathGlobItem[] = []
  for (const item of items) {
    const previous = out[out.length - 1]
    if (item.kind === 'many' && previous?.kind === 'many')
      out[out.length - 1] = { kind: 'many', min: previous.min + item.min }
    else out.push(item)
  }
  return out
}

/** Whether the path segments match the items, filled bottom-up without recursion. */
export function matchPathGlob(
  items: readonly PathGlobItem[],
  segments: readonly string[]
): boolean {
  const size = segments.length + 1
  // next[ci]: the items after the current one match segments[ci..].
  let next = new Uint8Array(size)
  next[segments.length] = 1
  for (let pi = items.length - 1; pi >= 0; pi--) {
    const item = items[pi]
    const current = new Uint8Array(size)
    if (item.kind === 'many') {
      // reach[k]: next[j] holds for some j >= k.
      const reach = new Uint8Array(size)
      let suffix = 0
      for (let k = segments.length; k >= 0; k--) {
        suffix |= next[k]
        reach[k] = suffix
      }
      for (let ci = 0; ci + item.min <= segments.length; ci++) current[ci] = reach[ci + item.min]
    } else {
      for (let ci = 0; ci < segments.length; ci++)
        current[ci] = next[ci + 1] && matchSegment(item.tokens, segments[ci]) ? 1 : 0
    }
    next = current
  }
  return next[0] === 1
}

/** Tokens of a files.glob segment: only * and ? are special. */
export function simpleSegmentTokens(segment: string): SegmentToken[] {
  return segment
    .split('')
    .map((char): SegmentToken =>
      char === '*'
        ? { kind: 'star' }
        : char === '?'
          ? { kind: 'any' }
          : { kind: 'char', value: char }
    )
}

/** files.glob/grep pattern: `/`-separated, ** only as a whole segment (zero or more). */
export function compileSimplePathGlob(pattern: string): PathGlobItem[] {
  return collapsePathGlob(
    pattern
      .split('/')
      .map((segment): PathGlobItem =>
        segment === '**'
          ? { kind: 'many', min: 0 }
          : { kind: 'segment', tokens: simpleSegmentTokens(segment) }
      )
  )
}
