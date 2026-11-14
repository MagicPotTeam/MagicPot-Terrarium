import { useId, useState, type ReactNode } from 'react'
import { PersonOutline, WorkOutline } from '@mui/icons-material'
import { Box, Button, IconButton, Typography } from '@mui/material'

export type ProcessEntry = {
  id: string
  kind: 'member' | 'job'
  name: string
  role?: string
  status: 'running' | 'approval' | 'completed' | 'cancelled' | 'failed' | 'idle' | 'unknown'
  statusText?: string
  canStop?: boolean
  selected?: boolean
  detail?: ReactNode
  onOpen?: () => void
  onStop?: () => void
}

export type AgentProcessAreaProps = {
  entries: ProcessEntry[]
  managementSlot?: ReactNode
  onStopAllMembers?: () => void
  staticSlot?: ReactNode
  showStaticWhenEmpty?: boolean
  footerSlot?: ReactNode
  children?: ReactNode
  defaultExpanded?: boolean
}

const labels: Record<ProcessEntry['status'], string> = {
  running: '运行中', approval: '待审批', completed: '已完成', cancelled: '已取消',
  failed: '失败', idle: '空闲', unknown: '未知'
}
const colors: Record<ProcessEntry['status'], string> = {
  running: 'success.main', approval: 'warning.main', failed: 'error.main',
  completed: 'text.secondary', cancelled: 'text.secondary', idle: 'text.secondary', unknown: 'text.secondary'
}

function ProcessRow({ entry, position, duplicateName }: { entry: ProcessEntry; position: number; duplicateName: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()
  const statusId = useId()
  const displayId = useId()
  const stopDescriptionId = useId()
  const memberStopDescription = '请求停止该成员，并清除其排队消息。'
  const name = entry.name.trim()
  const role = entry.role?.trim()
  const actionLabel = (verb: string, suffix = '') => duplicateName
    ? `当前列表第 ${position} 项（位置随列表变化），${verb}：${name}${suffix}`
    : `${verb} ${name}${suffix}`
  const display = role && role !== name ? `${name} · ${role}` : name
  const hasDetail = entry.detail !== undefined && entry.detail !== null
  const action = entry.onOpen || (hasDetail ? () => setExpanded(value => !value) : undefined)
  const content = <>
    <Box component="span" aria-hidden="true" sx={{ width: 22, height: 22, flexShrink: 0, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'action.selected', color: 'text.secondary' }}>
      {entry.kind === 'member' ? <PersonOutline sx={{ fontSize: 15 }} /> : <WorkOutline sx={{ fontSize: 15 }} />}
    </Box>
    <Box id={displayId} component="span" sx={{ minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'normal', color: 'text.primary' }}>{display}</Box>
    <Box component="span" aria-hidden="true" sx={{ color: colors[entry.status], flexShrink: 0 }}>●</Box>
    <Box id={statusId} component="span" sx={{ color: 'text.secondary', minWidth: 0, flexShrink: 1, overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{entry.statusText?.trim() || labels[entry.status]}</Box>
  </>
  return (
    <Box component="li" sx={{ minWidth: 0, fontSize: 12, overflowWrap: 'anywhere' }}>
      <Box sx={{ display: 'flex', minWidth: 0, alignItems: 'center', gap: .5 }}>
        {action ? <Button type="button" aria-describedby={`${displayId} ${statusId}`} aria-current={entry.selected ? 'page' : undefined} aria-label={entry.onOpen ? `打开 ${name}` : actionLabel(expanded ? '收起' : '展开', ' 详情')} aria-expanded={!entry.onOpen && hasDetail ? expanded : undefined} aria-controls={!entry.onOpen && hasDetail ? detailId : undefined} onClick={action} sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', textAlign: 'left', gap: .75, fontSize: 12, textTransform: 'none', backgroundColor: entry.selected ? 'action.selected' : undefined }}>{content}</Button>
          : <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: .75, px: 1 }}>{content}</Box>}
        {hasDetail && entry.onOpen && <Button type="button" size="small" aria-label={actionLabel(expanded ? '收起' : '展开', ' 详情')} aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(value => !value)} sx={{ minWidth: 0, flexShrink: 0, fontSize: 12 }}>{expanded ? '收起' : '展开'}</Button>}
        {(entry.canStop ?? (entry.status === 'running' || entry.status === 'approval')) && entry.onStop && <>
          <IconButton size="small" aria-label={actionLabel('停止')} aria-describedby={entry.kind === 'member' ? stopDescriptionId : undefined} title={entry.kind === 'member' ? memberStopDescription : undefined} onClick={entry.onStop} sx={{ fontSize: 16, flexShrink: 0 }}>×</IconButton>
          {entry.kind === 'member' && <Box id={stopDescriptionId} component="span" sx={{ position: 'absolute', width: '1px', height: '1px', p: 0, m: '-1px', overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>{memberStopDescription}</Box>}
        </>}
      </Box>
      <Box component="span" role="status" aria-live="polite" aria-atomic="true" aria-label={`${name}：状态：${entry.statusText?.trim() || labels[entry.status]}`} sx={{ position: 'absolute', width: '1px', height: '1px', p: 0, m: '-1px', overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>{name}：状态：{entry.statusText?.trim() || labels[entry.status]}</Box>
      {hasDetail && <Box id={detailId} hidden={!expanded} sx={{ fontSize: 12, overflowWrap: 'anywhere' }}>{entry.detail}</Box>}
    </Box>
  )
}

export default function AgentProcessArea({ entries, managementSlot, onStopAllMembers, staticSlot, showStaticWhenEmpty = false, footerSlot, children, defaultExpanded = true }: AgentProcessAreaProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const listId = useId()
  const stopAllDescriptionId = useId()
  const stopAllDescription = '请求停止活跃成员并清除其排队消息，不影响后台任务。'
  const members = entries.filter(entry => entry.kind === 'member').length
  const running = entries.filter(entry => entry.status === 'running').length
  const approval = entries.filter(entry => entry.status === 'approval').length
  const normalizedName = (entry: ProcessEntry) => entry.name.replace(/\s+/g, ' ').trim()
  const nameCounts = new Map<string, number>()
  for (const entry of entries) {
    const hasDetail = entry.detail !== undefined && entry.detail !== null
    const hasStop = (entry.canStop ?? (entry.status === 'running' || entry.status === 'approval')) && entry.onStop
    if (!hasDetail && !hasStop) continue
    const name = normalizedName(entry)
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }
  const summary = `成员 ${members} · 运行项 ${running} · 待审批项 ${approval}`
  return (
    <Box component="section" aria-label="进程区" hidden={entries.length === 0 && !showStaticWhenEmpty} sx={{ minWidth: 0, fontSize: 12, flexShrink: 0, maxHeight: '30%', overflowY: 'auto' }}>
      {entries.length === 0 && showStaticWhenEmpty && staticSlot}
      {entries.length > 0 && <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: .5, justifyContent: 'space-between' }}>
        <Button type="button" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)} sx={{ minWidth: 0, fontSize: 12, textTransform: 'none', color: 'text.secondary' }}>
          <Typography component="span" sx={{ fontSize: 'inherit' }}>进程 · {summary}</Typography>
        </Button>
        <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          {onStopAllMembers && entries.some(entry => entry.kind === 'member' && (entry.status === 'running' || entry.status === 'approval')) && <>
            <Button size="small" aria-label="全部停止成员" aria-describedby={stopAllDescriptionId} title={stopAllDescription} onClick={onStopAllMembers} sx={{ minWidth: 0, fontSize: 12 }}>停止成员</Button>
            <Box id={stopAllDescriptionId} component="span" sx={{ position: 'absolute', width: '1px', height: '1px', p: 0, m: '-1px', overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>{stopAllDescription}</Box>
          </>}
          {managementSlot}
        </Box>
      </Box>
      {staticSlot}
      <Box id={listId} hidden={!expanded}>
        <Box component="ul" aria-label="进程列表" sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {entries.map((entry, index) => <ProcessRow key={`${entry.kind}:${entry.id}`} entry={entry} position={index + 1} duplicateName={(nameCounts.get(normalizedName(entry)) ?? 0) > 1} />)}
        </Box>
        {children}
      </Box>
      {footerSlot}
      </>}
    </Box>
  )
}
