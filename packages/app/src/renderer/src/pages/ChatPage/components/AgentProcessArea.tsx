import { useId, useState, type ReactNode } from 'react'
import { WorkOutline } from '@mui/icons-material'
import { Box, Button, IconButton, Typography } from '@mui/material'

/** A helper job or background process of the conversation (the team is listed in the thread list). */
export type ProcessEntry = {
  id: string
  kind: 'job'
  name: string
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'idle' | 'unknown'
  statusText?: string
  canStop?: boolean
  detail?: ReactNode
  onStop?: () => void
}

export type AgentProcessAreaProps = {
  entries: ProcessEntry[]
  managementSlot?: ReactNode
  staticSlot?: ReactNode
  showStaticWhenEmpty?: boolean
  footerSlot?: ReactNode
  children?: ReactNode
  defaultExpanded?: boolean
}

const labels: Record<ProcessEntry['status'], string> = {
  running: '运行中', completed: '已完成', cancelled: '已取消',
  failed: '失败', idle: '空闲', unknown: '未知'
}
const colors: Record<ProcessEntry['status'], string> = {
  running: 'success.main', failed: 'error.main',
  completed: 'text.secondary', cancelled: 'text.secondary', idle: 'text.secondary', unknown: 'text.secondary'
}

function ProcessRow({ entry, position, duplicateName }: { entry: ProcessEntry; position: number; duplicateName: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()
  const statusId = useId()
  const displayId = useId()
  const name = entry.name.trim()
  const actionLabel = (verb: string, suffix = '') => duplicateName
    ? `当前列表第 ${position} 项（位置随列表变化），${verb}：${name}${suffix}`
    : `${verb} ${name}${suffix}`
  const hasDetail = entry.detail !== undefined && entry.detail !== null
  const action = hasDetail ? () => setExpanded(value => !value) : undefined
  const content = <>
    <Box component="span" aria-hidden="true" sx={{ width: 22, height: 22, flexShrink: 0, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'action.selected', color: 'text.secondary' }}>
      <WorkOutline sx={{ fontSize: 15 }} />
    </Box>
    <Box id={displayId} component="span" sx={{ minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'normal', color: 'text.primary' }}>{name}</Box>
    <Box component="span" aria-hidden="true" sx={{ color: colors[entry.status], flexShrink: 0 }}>●</Box>
    <Box id={statusId} component="span" sx={{ color: 'text.secondary', minWidth: 0, flexShrink: 1, overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{entry.statusText?.trim() || labels[entry.status]}</Box>
  </>
  return (
    <Box component="li" sx={{ minWidth: 0, fontSize: 12, overflowWrap: 'anywhere' }}>
      <Box sx={{ display: 'flex', minWidth: 0, alignItems: 'center', gap: .5 }}>
        {action ? <Button type="button" aria-describedby={`${displayId} ${statusId}`} aria-label={actionLabel(expanded ? '收起' : '展开', ' 详情')} aria-expanded={expanded} aria-controls={detailId} onClick={action} sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', textAlign: 'left', gap: .75, fontSize: 12, textTransform: 'none' }}>{content}</Button>
          : <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: .75, px: 1 }}>{content}</Box>}
        {(entry.canStop ?? entry.status === 'running') && entry.onStop &&
          <IconButton size="small" aria-label={actionLabel('停止')} onClick={entry.onStop} sx={{ fontSize: 16, flexShrink: 0 }}>×</IconButton>}
      </Box>
      <Box component="span" role="status" aria-live="polite" aria-atomic="true" aria-label={`${name}：状态：${entry.statusText?.trim() || labels[entry.status]}`} sx={{ position: 'absolute', width: '1px', height: '1px', p: 0, m: '-1px', overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>{name}：状态：{entry.statusText?.trim() || labels[entry.status]}</Box>
      {hasDetail && <Box id={detailId} hidden={!expanded} sx={{ fontSize: 12, overflowWrap: 'anywhere' }}>{entry.detail}</Box>}
    </Box>
  )
}

export default function AgentProcessArea({ entries, managementSlot, staticSlot, showStaticWhenEmpty = false, footerSlot, children, defaultExpanded = true }: AgentProcessAreaProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const listId = useId()
  const running = entries.filter(entry => entry.status === 'running').length
  const normalizedName = (entry: ProcessEntry) => entry.name.replace(/\s+/g, ' ').trim()
  const nameCounts = new Map<string, number>()
  for (const entry of entries) {
    const hasDetail = entry.detail !== undefined && entry.detail !== null
    const hasStop = (entry.canStop ?? entry.status === 'running') && entry.onStop
    if (!hasDetail && !hasStop) continue
    const name = normalizedName(entry)
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }
  const summary = `运行项 ${running}`
  return (
    <Box component="section" aria-label="进程区" hidden={entries.length === 0 && !showStaticWhenEmpty} sx={{ minWidth: 0, fontSize: 12, flexShrink: 0, maxHeight: '30%', overflowY: 'auto' }}>
      {entries.length === 0 && showStaticWhenEmpty && staticSlot}
      {entries.length > 0 && <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: .5, justifyContent: 'space-between' }}>
        <Button type="button" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)} sx={{ minWidth: 0, fontSize: 12, textTransform: 'none', color: 'text.secondary' }}>
          <Typography component="span" sx={{ fontSize: 'inherit' }}>进程 · {summary}</Typography>
        </Button>
        <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
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
