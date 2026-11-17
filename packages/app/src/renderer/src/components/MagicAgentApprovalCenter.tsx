import { createPortal } from 'react-dom'
import { matchTeamApproval, useTeamApprovalSurfaces } from './teamApprovalSurface'
import React, { useCallback, useEffect, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography
} from '@mui/material'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { MagicAgentPlatformPendingApproval } from '@shared/api/svcMagicAgentPlatform'
import { ChatPromptCard } from '../pages/ChatPage/components/ChatPromptCard'
import { api } from '../utils/windowUtils'

const POLL_MS = 1000

// Each known tool maps to its label under agent_workspace.approval.actions.
const actionLabelKeys = {
  memory_write: 'memory_write',
  scratchpad: 'scratchpad',
  'comfyui.workflow.submit': 'comfyui_workflow_submit',
  'canvas.export': 'canvas_export',
  'image.create': 'image_create',
  'video.create': 'video_create',
  'asset.import': 'asset_import',
  'mcp.tool.call': 'mcp_tool_call',
  'agent.terminal.run': 'agent_terminal_run',
  'terminal.run': 'terminal_run',
  'python.run': 'python_run',
  'python.background': 'python_background',
  'commands.background': 'commands_background',
  'files.write': 'files_write',
  'files.edit': 'files_edit',
  'files.patch': 'files_patch',
  'files.multi-edit': 'files_multi_edit',
  'files.json.write': 'files_json_write',
  'files.snapshot.restore': 'files_snapshot_restore',
  'git.checkout': 'git_checkout',
  'git.add': 'git_add',
  'git.commit': 'git_commit'
} as const

// Each known input field maps to its label under agent_workspace.approval.parameters.
// The order here is the display order: the fields that define the action (the code, command,
// content or path it runs or writes) come first, so they are in view without scrolling; the
// fields that only qualify it (arguments, working directory, namespace, revisions) follow.
const parameterLabelKeys = {
  code: 'code',
  command: 'command',
  content: 'content',
  path: 'path',
  targetPath: 'target_path',
  sourcePath: 'source_path',
  outputPath: 'output_path',
  action: 'action',
  key: 'key',
  value: 'value',
  prompt: 'prompt',
  url: 'url',
  workflow: 'workflow',
  qAppKey: 'q_app_key',
  toolName: 'tool_name',
  name: 'name',
  model: 'model',
  args: 'args',
  cwd: 'cwd',
  namespace: 'namespace',
  namespaceGeneration: 'namespace_generation',
  namespaceCreation: 'namespace_creation',
  preimage: 'preimage',
  create: 'create',
  operationId: 'operation_id',
  conversationId: 'conversation_id',
  expectedRevision: 'expected_revision',
  clearScope: 'clear_scope'
} as const

// Null-prototype lookups: an input key such as "constructor", "toString" or "__proto__" is an
// ordinary field name here, never a member inherited from Object.prototype.
const actionLabels: ReadonlyMap<string, (typeof actionLabelKeys)[keyof typeof actionLabelKeys]> =
  new Map(Object.entries(actionLabelKeys))
const parameterLabels: ReadonlyMap<string, (typeof parameterLabelKeys)[keyof typeof parameterLabelKeys]> =
  new Map(Object.entries(parameterLabelKeys))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** The value of an own field of `record`, or undefined; never an inherited member. */
const ownValue = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined

const TRUNCATE_AT = 480
// A value is shown on at most this many lines, so a value made of line breaks can neither push
// the other parameters out of view nor line up text that reads like a further row.
const MAX_VALUE_LINES = 6
// A field name without a label is cut after this many characters, so it cannot push the other
// parameters out of view either.
const NAME_TRUNCATE_AT = 120
const LINE_BREAKS = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/g
// Characters that draw as blank space: tab, spaces (U+0020 is handled apart), the braille blank,
// the Hangul and Khmer fillers and the musical null notehead (U+1D159, category So, drawn with no
// ink but a real advance).
const BLANK_DRAWN = /[\t\p{Zs}\u2800\u3164\uffa0\u115f\u{1d159}]|\u1160|\u17b4|\u17b5/u
// Characters that draw nothing or change how the text around them reads: control characters,
// format characters (bidi controls, zero-width characters, word joiner, BOM, soft hyphen, the
// U+E0000 tag block), private-use, unassigned and lone surrogate code points, default-ignorable
// code points and variation selectors.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]/u
const COMBINING_MARK = /^\p{M}$/u
// A line that draws blank: blank-drawing characters and combining marks only (or nothing).
const BLANK_LINE = /^(?:[\t\p{Zs}\p{M}\u2800\u3164\uffa0\u115f\u{1d159}]|\u1160)*$/u
// A run of more blank characters than this (or of one hidden character repeated, or of
// combining marks on one base) is shown as one marker such as ⟦460 × U+2800⟧, so blank padding
// can neither push the rest of a value out of view nor fill it, and stacked marks cannot draw
// over other text.
const MAX_BLANK_RUN = 3
// More blank lines in a row than this are shown as one marker line, so blank lines cannot push
// the rest of a value past the line limit either.
const MAX_BLANK_LINES = 2
// The opening bracket of that marker; inside names and values it is always escaped, so a marker
// is never text the model wrote. Its lookalike U+301A and the lookalikes of the backslash that
// starts an escape are escaped as well.
const MARKER_OPEN = '\u27e6'
const FORGED_MARKUP = /[\u27e6\u301a\u29f5\u29f9\ufe68\uff3c\u2216]/u

const escapedCharacter = (character: string): string => `\\u{${character.codePointAt(0)!.toString(16)}}`
const codePointName = (character: string): string =>
  `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
/** The marker that stands for `count` collapsed characters, naming their first 4 code points. */
const collapsedMarker = (count: number, seen: ReadonlySet<string>): string =>
  `${MARKER_OPEN}${count} \u00d7 ${[...seen].slice(0, 4).map(codePointName).join('/')}${seen.size > 4 ? '/\u2026' : ''}\u27e7`

/** The first `limit` code points of `text` (never half of a surrogate pair), or null if it is not longer. */
const cutCodePoints = (text: string, limit: number): string | null => {
  // A code point takes at most two code units, so this prefix holds more than `limit` of them
  // whenever the text does.
  const head = Array.from(text.slice(0, limit * 2 + 1))
  return head.length > limit ? head.slice(0, limit).join('') : null
}

type VisibleText = { text: string; changed: boolean; cut: boolean; size: number }
type VisibleRules = {
  /** Whether the character draws blank; a long run of such characters becomes a marker. */
  blank: (character: string) => boolean
  /** Whether the character draws nothing; a long run of one such character becomes a marker. */
  hidden: (character: string) => boolean
  /** The escaped form of a character outside a collapsed run, or null to show it as it is. */
  escape: (character: string, text: string, index: number) => string | null
}

/**
 * `text` as a row shows it: a run of more than MAX_BLANK_RUN blank characters (with any
 * combining marks among them), of one hidden character or of combining marks becomes one marker
 * with its count and code points; every other character the rules name is escaped, one by one
 * (a combining mark on an escaped character too); and the result is cut after `limit` code
 * points (never inside a marker, an escape, a surrogate pair or before a combining mark).
 * `changed` tells that something was collapsed or escaped; `size` is the code points shown.
 */
const visibleText = (text: string, limit: number, rules: VisibleRules): VisibleText => {
  const pieces: string[] = []
  let size = 0
  let changed = false
  let cut = false
  let lastEscaped = false
  const push = (piece: string, escaped: boolean): boolean => {
    // Escapes and markers are ASCII or BMP text, so their length is their code point count.
    const points = escaped ? piece.length : 1
    if (size + points > limit) {
      cut = true
      return false
    }
    pieces.push(piece)
    size += points
    lastEscaped = escaped
    if (escaped) changed = true
    return true
  }
  // Never leave a base character without the combining marks that follow it.
  const dropBase = (): void => {
    while (pieces.length && COMBINING_MARK.test(pieces[pieces.length - 1])) pieces.pop()
    if (pieces.length && Array.from(pieces[pieces.length - 1]).length === 1) pieces.pop()
  }
  const characterAt = (at: number): string => String.fromCodePoint(text.codePointAt(at)!)
  let index = 0
  while (index < text.length) {
    const character = characterAt(index)
    const mark = COMBINING_MARK.test(character)
    let end = index + character.length
    let count = 1
    const seen = new Set([character])
    let collapse = false
    if (rules.blank(character)) {
      // Combining marks among blank characters draw (almost) nothing either, so they belong to
      // the run: they cannot split it into short runs that are left as they are.
      let drawsBlank = character !== ' '
      while (end < text.length) {
        const next = characterAt(end)
        if (!rules.blank(next) && !COMBINING_MARK.test(next)) break
        count++
        if (next !== ' ') drawsBlank = true
        if (seen.size <= 4) seen.add(next)
        end += next.length
      }
      // A run of plain spaces stays as it is (code indentation).
      collapse = drawsBlank && count > MAX_BLANK_RUN
    } else if (rules.hidden(character)) {
      // Only one hidden character repeated is collapsed; different ones (such as tag characters
      // that spell out text) are escaped one by one.
      while (end < text.length && text.startsWith(character, end)) {
        count++
        end += character.length
      }
      collapse = count > MAX_BLANK_RUN
    } else if (mark) {
      while (end < text.length && COMBINING_MARK.test(characterAt(end))) {
        const next = characterAt(end)
        count++
        if (seen.size <= 4) seen.add(next)
        end += next.length
      }
      collapse = count > MAX_BLANK_RUN
    }
    if (collapse) {
      if (!push(collapsedMarker(count, seen), true)) {
        if (mark) dropBase()
        break
      }
    } else {
      let at = index
      while (at < end) {
        const item = characterAt(at)
        const itemMark = COMBINING_MARK.test(item)
        const escaped = rules.escape(item, text, at) ?? (itemMark && lastEscaped ? escapedCharacter(item) : null)
        if (!push(escaped ?? item, escaped !== null)) {
          if (itemMark) dropBase()
          break
        }
        at += item.length
      }
      if (at < end) break
    }
    index = end
  }
  return { text: pieces.join(''), changed, cut, size }
}

const valueRules: VisibleRules = {
  blank: (character) => character === ' ' || BLANK_DRAWN.test(character),
  hidden: (character) => character !== '\t' && HIDDEN.test(character),
  escape: (character, text, index) =>
    // Every blank-drawing character but U+0020 and the tab is escaped even in a short run, so
    // short runs cannot add up to padding that hides the rest of a value.
    (character !== ' ' && character !== '\t' && (BLANK_DRAWN.test(character) || HIDDEN.test(character))) ||
    FORGED_MARKUP.test(character) ||
    // A backslash that starts what reads like an escape is escaped too, so an escape is never
    // text the model wrote.
    (character === '\\' && text.startsWith('u{', index + 1))
      ? escapedCharacter(character)
      : null
}

/** Reads `text` line by line, splitting at every kind of line break, without splitting it all. */
const lineReader = (text: string): (() => string | undefined) => {
  const breaks = text.matchAll(LINE_BREAKS)
  let start = 0
  let done = false
  return () => {
    if (done) return undefined
    const next = breaks.next()
    if (next.done) {
      done = true
      return text.slice(start)
    }
    const line = text.slice(start, next.value.index)
    start = next.value.index + next.value[0].length
    return line
  }
}

/**
 * The text a row shows for a value: at most MAX_VALUE_LINES lines and TRUNCATE_AT characters,
 * line breaks of any kind shown as plain line breaks, more than MAX_BLANK_LINES blank lines in a
 * row shown as one marker line, blank runs collapsed and hidden characters escaped. `truncated`
 * asks for the form that points to the full request in Details; `changed` for the form that says
 * characters are shown as codes.
 */
const shownValue = (text: string): { text: string; truncated: boolean; changed: boolean } => {
  const nextLine = lineReader(text)
  const lines: Array<{ text: string } | { marker: string }> = []
  let truncated = false
  let line = nextLine()
  while (line !== undefined) {
    if (lines.length === MAX_VALUE_LINES) {
      truncated = true
      break
    }
    if (!BLANK_LINE.test(line)) {
      lines.push({ text: line })
      line = nextLine()
      continue
    }
    // A run of blank lines: the lines and the line breaks between them.
    const first: string[] = [line]
    let count = 0
    const seen = new Set<string>()
    const take = (characters: string): void => {
      for (const character of characters) {
        count++
        if (seen.size <= 4) seen.add(character)
      }
    }
    take(line)
    let blankLines = 1
    line = nextLine()
    while (line !== undefined && BLANK_LINE.test(line)) {
      if (first.length <= MAX_BLANK_LINES) first.push(line)
      blankLines++
      take('\n')
      take(line)
      line = nextLine()
    }
    if (blankLines > MAX_BLANK_LINES) lines.push({ marker: collapsedMarker(count, seen) })
    else for (const blank of first) {
      if (lines.length === MAX_VALUE_LINES) {
        truncated = true
        break
      }
      lines.push({ text: blank })
    }
    if (truncated) break
  }
  const isBlankLine = (item: (typeof lines)[number]): boolean => 'text' in item && BLANK_LINE.test(item.text)
  if (truncated) while (lines.length > 1 && isBlankLine(lines[lines.length - 1])) lines.pop()
  const pieces: string[] = []
  let size = 0
  let changed = false
  for (const [at, item] of lines.entries()) {
    const room = TRUNCATE_AT - size - (at ? 1 : 0)
    const shown =
      'marker' in item
        ? item.marker.length <= room
          ? { text: item.marker, changed: true, cut: false, size: item.marker.length }
          : { text: '', changed: false, cut: true, size: 0 }
        : visibleText(item.text, Math.max(room, 0), valueRules)
    if (room < 0 || (shown.cut && !shown.text && at)) {
      truncated = true
      break
    }
    pieces.push(shown.text)
    size += shown.size + (at ? 1 : 0)
    if (shown.changed) changed = true
    if (shown.cut) {
      truncated = true
      break
    }
  }
  return { text: pieces.join('\n'), truncated, changed }
}

// What Details shows: the request as JSON with every hidden or blank-drawing character written
// as a JSON \u escape (such characters only occur inside JSON strings), so the full request
// reads exactly as it is and stays valid JSON.
const DETAILS_ESCAPE = /(?![\t\n ])(?:[\p{Zs}\u2800\u3164\uffa0\u115f\u{1d159}]|\u1160|\u17b4|\u17b5|[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}])/gu
const detailsJson = (value: unknown): string =>
  JSON.stringify(value, null, 2).replace(DETAILS_ESCAPE, (character) =>
    Array.from({ length: character.length }, (_, unit) => `\\u${character.charCodeAt(unit).toString(16).padStart(4, '0')}`).join('')
  )

const parameterText = (value: unknown): string => {
  if (typeof value === 'string') return value
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return json
  } catch {
    // BigInt or a cycle: fall back to the plain string form below.
  }
  try {
    return String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

// A character that can hide or disguise a field name: control and format characters (bidi
// overrides, zero-width), line and paragraph separators, spaces other than U+0020, characters
// that draw blank or nothing, the marker bracket and its lookalikes, and the quote and backslash
// used by the quoted form below.
const UNCLEAR_NAME_CHARACTER = /[\p{C}\p{Zl}\p{Zp}"\\\u27e6\u301a\u29f5\u29f9\ufe68\uff3c\u2216\u2800\u3164\uffa0\u115f\u{1d159}\p{Default_Ignorable_Code_Point}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]|\u1160|\u17b4|\u17b5|(?! )\p{Zs}/u
// A name with a colon could read as "label: value" inside the row; it is quoted, not escaped.
const NAME_SEPARATOR = /[:：]/u
// A name with a character outside printable ASCII and the Han script may hold a letter that draws
// like another one and that no table below lists (Katakana U+30A8 for 工, Cherokee U+13E2 or Lisu
// U+A4D1 for P, the small capital U+1D00 for A); it is quoted, so it never reads as a label.
const OTHER_SCRIPT = /[^\x20-\x7e\p{Script=Han}]/u

// Letters of other scripts that draw like a Latin letter, as pairs of the letter and the Latin
// letter it draws like (Cyrillic, Greek, Armenian and a few Latin ones outside ASCII).
const LOOKALIKES: ReadonlyMap<string, string> = new Map(
  Array.from('\u0410a\u0412b\u0415e\u0405s\u0406l\u0408j\u041ak\u041cm\u041dh\u041eo\u0420p\u0421c\u0422t\u0425x\u0423y\u04aey\u0430a\u0435e\u0455s\u0456i\u0458j\u043eo\u0440p\u0441c\u0443y\u0445x\u04bbh\u0501d\u051bq\u051dw\u04cfl\u04afy\u043fn\u0433r\u044cb\u0391a\u0392b\u0395e\u0396z\u0397h\u0399l\u039ak\u039cm\u039dn\u039fo\u03a1p\u03a4t\u03a5y\u03a7x\u03b1a\u03bfo\u03bdv\u03c1p\u03b9i\u03bak\u03c5u\u03c7x\u03b5e\u03b7n\u0585o\u057du\u0570h\u0578n\u0581g\u0566q\u0131i\u0261g\u01c0l'.matchAll(/(.)(.)/gu), ([, letter, latin]) => [letter, latin])
)
const ASCII_LOOKALIKES: Readonly<Record<string, string>> = { i: 'l', '1': 'l', '|': 'l', '0': 'o' }

/**
 * What a name reads as: compatibility forms folded (NFKD: fullwidth letters, CJK compatibility
 * ideographs such as U+F937, ligatures), combining marks dropped, lookalike letters of other
 * scripts and case folded, the
 * letters that are hard to tell apart (I, l, 1, |; O, 0; rn, m; vv, w) merged, and runs of spaces
 * merged. Two names with the same skeleton can be taken for each other.
 */
const nameSkeleton = (name: string): string => {
  const lookalike = (text: string): string => Array.from(text, (character) => LOOKALIKES.get(character) ?? character).join('')
  const folded = name.normalize('NFKD').replace(/\p{M}/gu, '')
  return Array.from(lookalike(lookalike(folded).toLowerCase()), (character) => ASCII_LOOKALIKES[character] ?? character)
    .join('')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/ +/g, ' ')
    .trim()
}

/** A character outside ASCII that reads as another one or adds a mark to one (see nameSkeleton). */
const isLookalikeCharacter = (character: string): boolean =>
  character > '\u007f' && (LOOKALIKES.has(character) || character.normalize('NFKD') !== character || /\p{M}/u.test(character))

const nameRules: VisibleRules = {
  blank: valueRules.blank,
  hidden: (character) =>
    character !== '"' && character !== '\\' && !FORGED_MARKUP.test(character) && UNCLEAR_NAME_CHARACTER.test(character),
  escape: (character) =>
    character === '"' || character === '\\'
      ? `\\${character}`
      : character !== ' ' && UNCLEAR_NAME_CHARACTER.test(character)
        ? escapedCharacter(character)
        : null
}

// In a name quoted because it reads like a known label, the characters that make it read so are
// escaped too, so the quoted name shows how it differs from the label.
const lookalikeNameRules: VisibleRules = {
  blank: nameRules.blank,
  hidden: nameRules.hidden,
  escape: (character, text, index) =>
    nameRules.escape(character, text, index) ?? (isLookalikeCharacter(character) ? escapedCharacter(character) : null)
}

/**
 * How a field without a label is named in the approval. It is shown as sent, unless it could be
 * misread: then it is quoted with its hidden characters escaped and long blank runs collapsed
 * (empty names, surrounding spaces, invisible or control characters, a colon, a character outside
 * ASCII and the Han script, and a name whose
 * skeleton equals that of a known field's label in any shipped language or of its key, such as
 * a fullwidth, compatibility-ideograph, Cyrillic or other-case form of it). `cut` tells that the
 * name was cut after NAME_TRUNCATE_AT characters.
 */
const unlabelledParameterName = (key: string, knownSkeletons: ReadonlySet<string>): { text: string; cut: boolean } => {
  const lookalike = knownSkeletons.has(nameSkeleton(key))
  if (
    key &&
    key === key.trim() &&
    !UNCLEAR_NAME_CHARACTER.test(key) &&
    !NAME_SEPARATOR.test(key) &&
    !OTHER_SCRIPT.test(key) &&
    !lookalike
  ) {
    const cutName = cutCodePoints(key, NAME_TRUNCATE_AT)
    return cutName === null ? { text: key, cut: false } : { text: cutName, cut: true }
  }
  const quoted = visibleText(key, NAME_TRUNCATE_AT - 1, lookalike ? lookalikeNameRules : nameRules)
  return quoted.cut ? { text: `"${quoted.text}`, cut: true } : { text: `"${quoted.text}"`, cut: false }
}

/**
 * The skeletons of every known field's key and of its label in each shipped language, which an
 * unlabelled name must not share.
 */
const labelSkeletons = (t: TFunction<'translation'>, languages: readonly string[]): ReadonlySet<string> => {
  const skeletons = new Set<string>()
  for (const [key, labelKey] of parameterLabels) {
    skeletons.add(nameSkeleton(key))
    for (const lng of languages) skeletons.add(nameSkeleton(t(`agent_workspace.approval.parameters.${labelKey}`, { lng })))
  }
  return skeletons
}

/** Text from the request shown outside a row (a tool name, a task step): hidden characters escaped. */
const shownText = (text: string): string => {
  const shown = visibleText(text, NAME_TRUNCATE_AT, valueRules)
  return shown.cut ? `${shown.text}\u2026` : shown.text
}

const approvalDisplay = (
  approval: MagicAgentPlatformPendingApproval,
  t: TFunction<'translation'>,
  knownSkeletons: ReadonlySet<string>
) => {
  // Only use the redacted request supplied by the trusted main-process service.
  const redacted = isRecord(approval.request) ? approval.request : {}
  const request = isRecord(redacted.request) ? redacted.request : {}
  const target = isRecord(request.target) ? request.target : {}
  const targetId = typeof target.id === 'string' ? target.id.trim() : ''
  const toolName = targetId.replace(
    /^(?:magicagent\.platform\.tool\.creative\.|magicagent\.creative\.|creative\.)/,
    ''
  )
  const input = isRecord(request.input) ? request.input : {}
  // Every own field of the input is listed before the person decides: the known ones in the
  // order of parameterLabelKeys, then the rest in the order they were sent.
  const keys = Object.keys(input)
  const orderedKeys = [
    ...[...parameterLabels.keys()].filter((key) => Object.hasOwn(input, key)),
    ...keys.filter((key) => !parameterLabels.has(key))
  ]
  const labelOf = (key: string): string | undefined => {
    const labelKey = parameterLabels.get(key)
    return labelKey === undefined ? undefined : t(`agent_workspace.approval.parameters.${labelKey}`)
  }
  // The tool is looked up by its name as sent; only what is shown of it is escaped.
  const actionLabel = actionLabels.get(toolName)
  return {
    toolName: toolName ? shownText(toolName) : t('agent_workspace.approval.tool_name_missing'),
    action: toolName
      ? actionLabel !== undefined
        ? t(`agent_workspace.approval.actions.${actionLabel}`)
        : shownText(toolName)
      : t('agent_workspace.approval.pending_action'),
    input,
    parameters: orderedKeys.map((key) => {
      const value = shownValue(parameterText(ownValue(input, key)))
      const labelled = labelOf(key)
      const name = labelled === undefined ? unlabelledParameterName(key, knownSkeletons) : { text: labelled, cut: false }
      return {
        key,
        label: name.cut ? t('agent_workspace.approval.truncated', { text: name.text }) : name.text,
        // Whenever the row does not show the value as it is, it points to the full request.
        text: value.truncated
          ? t('agent_workspace.approval.truncated', { text: value.text })
          : value.changed
            ? t('agent_workspace.approval.escaped', { text: value.text })
            : value.text
      }
    })
  }
}

// A value is drawn at most this many lines high, so one value can never push the rows after it
// (or the buttons) out of view, whatever its characters draw like.
const VALUE_LINES = 6

/**
 * A value drawn at most VALUE_LINES lines high. When its text is taller, a visible cue below it
 * says so and opens the rest in place.
 */
const ClampedValue: React.FC<{
  text: string
  lineHeight: number
  kind: 'parameter' | 'note'
}> = ({ text, lineHeight, kind }) => {
  const { t } = useTranslation()
  const ref = React.useRef<HTMLElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element || expanded) return
    const measure = (): void => setOverflowing(element.scrollHeight > element.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text, expanded])
  return (
    <>
      <Box
        component="span"
        ref={ref}
        data-approval-parameter-value={kind === 'parameter' ? '' : undefined}
        data-approval-note={kind === 'note' ? '' : undefined}
        data-approval-clamped={expanded ? undefined : ''}
        sx={{
          display: 'block',
          textIndent: 0,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          // Isolated from the row, and drawn in the order the characters are sent: right-to-left
          // letters cannot reorder the numbers and words around them.
          unicodeBidi: 'isolate-override',
          direction: 'ltr',
          lineHeight: `${lineHeight}px`,
          maxHeight: expanded ? 'none' : `${lineHeight * VALUE_LINES}px`,
          overflow: 'hidden'
        }}
      >
        {text}
      </Box>
      {overflowing && !expanded ? (
        <Box
          component="button"
          type="button"
          data-approval-more=""
          onClick={() => setExpanded(true)}
          sx={{
            display: 'block',
            m: 0,
            mt: '2px',
            p: 0,
            border: 0,
            bgcolor: 'transparent',
            color: 'primary.main',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: 12,
            lineHeight: '16px',
            textIndent: 0,
            textDecoration: 'underline'
          }}
        >
          {t('agent_workspace.approval.show_more')}
        </Box>
      ) : null}
    </>
  )
}

export default function MagicAgentApprovalCenter(): React.JSX.Element | null {
  const [approvals, setApprovals] = useState<MagicAgentPlatformPendingApproval[]>([])
  const [busy, setBusy] = useState(false)
  const { t, i18n } = useTranslation()
  // The shipped languages, whose labels a field name must not read like.
  const shipped = Object.keys(i18n.options?.resources ?? {})
  const languages = (shipped.length ? shipped : [i18n.language]).join('\u0000')
  // A name is compared with the labels of every shipped language, not only the shown one, and
  // with the keys themselves; built once per language, not on every poll.
  const knownSkeletons = React.useMemo(() => labelSkeletons(t, languages.split('\u0000')), [t, languages])

  const resolving=React.useRef(false)
  const refreshEpoch=React.useRef(0)
  const refresh = useCallback(async () => {
    const epoch=++refreshEpoch.current
    try {
      const result = await api().svcMagicAgentPlatform.listPendingApprovals({})
      if(epoch===refreshEpoch.current)setApprovals(result.approvals)
    } catch {
      // Keep current requests visible during transient transport failure.
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const surfaces=useTeamApprovalSurfaces()
  const inline=approvals.map(approval=>({approval,surface:surfaces.find(surface=>surface.element.isConnected&&matchTeamApproval(approval.request,surface))})).filter(item=>item.surface)
  useEffect(()=>{surfaces.forEach(surface=>surface.onWaiting(new Set(inline.filter(item=>item.surface===surface).map(item=>matchTeamApproval(item.approval.request,surface)!))))},[approvals,surfaces])
  const approval = approvals.find(item=>!inline.some(entry=>entry.approval===item)) ?? inline[0]?.approval
  if (!approval) return null
  const display = approvalDisplay(approval, t, knownSkeletons)

  const resolve = async (approved: boolean, selected = approval): Promise<void> => {
    if(resolving.current)return
    resolving.current=true
    ++refreshEpoch.current
    setBusy(true)
    setApprovals((current) => current.filter((item) => item.approvalId !== selected.approvalId))
    try {
      await api().svcMagicAgentPlatform.resolvePendingApproval({
        approvalId: selected.approvalId,
        expectedRevision: selected.revision,
        approved
      })
      await refresh()
    } catch {
      await refresh()
    } finally {
      resolving.current=false
      setBusy(false)
    }
  }

  const inlineCards=inline.map(({approval:pending,surface})=>{
    const shown = approvalDisplay(pending, t, knownSkeletons)
    const note = ownValue(shown.input, 'value')
    const isNote = shown.toolName === 'scratchpad' && ownValue(shown.input, 'action') === 'set'
    // A note card shows the note itself as its prompt; every other field is listed below it.
    // A note that is not text is not the prompt, so its value stays in the list. The prompt is
    // the note's own row, so it is shown in the same capped and escaped form as every value.
    const noteRow = isNote && typeof note === 'string' ? shown.parameters.find(parameter => parameter.key === 'value') : undefined
    const detailParameters = noteRow ? shown.parameters.filter(parameter => parameter !== noteRow) : shown.parameters
    const member = surface!.members.get(matchTeamApproval(pending.request,surface!)!)
    // Presentation only: a prompt card at the end of the member's team transcript. Which
    // approval is shown here and what the buttons resolve are decided above.
    return createPortal(<Box key={pending.approvalId} data-approval-id={pending.approvalId} data-approval-revision={pending.revision} sx={{minWidth:0}}>
      <ChatPromptCard
        testId="team-approval-card"
        icon={<WarningAmberIcon aria-hidden="true" />}
        accent="warning"
        title={isNote ? t('agent_workspace.approval.member_wants_note', { member }) : t('agent_workspace.approval.member_requests_action', { member })}
        prompt={isNote ? noteRow ? <ClampedValue kind="note" lineHeight={20} text={noteRow.text} /> : t('agent_workspace.approval.note_missing') : shown.action}
        detail={!detailParameters.length ? undefined : <>{detailParameters.map(parameter => <Box key={parameter.key} component="span" data-approval-parameter={parameter.key} sx={{display:'block',pl:'1em',textIndent:'-1em'}}><Box component="span" data-approval-parameter-label="" sx={{fontWeight:600,unicodeBidi:'isolate-override',direction:'ltr'}}>{parameter.label}</Box>: <Box component="span" sx={{display:'inline-block',verticalAlign:'top',maxWidth:'100%',textIndent:0}}><ClampedValue kind="parameter" lineHeight={18} text={parameter.text} /></Box></Box>)}</>}
        options={[
          { key: 'approve', label: t('agent_workspace.approval.approve'), primary: true, disabled: busy, onSelect: () => void resolve(true, pending) },
          { key: 'deny', label: t('agent_workspace.approval.deny'), disabled: busy, onSelect: () => void resolve(false, pending) }
        ]}
      >
        <Box component="details" sx={{px:'4px',pb:'8px',color:'text.secondary',fontSize:12,'& summary':{cursor:'pointer',fontSize:12,lineHeight:'16px'}}}><summary>{t('agent_workspace.approval.details')}</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'16rem',overflow:'auto',m:0,mt:'4px',fontFamily:'monospace',fontSize:11,lineHeight:'16px'}}>{detailsJson(pending.request)}</Typography></Box>
      </ChatPromptCard>
    </Box>,surface!.element,pending.approvalId)
  })
  if(inline.some(item=>item.approval===approval))return <>{inlineCards}</>
  return (<>{inlineCards}
    <Dialog open aria-labelledby="magic-agent-approval-title">
      <DialogTitle id="magic-agent-approval-title">{t('agent_workspace.approval.dialog_title')}</DialogTitle>
      {/* Keyed by the approval, so what was opened for one approval (a value shown in full, the
          Details) is never carried over to the next one. */}
      <DialogContent key={approval.approvalId}>
        <Typography fontWeight={600}>{display.action}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t('agent_workspace.approval.tool', { name: display.toolName })}
        </Typography>
        {approval.graphContext ? (
          <Typography variant="body2" color="text.secondary">
            {t('agent_workspace.approval.task_step', {
              runId: shownText(String(approval.graphContext.runId)),
              nodeId: shownText(String(approval.graphContext.nodeId))
            })}
          </Typography>
        ) : null}
        <Box component="dl" sx={{ m: 0, mt: 2 }}>
          {display.parameters.map((parameter) => (
            <React.Fragment key={parameter.key}>
              <Typography component="dt" variant="body2" fontWeight={600} sx={{ overflowWrap: 'anywhere', unicodeBidi: 'isolate-override', direction: 'ltr' }}>
                {parameter.label}
              </Typography>
              <Typography
                component="dd"
                variant="body2"
                sx={{
                  ml: 0,
                  mb: 1,
                  pl: 1,
                  borderLeft: 2,
                  borderColor: 'divider',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  unicodeBidi: 'isolate'
                }}
              >
                <ClampedValue kind="parameter" lineHeight={20} text={parameter.text} />
              </Typography>
            </React.Fragment>
          ))}
        </Box>
        <Box component="details" sx={{ mt: 2 }}>
          <Box component="summary" sx={{ cursor: 'pointer' }}>
            {t('agent_workspace.approval.full_request')}
          </Box>
          <Box
            component="pre"
            sx={{ maxWidth: 640, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap' }}
          >
            {detailsJson(approval.request)}
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={() => void resolve(false)}>
          {t('agent_workspace.approval.deny')}
        </Button>
        <Button disabled={busy} variant="contained" onClick={() => void resolve(true)}>
          {t('agent_workspace.approval.allow_once')}
        </Button>
      </DialogActions>
    </Dialog></>
  )
}
