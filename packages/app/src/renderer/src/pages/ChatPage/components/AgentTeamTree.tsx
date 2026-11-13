import { useTeamImagePlacement } from './useTeamImagePlacement'
import { reconcileTeamImageButtonKeys } from './teamImageButtonKeys'
import { createPortal } from 'react-dom'
import { useState, type ReactNode } from 'react'
import { PersonOutline } from '@mui/icons-material'
import { Box, Button, Collapse, TextField, Typography } from '@mui/material'
import { createTeamMember, memberActivity, TEAM_MAX_MEMBERS } from '../agentTeam'
import { teamTaskBlockers, validateTeamTasks } from '../agentTeamTasks'
import type { ChatSession } from '../chatStorage'
const safeToolName = (value: unknown): string => typeof value === 'string' && /^[\p{L}\p{N}_.-]{1,80}$/u.test(value) ? value : '未知工具'
const safeTask = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : ''
  const points = Array.from(text)
  return points.length ? (points.length > 40 ? `${points.slice(0, 40).join('')}…` : text) : '未设置'
}
const recentTools = (member: ChatSession) => member.messages.flatMap(message => message.toolHistory ?? []).slice(-10)
const toolStatus = (value: unknown): string => value === 'completed' ? '完成' : value === 'failed' ? '失败' : value === 'cancelled' ? '已取消' : '未知'

export type TeamImagePlacement = ReturnType<typeof useTeamImagePlacement>
type CreateMember = (name: string, role: string, onCommittedEmpty: (memberId: string) => void) => Promise<void>

/** Place this keyed boundary around image consumers only; keep process hosts outside it. */
export function AgentTeamImagePlacementController({ projectId, members, children }: {
  projectId: string; members: ChatSession[]; children: (placement: TeamImagePlacement) => ReactNode
}) {
  const placement = useTeamImagePlacement(projectId, members)
  return <>{children(placement)}</>
}

/** Legacy wrapper; do not mount together with another image controller for the same team. */
export function AgentTeamMemberCreator({ projectId, lead, members, creating, onClose, onCreate, children }: {
  projectId: string; lead: ChatSession; members: ChatSession[]; creating: boolean
  onClose(): void; onCreate: CreateMember; children?: (placement: TeamImagePlacement) => ReactNode
}) {
  const placement = useTeamImagePlacement(projectId, members)
  return <>{children?.(placement)}<AgentTeamMemberForm lead={lead} members={members} creating={creating} onClose={onClose} onCreate={onCreate} placement={placement} /></>
}

/** Observer-free form: provide the placement owned by a stable parent, never mount a second observer. */
export function AgentTeamMemberForm({ lead, members, creating, onClose, onCreate, placement }: {
  lead: ChatSession; members: ChatSession[]; creating: boolean; placement: TeamImagePlacement
  onClose(): void; onCreate: CreateMember
}) {
  const [name, setName] = useState(''), [role, setRole] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const limit = lead.teamSettings?.maxMembers ?? TEAM_MAX_MEMBERS
  const invalidLimit = !Number.isInteger(limit) || limit < 1 || limit > TEAM_MAX_MEMBERS
  const atLimit = !invalidLimit && members.length >= limit
  let valid = false
  try { createTeamMember(lead, name, role, 'validation-only', 0); valid = true } catch { /* Same validation as the actual create. */ }
  return <>
    {creating && <Box sx={{ p: 1, maxWidth: 'min(480px, 95%)', maxHeight: '70%', overflow: 'auto', position: 'absolute', top: 8, right: 8, zIndex: 1200, bgcolor: 'background.paper', boxShadow: 3, borderRadius: 1 }} role="dialog" aria-label="创建成员">
      <Typography variant="caption">确认创建成员</Typography>
      {invalidLimit ? <Typography variant="caption" component="div">成员上限设置无效</Typography> : atLimit && <Typography variant="caption" component="div">已达成员上限（{limit}）</Typography>}
      <TextField size="small" fullWidth label="成员名" value={name} onChange={e => setName(e.target.value)} inputProps={{ maxLength: 32 }}/>
      <TextField size="small" fullWidth label="角色 / 当前任务" value={role} onChange={e => setRole(e.target.value)} inputProps={{ maxLength: 256 }}/>
      <Button disabled={busy || !valid || atLimit || invalidLimit || Boolean(lead.teamEnded)} onClick={() => {
        setBusy(true); setError('')
        void onCreate(name, role, placement.registerEmptyMember).then(() => { setName(''); setRole(''); onClose() }).catch(() => setError('创建结果未确认；请先核对原团队成员列表。没有记录不代表未创建；未确认前请勿重复创建。')).finally(() => setBusy(false))
      }}>确认创建成员</Button>
      <Button disabled={busy} onClick={onClose}>取消</Button>
      {error && <Typography role="alert" color="error">{error}</Typography>}
    </Box>}
  </>
}

/** Render existing manual image actions with the exact slots used by auto placement. */
export function AgentTeamMemberImages({ member, placeImage }: { member: ChatSession; placeImage: TeamImagePlacement['place'] }) {
  const images = member.messages.flatMap((message,messageIndex)=>message.role==='assistant'?(message.attachments??[]).filter(attachment=>attachment.type==='image').map((attachment,attachmentIndex)=>({attachment,slot:JSON.stringify([member.id,messageIndex,attachmentIndex])})):[])
  const urls = images.map(({ attachment }) => `${attachment.url}`)
  const [keys, setKeys] = useState(() => reconcileTeamImageButtonKeys({ nextId: 0, entries: [] }, urls))
  const nextKeys = reconcileTeamImageButtonKeys(keys, urls)
  if (nextKeys !== keys) setKeys(nextKeys)
  return <>{images.map(({attachment,slot},index)=><Button key={nextKeys.entries[index].key} size="small" onClick={()=>{placeImage(member.id,{...attachment,fileName:`${member.teamMemberName}·图${index+1}`},undefined,undefined,slot)}}>投放 {member.teamMemberName}·图{index+1}</Button>)}</>
}

export default function AgentTeamTree({lead,members,currentId,running,waiting,activityHost,projectId,leadModelName,onSelect,onCreate,onStop}: {
  projectId:string;
  leadModelName?:string;
  activityHost:HTMLElement|null;
  waiting:ReadonlySet<string>;
  lead:ChatSession;members:ChatSession[];currentId:string;running:ReadonlySet<string>;
  onSelect(id:string):void;onCreate(name:string,role:string,onCommittedEmpty:(memberId:string)=>void):Promise<void>;onStop(id:string):void
}) {
  const [open,setOpen]=useState(true),[creating,setCreating]=useState(false),[name,setName]=useState(''),[role,setRole]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const { place: placeImage, registerEmptyMember } = useTeamImagePlacement(projectId, members)
  const memberLimit = lead.teamSettings?.maxMembers ?? TEAM_MAX_MEMBERS
  const invalidLimit = !Number.isInteger(memberLimit) || memberLimit < 1 || memberLimit > TEAM_MAX_MEMBERS
  const atLimit = !invalidLimit && members.length >= memberLimit
  let validMember = false
  try { createTeamMember(lead, name, role, 'validation-only', 0); validMember = true } catch { /* Match the domain validation exactly. */ }
  const status=(member:ChatSession)=>waiting.has(member.id)?'待审批':running.has(member.id)?'运行中':member.messages.flatMap(message=>message.toolHistory??[]).at(-1)?.status==='running'?'状态未知':memberActivity(member,false).status
  const statusColor=(member:ChatSession)=>waiting.has(member.id)?'warning.main':running.has(member.id)?'success.main':memberActivity(member,false).failed?'error.main':'text.secondary'
  const tasks=lead.teamTasks ?? []
  let taskDataValid=true
  try { validateTeamTasks(tasks) } catch { taskDataValid=false }
  const treeStatus=(member:ChatSession)=>{
    if(waiting.has(member.id)||running.has(member.id))return status(member)
    if(!taskDataValid)return '任务数据无效'
    if(!lead.teamEnded){
      const blocked=tasks.filter(task=>task.ownerId===member.id&&task.status==='pending').flatMap(task=>teamTaskBlockers(tasks,task))
      const titles=[...new Set(blocked.map(task=>task.title))]
      if(titles.length){const text=titles.join('、'),points=Array.from(text);return `等待依赖：${points.length>40?`${points.slice(0,40).join('')}…`:text}`}
    }
    return status(member)
  }
  return <Box sx={{px:1}} data-testid="agent-team-tree">
    {currentId!==lead.id&&<Button size="small" onClick={()=>onSelect(lead.id)}>← 返回组长 · {lead.title}</Button>}
    {lead.teamEnded && <Typography variant="caption" component="div" color="text.secondary">团队已结束</Typography>}
    <Box sx={{display:'flex',alignItems:'center',gap:.5,minWidth:0}}><Button size="small" aria-label={open?'折叠团队成员':'展开团队成员'} aria-expanded={open} disabled={!members.length} onClick={()=>setOpen(v=>!v)} sx={{minWidth:24,p:0,color:'text.secondary'}}>{open?'▾':'▸'}</Button><Typography variant="caption" sx={{flex:1,color:'text.secondary'}}>团队成员 · {members.length}</Typography><Button size="small" aria-label="组建团队 / 添加成员" variant="outlined" sx={{minWidth:26,p:0,borderColor:'divider',borderRadius:1,color:'text.secondary'}} disabled={Boolean(lead.teamEnded)||busy || (!creating && (atLimit || invalidLimit))} onClick={()=>setCreating(value=>!value)}>＋</Button></Box>{invalidLimit?<Typography variant="caption" component="div">成员上限设置无效</Typography>:atLimit&&<Typography variant="caption" component="div">已达成员上限（{memberLimit}）</Typography>}
    {creating&&<Box><Typography variant="caption">确认创建成员</Typography>
      <TextField size="small" label="成员名" value={name} onChange={e=>setName(e.target.value)} inputProps={{maxLength:32}}/>
      <TextField size="small" label="角色 / 当前任务" value={role} onChange={e=>setRole(e.target.value)} inputProps={{maxLength:256}}/>
      <Button disabled={busy||!validMember||atLimit||invalidLimit} onClick={()=>{setBusy(true);setError('');void onCreate(name,role,registerEmptyMember).then(()=>{setCreating(false);setName('');setRole('')}).catch(()=>setError('无法创建：请检查唯一成员名、范围或并发上限。')).finally(()=>setBusy(false))}}>确认创建成员</Button>{error&&<Typography color="error">{error}</Typography>}</Box>}
    {!!members.length&&activityHost&&createPortal(<Box sx={{px:1}} data-testid="team-activity">{members.map(member=>{
      const tools=recentTools(member)
      return <details key={member.id} style={{background:'rgba(255,255,255,0.045)',border:'1px solid rgba(255,255,255,0.09)',borderRadius:8,marginBottom:6,padding:'6px 8px',fontSize:12}}><summary style={{cursor:'pointer',display:'flex',alignItems:'center',gap:6,minWidth:0}}><Box component="span" aria-hidden="true" sx={{color:'text.secondary'}}>▸</Box><Box component="span" aria-hidden="true" sx={{color:statusColor(member),fontSize:10}}>●</Box><Box component="span" sx={{flex:1,minWidth:0,overflowWrap:'anywhere'}}>{member.teamMemberName || member.title} · {safeTask(member.teamRole)} · {status(member)} · {leadModelName?.trim() || '组长模型'}</Box><Button size="small" onClick={e=>{e.preventDefault();onSelect(member.id)}}>打开</Button></summary>
        <Typography variant="caption" component="div">角色/任务：{member.teamRole || '未设置'}</Typography>
        {tools.length ? <Box component="ul" sx={{m:0,pl:2}}>{tools.map((tool,index)=><Typography component="li" variant="caption" key={index}>{safeToolName(tool.toolName)} · {toolStatus(tool.status)}</Typography>)}</Box> : <Typography variant="caption">暂无工具步骤</Typography>}
        <AgentTeamMemberImages member={member} placeImage={placeImage}/>
      </details>
    })}</Box>,activityHost)}
    {!!members.length&&<Collapse in={open}>
      {members.map(member=><Box key={member.id} sx={{pl:1,display:'flex',alignItems:'center',borderLeft:1,borderColor:'divider',ml:1,mb:.25,minWidth:0}}>
        <Button size="small" aria-label={`${member.teamMemberName || member.title}${member.teamRole ? ` · ${member.teamRole}` : ''} · ${treeStatus(member)}`} aria-current={member.id===currentId?'page':undefined} onClick={()=>onSelect(member.id)} sx={{minWidth:0,textAlign:'left',justifyContent:'flex-start',flex:1,gap:.75,textTransform:'none',borderRadius:1.5}}><Box component="span" aria-hidden="true" sx={{width:22,height:22,flexShrink:0,borderRadius:'50%',display:'inline-flex',alignItems:'center',justifyContent:'center',bgcolor:'action.selected',color:'text.secondary'}}><PersonOutline sx={{fontSize:15}} /></Box><Box component="span" sx={{minWidth:0,overflowWrap:'anywhere',color:'text.primary'}}>{member.teamMemberName || member.title}{member.teamRole ? ` · ${member.teamRole}` : ''} · <Box component="span" sx={{color:statusColor(member)}}>● {treeStatus(member)}</Box></Box></Button>
        <Button size="small" aria-label={`停止 ${member.teamMemberName}`} onClick={()=>onStop(member.id)}>×</Button>
      </Box>)}
    </Collapse>}
  </Box>
}
export function AgentTeamStatus({members,running,waiting,onStop,onExpand}: {waiting:ReadonlySet<string>;members:ChatSession[];running:ReadonlySet<string>;onStop(id:string):void;onExpand():void}) {
  if(!members.length)return null
  const waitingMembers = new Set(members.filter(member => waiting.has(member.id)).map(member => member.id)).size
  return <Box sx={{display:'flex',alignItems:'center',px:1,fontSize:12,gap:.5}} data-testid="agent-team-status"><Button size="small" sx={{borderRadius:5,bgcolor:'action.hover',color:'text.secondary',textTransform:'none'}} onClick={onExpand}>{members.length} 个成员 · {members.filter(m=>running.has(m.id)).length} 运行中 · {waitingMembers} 个成员待审批</Button><Button size="small" sx={{color:'text.secondary',textTransform:'none'}} onClick={()=>members.forEach(m=>onStop(m.id))}>全部停止</Button></Box>
}
