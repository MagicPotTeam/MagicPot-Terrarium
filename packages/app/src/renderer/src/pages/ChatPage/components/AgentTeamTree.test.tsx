import {act,render,screen,fireEvent,waitFor} from '@testing-library/react'
import {describe,it,expect,vi} from 'vitest'
import type {ReactNode} from 'react'
import { AgentTeamMemberImages, AgentTeamMemberForm, type TeamImagePlacement } from './AgentTeamTree'
import { useTeamImagePlacement } from './useTeamImagePlacement'
import type {ChatSession} from '../chatStorage'
type CreateMember=(name:string,role:string,onCommittedEmpty:(memberId:string)=>void)=>Promise<void>
// The page owns one placement observer per team and hands it to the form and the image buttons.
function AgentTeamImagePlacementController({projectId,members,children}:{projectId:string;members:ChatSession[];children:(placement:TeamImagePlacement)=>ReactNode}) {
  const placement=useTeamImagePlacement(projectId,members)
  return <>{children(placement)}</>
}
function AgentTeamMemberCreator({projectId,lead,members,creating,onClose,onCreate,children}:{projectId:string;lead:ChatSession;members:ChatSession[];creating:boolean;onClose():void;onCreate:CreateMember;children?:(placement:TeamImagePlacement)=>ReactNode}) {
  const placement=useTeamImagePlacement(projectId,members)
  return <>{children?.(placement)}<AgentTeamMemberForm lead={lead} members={members} creating={creating} onClose={onClose} onCreate={onCreate} placement={placement}/></>
}
const dispatch=vi.hoisted(()=>vi.fn(async()=>({dispatched:true,placedCanvasItems:[]})))
vi.mock('../../ProjectCanvasPage/canvasTargetMediaDispatch',()=>({dispatchCanvasTargetMediaAttachmentToCanvas:dispatch}))
describe('controlled member creator',()=>{
 it('stays mounted without a tree or trigger, preserves drafts, and registers a committed empty member',async()=>{
  dispatch.mockClear()
  const lead:ChatSession={id:'lead',title:'Lead',messages:[]}
  const close=vi.fn(),create=vi.fn(async(_name:string,_role:string,register:(id:string)=>void)=>{register('member')})
  const props={projectId:'p',lead,members:[] as ChatSession[],onClose:close,onCreate:create}
  const view=render(<AgentTeamMemberCreator {...props} creating={false}/> )
  expect(view.container).toBeEmptyDOMElement()
  view.rerender(<AgentTeamMemberCreator {...props} creating/> )
  fireEvent.change(screen.getByLabelText('成员名'),{target:{value:'设计师'}})
  fireEvent.change(screen.getByLabelText('角色 / 当前任务'),{target:{value:'设计'}})
  view.rerender(<AgentTeamMemberCreator {...props} creating={false}/> )
  view.rerender(<AgentTeamMemberCreator {...props} creating/> )
  expect(screen.getByLabelText('成员名')).toHaveValue('设计师')
  fireEvent.click(screen.getByRole('button',{name:'确认创建成员'}))
  await waitFor(()=>expect(close).toHaveBeenCalledOnce())
  expect(create).toHaveBeenCalledWith('设计师','设计',expect.any(Function))
  const image={type:'image' as const,url:'data:image/png;base64,CC=='}
  const member:ChatSession={id:'member',title:'Member',teamMemberName:'设计师',messages:[{role:'assistant',content:'',attachments:[image]}]}
  view.rerender(<AgentTeamMemberCreator {...props} members={[member]} creating={false}>{({place})=><AgentTeamMemberImages member={member} placeImage={place}/>}</AgentTeamMemberCreator>)
  await waitFor(()=>expect(dispatch).toHaveBeenCalledTimes(1))
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining(image),'p','member',{teamImageLabel:'设计师·图1'})
  fireEvent.click(screen.getByRole('button',{name:'投放 设计师·图1'}))
  expect(dispatch).toHaveBeenCalledTimes(1)
 })
 it('keeps the creation form and its error visible for a live team when creation rejects',async()=>{
  const lead:ChatSession={id:'lead-error',title:'Lead',messages:[]}
  const create=vi.fn(async()=>{throw new Error('Team changed')})
  render(<AgentTeamImagePlacementController projectId="p" members={[]}>{placement=><AgentTeamMemberForm lead={lead} members={[]} creating onClose={vi.fn()} onCreate={create} placement={placement}/>}</AgentTeamImagePlacementController>)
  fireEvent.change(screen.getByLabelText('成员名'),{target:{value:'waiting'}})
  fireEvent.change(screen.getByLabelText('角色 / 当前任务'),{target:{value:'do work'}})
  fireEvent.click(screen.getByRole('button',{name:'确认创建成员'}))
  expect(await screen.findByText('创建结果未确认；请先核对原团队成员列表。没有记录不代表未创建；未确认前请勿重复创建。')).toBeVisible()
  expect(screen.getByLabelText('成员名')).toHaveValue('waiting')
  expect(screen.getByLabelText('角色 / 当前任务')).toHaveValue('do work')
  expect(create).toHaveBeenCalledOnce()
 })
 it('keeps the process host stable while keyed team observers baseline historical images',async()=>{
  dispatch.mockClear()
  const image={type:'image' as const,url:'data:image/png;base64,AA=='}
  const member=(id:string):ChatSession=>({id,title:id,teamMemberName:id,messages:[{role:'assistant',content:'',attachments:[image]}]})
  const lead:ChatSession={id:'lead',title:'Lead',messages:[]}
  const surface=(identity:string,members:ChatSession[]) => <><div data-testid="stable-process">process</div><AgentTeamImagePlacementController key={identity} projectId="p" members={members}>{placement=><AgentTeamMemberForm lead={lead} members={members} creating={false} onClose={vi.fn()} onCreate={vi.fn()} placement={placement}/>}</AgentTeamImagePlacementController></>
  const view=render(surface('scope:lead:0',[member('first')]))
  const host=screen.getByTestId('stable-process')
  expect(dispatch).not.toHaveBeenCalled()
  view.rerender(surface('scope:other:0',[member('second')]))
  expect(screen.getByTestId('stable-process')).toBe(host)
  expect(dispatch).not.toHaveBeenCalled()
  view.rerender(surface('scope:lead:1',[member('first')]))
  expect(screen.getByTestId('stable-process')).toBe(host)
  expect(dispatch).not.toHaveBeenCalled()
 })
 it('uses the exact historical slot for manual placement of duplicate URLs',async()=>{
  dispatch.mockClear()
  const image={type:'image' as const,url:'data:image/png;base64,DD=='}
  const member:ChatSession={id:'m',title:'M',teamMemberName:'设计师',messages:[{role:'assistant',content:'',attachments:[image,image]}]}
  render(<AgentTeamMemberCreator projectId="p" lead={{id:'lead',title:'Lead',messages:[]}} members={[member]} creating={false} onClose={vi.fn()} onCreate={vi.fn()}>{({place})=><AgentTeamMemberImages member={member} placeImage={place}/>}</AgentTeamMemberCreator>)
  expect(dispatch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'投放 设计师·图2'}))
  await waitFor(()=>expect(dispatch).toHaveBeenCalledTimes(1))
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining(image),'p','m',{teamImageLabel:'设计师·图2'})
 })
})
