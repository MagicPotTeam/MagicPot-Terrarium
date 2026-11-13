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
import type { MagicAgentPlatformPendingApproval } from '@shared/api/svcMagicAgentPlatform'
import { api } from '../utils/windowUtils'

const POLL_MS = 1000

const actionLabels: Record<string, string> = {
  'memory_write': '修改持久记忆文件（独立审批）',
  'scratchpad': '修改当前会话草稿笔记',
  'comfyui.workflow.submit': '提交 ComfyUI 工作流',
  'canvas.export': '导出画布',
  'image.create': '生成或编辑图片',
  'video.create': '生成或编辑视频',
  'asset.import': '导入素材',
  'mcp.tool.call': '调用外部 MCP 工具',
  'agent.terminal.run': '运行受控终端命令',
  'terminal.run': '运行终端命令',
  'python.run': '运行 Python 代码',
  'python.background': '在后台运行 Python 代码',
  'commands.background': '启动后台任务',
  'files.write': '写入文件',
  'files.edit': '修改文件',
  'files.patch': '应用文件补丁',
  'files.multi-edit': '批量修改文件',
  'files.json.write': '写入 JSON 文件',
  'files.snapshot.restore': '恢复文件快照',
  'git.checkout': '切换 Git 分支或版本',
  'git.add': '暂存 Git 更改',
  'git.commit': '创建 Git 提交'
}

const parameterLabels: Record<string, string> = {
  content: '文件完整内容',
  namespace: '路由所属记忆目录',
  namespaceGeneration: '记忆命名空间代次',
  namespaceCreation: '创建目录及归属标记',
  preimage: '此前完整文件 SHA-256（null 表示不存在）',
  create: '仅创建新文件',
  operationId: 'MAIN 操作标识',
  conversationId: '会话',
  action: '操作',
  key: '笔记键',
  value: '笔记内容',
  expectedRevision: '预期笔记版本',
  clearScope: '清空范围',
  prompt: '任务内容',
  model: '模型',
  path: '路径',
  targetPath: '目标路径',
  sourcePath: '来源路径',
  outputPath: '输出路径',
  url: '网址',
  workflow: '工作流',
  qAppKey: '快捷应用',
  command: '命令',
  args: '参数',
  cwd: '工作目录',
  code: '代码',
  toolName: '外部工具',
  name: '名称'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const approvalDisplay = (approval: MagicAgentPlatformPendingApproval, omitTechnical = false) => {
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
    ...Object.keys(parameterLabels).filter((key) => keys.includes(key)),
    ...keys.filter((key) => !(key in parameterLabels))
  ].slice(0, 6)
  return {
    toolName: toolName || '未提供工具名称',
    action: toolName ? actionLabels[toolName] || toolName : '待确认操作',
    parameters: orderedKeys.map((key) => {
      const value = input[key]
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return {
        key,
        label: parameterLabels[key] || key,
        text: text && text.length > 480 ? `${text.slice(0, 480)}…（完整内容见详情）` : text
      }
    })
  }
}

export default function MagicAgentApprovalCenter(): React.JSX.Element | null {
  const [approvals, setApprovals] = useState<MagicAgentPlatformPendingApproval[]>([])
  const [busy, setBusy] = useState(false)

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
  const display = approvalDisplay(approval)

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
    const shown = approvalDisplay(pending, true)
    const envelope = isRecord(pending.request) ? pending.request : {}
    const request = isRecord(envelope.request) ? envelope.request : {}
    const input = isRecord(request.input) ? request.input : {}
    const isNote = shown.toolName === 'scratchpad' && input.action === 'set'
    const member = surface!.members.get(matchTeamApproval(pending.request,surface!)!)
    return createPortal(<Box key={pending.approvalId} data-approval-id={pending.approvalId} data-approval-revision={pending.revision} sx={{p:1.5,mb:1,border:1,borderColor:'divider',borderRadius:2,bgcolor:'background.paper'}}>
      <Typography variant="body2" fontWeight={600} sx={{overflowWrap:'anywhere'}}>{isNote ? `${member} 想保存一条笔记` : `${member} 请求操作`}</Typography>
      {isNote ? <Typography variant="body2" color="text.secondary" title={typeof input.value === 'string' ? input.value : undefined} sx={{mt:0.5,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{typeof input.value === 'string' ? input.value : '笔记内容未提供'}</Typography> : <Box><Typography variant="body2" color="text.secondary" sx={{mt:0.5,overflowWrap:'anywhere'}}>{shown.action}</Typography>{shown.parameters.map(parameter => <Typography key={parameter.key} variant="caption" component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',m:0}}>{parameter.label}: {parameter.text}</Typography>)}</Box>}
      <Box component="details" sx={{mt:1,color:'text.secondary','& summary':{cursor:'pointer',typography:'caption'}}}><summary>详情</summary><Typography component="pre" variant="caption" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:300,overflow:'auto',m:0,mt:1}}>{JSON.stringify(pending.request,null,2)}</Typography></Box>
      <Box sx={{display:'flex',gap:1,mt:1}}><Button size="small" variant="contained" disabled={busy} onClick={()=>void resolve(true,pending)}>批准</Button><Button size="small" variant="outlined" disabled={busy} onClick={()=>void resolve(false,pending)}>拒绝</Button></Box>
    </Box>,surface!.element,pending.approvalId)
  })
  if(inline.some(item=>item.approval===approval))return <>{inlineCards}</>
  return (<>{inlineCards}
    <Dialog open aria-labelledby="magic-agent-approval-title">
      <DialogTitle id="magic-agent-approval-title">确认 AI 请求的操作</DialogTitle>
      <DialogContent>
        <Typography fontWeight={600}>{display.action}</Typography>
        <Typography variant="body2" color="text.secondary">
          工具：{display.toolName}
        </Typography>
        {approval.graphContext ? (
          <Typography variant="body2" color="text.secondary">
            任务 {approval.graphContext.runId} · 步骤 {approval.graphContext.nodeId}
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
            查看完整请求（敏感信息已隐藏）
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
          拒绝
        </Button>
        <Button disabled={busy} variant="contained" onClick={() => void resolve(true)}>
          允许这次操作
        </Button>
      </DialogActions>
    </Dialog></>
  )
}
