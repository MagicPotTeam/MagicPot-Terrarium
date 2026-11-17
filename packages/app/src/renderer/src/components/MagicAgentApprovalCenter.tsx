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
// overrides, zero-width), line and paragraph separators, spaces other than U+0020, and the
// quote and backslash used by the quoted form below.
const UNCLEAR_NAME_CHARACTER = /[\p{C}\p{Zl}\p{Zp}"\\]|(?! )\p{Zs}/u

/**
 * How a field without a label is named in the approval. It is shown as sent, unless it could be
 * misread: then it is quoted with its hidden characters escaped (empty names, surrounding
 * spaces, invisible or control characters, and a name that reads like the label of a known field).
 */
const unlabelledParameterName = (key: string, knownLabels: ReadonlySet<string>): string => {
  if (key && key === key.trim() && !UNCLEAR_NAME_CHARACTER.test(key) && !knownLabels.has(key)) return key
  const escaped = Array.from(key, (character) =>
    character === '"' || character === '\\'
      ? `\\${character}`
      : UNCLEAR_NAME_CHARACTER.test(character)
        ? `\\u{${character.codePointAt(0)!.toString(16)}}`
        : character
  ).join('')
  return `"${escaped}"`
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
      const text = parameterText(ownValue(input, key))
      return {
        key,
        label: labelOf(key) ?? unlabelledParameterName(key, knownLabels),
        text:
          text.length > TRUNCATE_AT
            ? t('agent_workspace.approval.truncated', { text: text.slice(0, TRUNCATE_AT) })
            : text
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
    const detailParameters = isNote ? shown.parameters.filter(parameter => parameter.key !== 'value') : shown.parameters
    const member = surface!.members.get(matchTeamApproval(pending.request,surface!)!)
    // Presentation only: a prompt card at the end of the member's team transcript. Which
    // approval is shown here and what the buttons resolve are decided above.
    return createPortal(<Box key={pending.approvalId} data-approval-id={pending.approvalId} data-approval-revision={pending.revision} sx={{minWidth:0}}>
      <ChatPromptCard
        testId="team-approval-card"
        icon={<WarningAmberIcon aria-hidden="true" />}
        accent="warning"
        title={isNote ? t('agent_workspace.approval.member_wants_note', { member }) : t('agent_workspace.approval.member_requests_action', { member })}
        prompt={isNote ? <Box component="span" title={typeof note === 'string' ? note : undefined} sx={{display:'block',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{typeof note === 'string' ? note : t('agent_workspace.approval.note_missing')}</Box> : shown.action}
        detail={!detailParameters.length ? undefined : <>{detailParameters.map(parameter => <Box key={parameter.key} component="span" sx={{display:'block'}}>{parameter.label}: {parameter.text}</Box>)}</>}
        options={[
          { key: 'approve', label: t('agent_workspace.approval.approve'), primary: true, disabled: busy, onSelect: () => void resolve(true, pending) },
          { key: 'deny', label: t('agent_workspace.approval.deny'), disabled: busy, onSelect: () => void resolve(false, pending) }
        ]}
      >
        <Box component="details" sx={{px:'4px',pb:'8px',color:'text.secondary',fontSize:12,'& summary':{cursor:'pointer',fontSize:12,lineHeight:'16px'}}}><summary>{t('agent_workspace.approval.details')}</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'16rem',overflow:'auto',m:0,mt:'4px',fontFamily:'monospace',fontSize:11,lineHeight:'16px'}}>{JSON.stringify(pending.request,null,2)}</Typography></Box>
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
                sx={{ ml: 0, mb: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
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
            {JSON.stringify(approval.request, null, 2)}
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
