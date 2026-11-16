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

const ownKey = <T extends object>(record: T, key: string): key is Extract<keyof T, string> =>
  Object.prototype.hasOwnProperty.call(record, key)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const approvalDisplay = (
  approval: MagicAgentPlatformPendingApproval,
  t: TFunction<'translation'>,
  omitTechnical = false
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
  const keys = Object.keys(input).filter(key => !omitTechnical || !['conversationId', 'expectedRevision', 'namespaceGeneration', 'operationId'].includes(key))
  const orderedKeys = [
    ...Object.keys(parameterLabelKeys).filter((key) => keys.includes(key)),
    ...keys.filter((key) => !(key in parameterLabelKeys))
  ].slice(0, 6)
  return {
    toolName: toolName || t('agent_workspace.approval.tool_name_missing'),
    action: toolName
      ? ownKey(actionLabelKeys, toolName)
        ? t(`agent_workspace.approval.actions.${actionLabelKeys[toolName]}`)
        : toolName
      : t('agent_workspace.approval.pending_action'),
    parameters: orderedKeys.map((key) => {
      const value = input[key]
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return {
        key,
        label: ownKey(parameterLabelKeys, key)
          ? t(`agent_workspace.approval.parameters.${parameterLabelKeys[key]}`)
          : key,
        text:
          text && text.length > 480
            ? t('agent_workspace.approval.truncated', { text: text.slice(0, 480) })
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
    const shown = approvalDisplay(pending, t, true)
    const envelope = isRecord(pending.request) ? pending.request : {}
    const request = isRecord(envelope.request) ? envelope.request : {}
    const input = isRecord(request.input) ? request.input : {}
    const isNote = shown.toolName === 'scratchpad' && input.action === 'set'
    const member = surface!.members.get(matchTeamApproval(pending.request,surface!)!)
    // Presentation only: a prompt card at the end of the member's team transcript. Which
    // approval is shown here and what the buttons resolve are decided above.
    return createPortal(<Box key={pending.approvalId} data-approval-id={pending.approvalId} data-approval-revision={pending.revision} sx={{minWidth:0}}>
      <ChatPromptCard
        testId="team-approval-card"
        icon={<WarningAmberIcon aria-hidden="true" />}
        accent="warning"
        title={isNote ? t('agent_workspace.approval.member_wants_note', { member }) : t('agent_workspace.approval.member_requests_action', { member })}
        prompt={isNote ? <Box component="span" title={typeof input.value === 'string' ? input.value : undefined} sx={{display:'block',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{typeof input.value === 'string' ? input.value : t('agent_workspace.approval.note_missing')}</Box> : shown.action}
        detail={isNote || !shown.parameters.length ? undefined : <>{shown.parameters.map(parameter => <Box key={parameter.key} component="span" sx={{display:'block'}}>{parameter.label}: {parameter.text}</Box>)}</>}
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
              <Typography component="dt" variant="body2" fontWeight={600}>
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
