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
// The order here is the display order.
const parameterLabelKeys = {
  content: 'content',
  namespace: 'namespace',
  namespaceGeneration: 'namespace_generation',
  namespaceCreation: 'namespace_creation',
  preimage: 'preimage',
  create: 'create',
  operationId: 'operation_id',
  conversationId: 'conversation_id',
  action: 'action',
  key: 'key',
  value: 'value',
  expectedRevision: 'expected_revision',
  clearScope: 'clear_scope',
  prompt: 'prompt',
  model: 'model',
  path: 'path',
  targetPath: 'target_path',
  sourcePath: 'source_path',
  outputPath: 'output_path',
  url: 'url',
  workflow: 'workflow',
  qAppKey: 'q_app_key',
  command: 'command',
  args: 'args',
  cwd: 'cwd',
  code: 'code',
  toolName: 'tool_name',
  name: 'name'
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
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/
// Characters that draw as blank space: tab, spaces (U+0020 is handled apart), the braille blank
// and the Hangul and Khmer fillers.
const BLANK_DRAWN = /[\t\p{Zs}\u2800\u3164\uffa0\u115f]|\u1160|\u17b4|\u17b5/u
// Characters that draw nothing or change how the text around them reads: control characters,
// format characters (bidi controls, zero-width characters, word joiner, BOM, soft hyphen, the
// U+E0000 tag block), private-use, unassigned and lone surrogate code points, default-ignorable
// code points and variation selectors.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]/u
// A run of more blank or hidden characters than this is shown as one marker such as
// ⟦460 × U+2800⟧, so blank padding can neither push the rest of a value out of view nor fill it.
const MAX_BLANK_RUN = 3
// The opening bracket of that marker; inside names and values it is always escaped, so a marker
// is never text the model wrote.
const MARKER_OPEN = '\u27e6'

const escapedCharacter = (character: string): string => `\\u{${character.codePointAt(0)!.toString(16)}}`
const codePointName = (character: string): string =>
  `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`

/** The first `limit` code points of `text` (never half of a surrogate pair), or null if it is not longer. */
const cutCodePoints = (text: string, limit: number): string | null => {
  // A code point takes at most two code units, so this prefix holds more than `limit` of them
  // whenever the text does.
  const head = Array.from(text.slice(0, limit * 2 + 1))
  return head.length > limit ? head.slice(0, limit).join('') : null
}

type VisibleText = { text: string; changed: boolean; cut: boolean }
type VisibleRules = {
  /** Whether the character belongs to a run that may be collapsed into a marker. */
  inRun: (character: string) => boolean
  /** The escaped form of a character outside a collapsed run, or null to show it as it is. */
  escape: (character: string, text: string, index: number) => string | null
}

/**
 * `text` as a row shows it: runs of more than MAX_BLANK_RUN blank or hidden characters become one
 * marker with their count and code points, the other characters the rules name are escaped, and
 * the result is cut after `limit` code points (never inside a marker, an escape, a surrogate pair
 * or before a combining mark). `changed` tells that something was collapsed or escaped.
 */
const visibleText = (text: string, limit: number, rules: VisibleRules): VisibleText => {
  const pieces: string[] = []
  let size = 0
  let changed = false
  let cut = false
  const push = (piece: string, escaped: boolean): boolean => {
    // Escapes and markers are ASCII or BMP text, so their length is their code point count.
    const points = escaped ? piece.length : 1
    if (size + points > limit) {
      cut = true
      return false
    }
    pieces.push(piece)
    size += points
    if (escaped) changed = true
    return true
  }
  let index = 0
  scan: while (index < text.length) {
    const character = String.fromCodePoint(text.codePointAt(index)!)
    if (rules.inRun(character)) {
      let end = index
      let count = 0
      let blank = false
      const seen = new Set<string>()
      while (end < text.length) {
        const next = String.fromCodePoint(text.codePointAt(end)!)
        if (!rules.inRun(next)) break
        count++
        if (next !== ' ' && BLANK_DRAWN.test(next)) blank = true
        if (seen.size <= 4) seen.add(next)
        end += next.length
      }
      const others = [...seen].filter((item) => item !== ' ')
      // A run of plain spaces stays as it is (code indentation); a long run that draws blank, or
      // one character repeated, becomes a marker. A long run of different hidden characters
      // (such as tag characters that spell out text) is escaped character by character.
      if (others.length && count > MAX_BLANK_RUN && (blank || others.length === 1)) {
        const codes = [...seen].slice(0, 4).map(codePointName).join('/')
        if (!push(`${MARKER_OPEN}${count} \u00d7 ${codes}${seen.size > 4 ? '/\u2026' : ''}\u27e7`, true)) break
      } else {
        for (let at = index; at < end; ) {
          const item = String.fromCodePoint(text.codePointAt(at)!)
          const escaped = rules.escape(item, text, at)
          if (!push(escaped ?? item, escaped !== null)) break scan
          at += item.length
        }
      }
      index = end
      continue
    }
    const escaped = rules.escape(character, text, index)
    if (!push(escaped ?? character, escaped !== null)) {
      // Never leave a base character without the combining marks that follow it.
      if (/\p{M}/u.test(character)) {
        while (pieces.length && /^\p{M}$/u.test(pieces[pieces.length - 1])) pieces.pop()
        if (pieces.length && Array.from(pieces[pieces.length - 1]).length === 1) pieces.pop()
      }
      break
    }
    index += character.length
  }
  return { text: pieces.join(''), changed, cut }
}

const valueRules: VisibleRules = {
  inRun: (character) => character !== '\n' && (BLANK_DRAWN.test(character) || HIDDEN.test(character)),
  escape: (character, text, index) =>
    (character !== '\t' && character !== '\n' && HIDDEN.test(character)) ||
    character === MARKER_OPEN ||
    // A backslash that starts what reads like an escape is escaped too, so an escape is never
    // text the model wrote.
    (character === '\\' && text.startsWith('u{', index + 1))
      ? escapedCharacter(character)
      : null
}

/**
 * The text a row shows for a value: at most MAX_VALUE_LINES lines and TRUNCATE_AT characters,
 * line breaks of any kind shown as plain line breaks, blank runs collapsed and hidden characters
 * escaped. `truncated` asks for the form that points to the full request in Details; `changed`
 * for the form that says characters are shown as codes.
 */
const shownValue = (text: string): { text: string; truncated: boolean; changed: boolean } => {
  const lines = text.split(LINE_BREAK, MAX_VALUE_LINES + 1)
  let truncated = lines.length > MAX_VALUE_LINES
  const kept = lines.slice(0, MAX_VALUE_LINES)
  if (truncated) while (kept.length > 1 && !kept[kept.length - 1].trim()) kept.pop()
  const shown = visibleText(kept.join('\n'), TRUNCATE_AT, valueRules)
  if (shown.cut) truncated = true
  return { text: shown.text, truncated, changed: shown.changed }
}

// What Details shows: the request as JSON with every hidden or blank-drawing character written
// as a JSON \u escape (such characters only occur inside JSON strings), so the full request
// reads exactly as it is and stays valid JSON.
const DETAILS_ESCAPE = /(?![\t\n ])(?:[\p{Zs}\u2800\u3164\uffa0\u115f]|\u1160|\u17b4|\u17b5|[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}])/gu
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
// that draw blank or nothing, the marker bracket, and the quote and backslash used by the quoted
// form below.
const UNCLEAR_NAME_CHARACTER = /[\p{C}\p{Zl}\p{Zp}"\\\u27e6\u2800\u3164\uffa0\u115f\p{Default_Ignorable_Code_Point}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]|\u1160|\u17b4|\u17b5|(?! )\p{Zs}/u
// A name with a colon could read as "label: value" inside the row; it is quoted, not escaped.
const NAME_SEPARATOR = /[:：]/u

const nameRules: VisibleRules = {
  inRun: (character) =>
    character === ' ' ||
    (character !== '"' && character !== '\\' && character !== MARKER_OPEN && UNCLEAR_NAME_CHARACTER.test(character)),
  escape: (character) =>
    character === '"' || character === '\\'
      ? `\\${character}`
      : character !== ' ' && UNCLEAR_NAME_CHARACTER.test(character)
        ? escapedCharacter(character)
        : null
}

/**
 * How a field without a label is named in the approval. It is shown as sent, unless it could be
 * misread: then it is quoted with its hidden characters escaped and long blank runs collapsed
 * (empty names, surrounding spaces, invisible or control characters, and a name that reads like
 * the label of a known field). `cut` tells that the name was cut after NAME_TRUNCATE_AT
 * characters.
 */
const unlabelledParameterName = (key: string, knownLabels: ReadonlySet<string>): { text: string; cut: boolean } => {
  if (
    key &&
    key === key.trim() &&
    !UNCLEAR_NAME_CHARACTER.test(key) &&
    !NAME_SEPARATOR.test(key) &&
    !knownLabels.has(key)
  ) {
    const cutName = cutCodePoints(key, NAME_TRUNCATE_AT)
    return cutName === null ? { text: key, cut: false } : { text: cutName, cut: true }
  }
  const quoted = visibleText(key, NAME_TRUNCATE_AT - 1, nameRules)
  return quoted.cut ? { text: `"${quoted.text}`, cut: true } : { text: `"${quoted.text}"`, cut: false }
}

const approvalDisplay = (
  approval: MagicAgentPlatformPendingApproval,
  t: TFunction<'translation'>
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
  const knownLabels = new Set([...parameterLabels.keys()].map((key) => labelOf(key)!))
  const actionLabel = actionLabels.get(toolName)
  return {
    toolName: toolName || t('agent_workspace.approval.tool_name_missing'),
    action: toolName
      ? actionLabel !== undefined
        ? t(`agent_workspace.approval.actions.${actionLabel}`)
        : toolName
      : t('agent_workspace.approval.pending_action'),
    input,
    parameters: orderedKeys.map((key) => {
      const value = shownValue(parameterText(ownValue(input, key)))
      const labelled = labelOf(key)
      const name = labelled === undefined ? unlabelledParameterName(key, knownLabels) : { text: labelled, cut: false }
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

export default function MagicAgentApprovalCenter(): React.JSX.Element | null {
  const [approvals, setApprovals] = useState<MagicAgentPlatformPendingApproval[]>([])
  const [busy, setBusy] = useState(false)
  const { t } = useTranslation()

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
  const display = approvalDisplay(approval, t)

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
    const shown = approvalDisplay(pending, t)
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
        prompt={isNote ? noteRow ? <Box component="span" data-approval-note="" sx={{display:'block',whiteSpace:'pre-wrap',overflowWrap:'anywhere',unicodeBidi:'isolate'}}>{noteRow.text}</Box> : t('agent_workspace.approval.note_missing') : shown.action}
        detail={!detailParameters.length ? undefined : <>{detailParameters.map(parameter => <Box key={parameter.key} component="span" data-approval-parameter={parameter.key} sx={{display:'block',pl:'1em',textIndent:'-1em'}}><Box component="span" data-approval-parameter-label="" sx={{fontWeight:600}}>{parameter.label}</Box>: <Box component="span" data-approval-parameter-value="" sx={{unicodeBidi:'isolate'}}>{parameter.text}</Box></Box>)}</>}
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
      <DialogContent>
        <Typography fontWeight={600}>{display.action}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t('agent_workspace.approval.tool', { name: display.toolName })}
        </Typography>
        {approval.graphContext ? (
          <Typography variant="body2" color="text.secondary">
            {t('agent_workspace.approval.task_step', {
              runId: approval.graphContext.runId,
              nodeId: approval.graphContext.nodeId
            })}
          </Typography>
        ) : null}
        <Box component="dl" sx={{ m: 0, mt: 2 }}>
          {display.parameters.map((parameter) => (
            <React.Fragment key={parameter.key}>
              <Typography component="dt" variant="body2" fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
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
                {parameter.text}
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
