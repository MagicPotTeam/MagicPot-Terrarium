import {act,render,screen,fireEvent,waitFor} from '@testing-library/react'
import {describe,it,expect,vi} from 'vitest'
import AgentTeamTree, { AgentTeamStatus, AgentTeamMemberCreator, AgentTeamMemberImages, AgentTeamMemberForm, AgentTeamImagePlacementController } from './AgentTeamTree'
import type {ChatSession} from '../chatStorage'
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
describe('team status',()=>{
 it('counts distinct waiting members in the current team only and preserves stop behavior',()=>{
  const one:ChatSession={id:'one',title:'One',messages:[],createdAt:1}
  const two:ChatSession={id:'two',title:'Two',messages:[],createdAt:2}
  const stop=vi.fn(),expand=vi.fn()
  const waiting=new Set(['one','one','outside'])
  const view=render(<AgentTeamStatus members={[one,two]} running={new Set(['one'])} waiting={waiting} onStop={stop} onExpand={expand}/>)
  expect(screen.getByRole('button',{name:'2 个成员 · 1 运行中 · 1 个成员待审批'})).toBeVisible()
  fireEvent.click(screen.getByRole('button',{name:/个成员待审批/}))
  expect(expand).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button',{name:'全部停止'}))
  expect(stop.mock.calls).toEqual([['one'],['two']])
  view.rerender(<AgentTeamStatus members={[two]} running={new Set()} waiting={waiting} onStop={stop} onExpand={expand}/>)
  expect(screen.getByRole('button',{name:'1 个成员 · 0 运行中 · 0 个成员待审批'})).toBeVisible()
  view.rerender(<AgentTeamStatus members={[]} running={new Set()} waiting={waiting} onStop={stop} onExpand={expand}/>)
  expect(screen.queryByTestId('agent-team-status')).not.toBeInTheDocument()
 })
})
describe('team member creation',()=>{
 const lead:ChatSession={id:'lead',title:'Lead',messages:[],createdAt:1}
 const member:ChatSession={id:'member',title:'Member',teamMemberName:'Member',messages:[],createdAt:2}
 const settings=(maxMembers:number)=>({maxMembers,defaultModel:null,autoCleanup:false})
 const props={projectId:'project',activityHost:null,currentId:'lead',running:new Set<string>(),waiting:new Set<string>(),onSelect:vi.fn(),onStop:vi.fn()}
 it('tracks configured and default limits and fails closed for invalid values',()=>{
  const onCreate=vi.fn(async()=>{})
  const view=render(<AgentTeamTree {...props} lead={{...lead,teamSettings:settings(2)}} members={[member]} onCreate={onCreate}/>)
  fireEvent.click(screen.getByRole('button',{name:'组建团队 / 添加成员'}))
  fireEvent.change(screen.getByLabelText('成员名'),{target:{value:'设计师'}})
  fireEvent.change(screen.getByLabelText('角色 / 当前任务'),{target:{value:'设计'}})
  expect(screen.getByRole('button',{name:'确认创建成员'})).toBeEnabled()
  view.rerender(<AgentTeamTree {...props} lead={{...lead,teamSettings:settings(1)}} members={[member]} onCreate={onCreate}/>)
  expect(screen.getByText('已达成员上限（1）')).toBeVisible()
  expect(screen.getByRole('button',{name:'确认创建成员'})).toBeDisabled()
  // A limit change while editing must not trap the form open.
  expect(screen.getByRole('button',{name:'组建团队 / 添加成员'})).toBeEnabled()
  fireEvent.click(screen.getByRole('button',{name:'组建团队 / 添加成员'}))
  expect(screen.queryByLabelText('成员名')).not.toBeInTheDocument()
  expect(screen.getByRole('button',{name:'组建团队 / 添加成员'})).toBeDisabled()
  view.rerender(<AgentTeamTree {...props} lead={{...lead,teamSettings:settings(2)}} members={[member]} onCreate={onCreate}/>)
  fireEvent.click(screen.getByRole('button',{name:'组建团队 / 添加成员'}))
  for(const value of [0,7,1.5,NaN]){
   view.rerender(<AgentTeamTree {...props} lead={{...lead,teamSettings:settings(value)}} members={[member]} onCreate={onCreate}/>)
   expect(screen.getByText('成员上限设置无效')).toBeVisible()
   expect(screen.getByRole('button',{name:'确认创建成员'})).toBeDisabled()
  }
  view.rerender(<AgentTeamTree {...props} lead={lead} members={[member]} onCreate={onCreate}/>)
  expect(screen.getByRole('button',{name:'确认创建成员'})).toBeEnabled()
  view.rerender(<AgentTeamTree {...props} lead={lead} members={Array.from({length:6},(_,i)=>({...member,id:String(i)}))} onCreate={onCreate}/>)
  expect(screen.getByText('已达成员上限（6）')).toBeVisible()
  expect(onCreate).not.toHaveBeenCalled()
 })
 it('blocks invalid names and roles and submits valid values unchanged',async()=>{
  const onCreate=vi.fn(async()=>{})
  render(<AgentTeamTree {...props} lead={lead} members={[]} onCreate={onCreate}/>)
  fireEvent.click(screen.getByRole('button',{name:'组建团队 / 添加成员'}))
  const name=screen.getByLabelText('成员名'),role=screen.getByLabelText('角色 / 当前任务'),submit=screen.getByRole('button',{name:'确认创建成员'})
  fireEvent.change(role,{target:{value:'设计'}})
  for(const invalid of [' ','name space','bad!','a'.repeat(33)]){
   fireEvent.change(name,{target:{value:invalid}})
   expect(submit).toBeDisabled()
  }
  fireEvent.change(name,{target:{value:'设计师_1'}})
  for(const invalid of ['   ','x'.repeat(257)]){
   fireEvent.change(role,{target:{value:invalid}})
   expect(submit).toBeDisabled()
  }
  fireEvent.change(role,{target:{value:'  设计  '}})
  expect(submit).toBeEnabled()
  fireEvent.click(submit)
  expect(onCreate).toHaveBeenCalledWith('设计师_1','  设计  ',expect.any(Function))
  await waitFor(()=>expect(screen.queryByRole('button',{name:'确认创建成员'})).not.toBeInTheDocument())
 })
})
describe('team task dependency status',()=>{
 it('shows only blocked pending tasks for their owner and preserves live state precedence',()=>{
  const tasks:NonNullable<ChatSession['teamTasks']>=[
   {id:'first',title:'准备素材',ownerId:'other',status:'pending',dependsOn:[]},
   {id:'done',title:'已完成',ownerId:'other',status:'done',dependsOn:[]},
   {id:'second',title:'设计',ownerId:'member',status:'pending',dependsOn:['first','done']},
   {id:'third',title:'检查',ownerId:'member',status:'pending',dependsOn:['first']},
  ]
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],teamTasks:tasks}
  const members:ChatSession[]=[{id:'member',title:'Writer',teamMemberName:'writer',messages:[]},{id:'other',title:'Other',teamMemberName:'other',messages:[]}]
  const props={projectId:'p',activityHost:null,lead,members,currentId:'lead',running:new Set<string>(),waiting:new Set<string>(),onSelect:vi.fn(),onCreate:async()=>{},onStop:vi.fn()}
  const view=render(<AgentTeamTree {...props}/> )
  expect(screen.getByRole('button',{name:'writer · 等待依赖：准备素材'})).toBeVisible()
  expect(screen.getByRole('button',{name:/other · 空闲/})).toBeVisible()
  view.rerender(<AgentTeamTree {...props} running={new Set(['member'])} waiting={new Set(['member'])}/> )
  expect(screen.getByRole('button',{name:'writer · 待审批'})).toBeVisible()
  view.rerender(<AgentTeamTree {...props} running={new Set(['member'])}/> )
  expect(screen.getByRole('button',{name:'writer · 运行中'})).toBeVisible()
  view.rerender(<AgentTeamTree {...props} lead={{...lead,teamEnded:true}}/> )
  expect(screen.getByRole('button',{name:/writer · 空闲/})).toBeVisible()
  view.rerender(<AgentTeamTree {...props} lead={{...lead,teamTasks:tasks.map(t=>t.id==='first'?{...t,status:'done'}:t)}}/> )
  expect(screen.getByRole('button',{name:/writer · 空闲/})).toBeVisible()
 })
 it('bounds dependency labels at 40 Unicode code points without splitting an emoji',()=>{
  const prefix='x'.repeat(39)+'😀'
  const member:ChatSession={id:'member',title:'Writer',teamMemberName:'writer',messages:[]}
  const task=(title:string):ChatSession=>({id:'lead',title:'Lead',messages:[],teamTasks:[{id:'a',title,ownerId:'other',status:'pending',dependsOn:[]},{id:'b',title:'task',ownerId:'member',status:'pending',dependsOn:['a']}]})
  const onSelect=vi.fn(),props={projectId:'p',activityHost:null,lead:task(prefix),members:[member],currentId:'lead',running:new Set<string>(),waiting:new Set<string>(),onSelect,onCreate:async()=>{},onStop:vi.fn()}
  const view=render(<AgentTeamTree {...props}/>)
  try{
   const exact=screen.getByRole('button',{name:`writer · 等待依赖：${prefix}`})
   expect(exact).toHaveTextContent(`等待依赖：${prefix}`);fireEvent.click(exact);expect(onSelect).toHaveBeenCalledWith('member')
   view.rerender(<AgentTeamTree {...props} lead={task(prefix+'z')}/> )
   const truncated=screen.getByRole('button',{name:`writer · 等待依赖：${prefix}…`})
   expect(truncated).toHaveTextContent(`等待依赖：${prefix}…`);fireEvent.click(truncated);expect(onSelect).toHaveBeenCalledTimes(2)
  }finally{view.unmount()}
 })
 it('fails safely on invalid graphs and bounds dependency titles',()=>{
  const member:ChatSession={id:'member',title:'Writer',teamMemberName:'writer',messages:[]}
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],teamTasks:[{id:'a',title:'x'.repeat(60),ownerId:'other',status:'pending',dependsOn:[]},{id:'b',title:'task',ownerId:'member',status:'pending',dependsOn:['a']}]}
  const props={projectId:'p',activityHost:null,lead,members:[member],currentId:'lead',running:new Set<string>(),waiting:new Set<string>(),onSelect:vi.fn(),onCreate:async()=>{},onStop:vi.fn()}
  const view=render(<AgentTeamTree {...props}/> )
  expect(screen.getByRole('button',{name:`writer · 等待依赖：${'x'.repeat(40)}…`})).toBeVisible()
  for(const dependsOn of [['missing'],['b']]){
   view.rerender(<AgentTeamTree {...props} lead={{...lead,teamTasks:[lead.teamTasks![0],{...lead.teamTasks![1],dependsOn}]}}/> )
   expect(screen.getByRole('button',{name:'writer · 任务数据无效'})).toBeVisible()
  }
  view.rerender(<AgentTeamTree {...props} waiting={new Set(['member'])} lead={{...lead,teamTasks:[{...lead.teamTasks![1],dependsOn:['missing']}]}}/> )
  expect(screen.getByRole('button',{name:'writer · 待审批'})).toBeVisible()
 })
})
describe('team activity presentation',()=>{
 it('keeps a compact accessible header with independent collapse and empty creation',()=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[]},member:ChatSession={id:'m',title:'M',teamMemberName:'小文',teamRole:'文案',messages:[]}
  const props={projectId:'p',activityHost:null,lead,members:[member],currentId:'lead',running:new Set<string>(),waiting:new Set<string>(),onSelect:vi.fn(),onCreate:async()=>{},onStop:vi.fn()}
  const view=render(<AgentTeamTree {...props}/> )
  const toggle=screen.getByRole('button',{name:'折叠团队成员'}),add=screen.getByRole('button',{name:'组建团队 / 添加成员'})
  expect(toggle.parentElement).toBe(add.parentElement);expect(screen.getByText('团队成员 · 1')).toBeVisible()
  expect(screen.getByRole('button',{name:/小文 · 文案/})).toContainElement(screen.getByTestId('PersonOutlineIcon'))
  fireEvent.click(toggle);expect(screen.getByRole('button',{name:'展开团队成员'})).toHaveAttribute('aria-expanded','false')
  fireEvent.click(screen.getByRole('button',{name:'展开团队成员'}));expect(screen.getByRole('button',{name:/小文 · 文案/})).toBeVisible()
  view.rerender(<AgentTeamTree {...props} members={[]}/>);expect(screen.getByText('团队成员 · 0')).toBeVisible();expect(add).toBeEnabled();fireEvent.click(add);expect(screen.getByLabelText('成员名')).toBeVisible()
  view.unmount()
 })
 it('shows bounded tool names and conservative statuses without arguments or outputs',()=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],profileId:'lead-model'}
  const tools=Array.from({length:12},(_,i)=>({runId:'run',toolCallId:String(i),toolName:`tool_${i}`,status:(i===8?'failed':i===9?'cancelled':i===10?'running':i===11?'unexpected':'completed') as 'completed',args:{secret:'PRIVATE_ARGUMENT'},content:'PRIVATE_RESULT'}))
  const member:ChatSession={id:'member',title:'Writer',teamMemberName:'writer',teamRole:'文案任务',messages:[{role:'assistant',content:'PRIVATE_CHAT',toolHistory:tools}]}
  const host=document.createElement('div');document.body.append(host)
  const select=vi.fn(),props={projectId:'project',activityHost:host,lead,leadModelName:'示例模型',members:[member],currentId:'lead',running:new Set<string>(),waiting:new Set<string>(),onSelect:select,onCreate:async()=>{},onStop:vi.fn()}
  const view=render(<AgentTeamTree {...props}/>)
  try {
   const details=host.querySelector('details')!,summary=details.querySelector('summary')!
   expect(details).not.toHaveAttribute('open')
   expect(screen.getByRole('button',{name:/writer.*文案任务/})).toBeVisible()
   expect(summary).toHaveTextContent('writer');expect(summary).toHaveTextContent('示例模型');expect(summary).not.toHaveTextContent('lead-model')
   expect(summary).toHaveTextContent('文案任务');expect(summary).not.toHaveTextContent('tool_11')
   expect(details).toHaveTextContent('角色/任务：文案任务')
   expect(host.querySelectorAll('li')).toHaveLength(10)
   expect(host.textContent).not.toContain('tool_0');expect(host.textContent).not.toContain('tool_1 ·')
   expect(host.textContent).toContain('tool_8 · 失败');expect(host.textContent).toContain('tool_9 · 已取消');expect(host.textContent).toContain('tool_10 · 未知')
   expect(host.textContent).not.toMatch(/PRIVATE_ARGUMENT|PRIVATE_RESULT|PRIVATE_CHAT/)
   fireEvent.click(summary);expect(details).toHaveAttribute('open')
   fireEvent.click(summary.querySelector('button')!);expect(select).toHaveBeenCalledWith('member')
   view.rerender(<AgentTeamTree {...props} leadModelName={undefined}/> )
   expect(host.querySelector('summary')).toHaveTextContent('组长模型');expect(host.textContent).not.toContain('lead-model')
   view.rerender(<AgentTeamTree {...props} members={[{...member,messages:[{role:'assistant',content:'',toolHistory:[tools[10]]}]}]}/> )
   expect(host.querySelector('summary')).toHaveTextContent('状态未知')
   view.rerender(<AgentTeamTree {...props} running={new Set(['member'])} members={[{...member,messages:[{role:'assistant',content:'',toolHistory:[tools[10]]}]}]}/> )
   expect(host.querySelector('summary')).toHaveTextContent('运行中')
   expect(host.querySelector('summary')).not.toHaveTextContent('当前工具')
  } finally {view.unmount();host.remove()}
 })
 it('bounds summary task and never infers a live tool from stale or current history',()=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[]}
  const tool={runId:'old-run',toolCallId:'call',toolName:'shell.execute',status:'running' as const,args:{secret:'SECRET_ARGS'},content:'SECRET_OUTPUT'}
  const member:ChatSession={id:'member',title:'Writer',teamMemberName:'writer',teamRole:'任'.repeat(50),messages:[{role:'assistant',content:'SECRET_CHAT',toolHistory:[tool]}]}
  const host=document.createElement('div');document.body.append(host)
  const props={projectId:'p',activityHost:host,lead,members:[member],currentId:'lead',running:new Set(['member']),waiting:new Set<string>(),onSelect:vi.fn(),onCreate:async()=>{},onStop:vi.fn()}
  const view=render(<AgentTeamTree {...props}/> )
  try{
   const summary=()=>host.querySelector('summary')!
   expect(summary()).toHaveTextContent(`${'任'.repeat(40)}…`)
   expect(summary()).not.toHaveTextContent('任'.repeat(41))
   view.rerender(<AgentTeamTree {...props} members={[{...member,teamRole:`${'任'.repeat(39)}😀尾`}]}/> )
   expect(summary()).toHaveTextContent(`${'任'.repeat(39)}😀…`)
   expect(summary().textContent).not.toContain('\uFFFD')
   expect(summary()).not.toHaveTextContent('工具:')
   expect(host.textContent).not.toMatch(/SECRET_ARGS|SECRET_OUTPUT|SECRET_CHAT/)
   view.rerender(<AgentTeamTree {...props} members={[{...member,messages:[...member.messages,{role:'user',content:'next turn'}]}]}/> )
   expect(summary()).not.toHaveTextContent('工具:')
   view.rerender(<AgentTeamTree {...props} members={[{...member,messages:[{role:'assistant',content:'',toolHistory:[{...tool,status:'completed'}]}]}]}/> )
   expect(summary()).not.toHaveTextContent('工具:')
   view.rerender(<AgentTeamTree {...props} running={new Set()}/> )
   expect(summary()).not.toHaveTextContent('工具:')
  }finally{view.unmount();host.remove()}
 })
 it('shows an empty tool hint without inventing a current tool',()=>{
  const host=document.createElement('div');document.body.append(host)
  const view=render(<AgentTeamTree projectId="p" activityHost={host} lead={{id:'lead',title:'Lead',messages:[]}} members={[{id:'m',title:'M',messages:[]}]} currentId="lead" running={new Set()} waiting={new Set()} onSelect={vi.fn()} onCreate={async()=>{}} onStop={vi.fn()}/> )
  try{expect(host.textContent).toContain('暂无工具步骤');expect(host.querySelector('summary')).not.toHaveTextContent('最近工具')}finally{view.unmount();host.remove()}
 })
 it('never displays an untrusted elapsed time across running, scope changes and remount',()=>{
  vi.useFakeTimers()
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],createdAt:1}
  const member:ChatSession={id:'member',teamMemberName:'writer',title:'Writer',messages:[],createdAt:2}
  const host=document.createElement('div');document.body.append(host)
  const props={projectId:'project-a',activityHost:host,lead,members:[member],currentId:'lead',running:new Set(['member']),waiting:new Set<string>(),onSelect:vi.fn(),onCreate:async()=>{},onStop:vi.fn()}
  const view=render(<AgentTeamTree {...props}/>)
  const noTime=()=>expect(host.querySelector('summary')?.textContent).not.toMatch(/\b\d+s\b|面板观察/)
  try{
   noTime();act(()=>vi.advanceTimersByTime(5000));noTime()
   view.rerender(<AgentTeamTree {...props} running={new Set()}/>);noTime()
   view.rerender(<AgentTeamTree {...props}/>);act(()=>vi.advanceTimersByTime(3000));noTime()
   view.rerender(<AgentTeamTree {...props} projectId="project-b" lead={{...lead,id:'other-lead'}}/>);noTime()
   view.rerender(<AgentTeamTree {...props} members={[]}/>);view.rerender(<AgentTeamTree {...props}/>);noTime()
   view.unmount()
   const remount=render(<AgentTeamTree {...props}/>);noTime();act(()=>vi.advanceTimersByTime(2000));noTime();remount.unmount()
  }finally{view.unmount();host.remove();vi.useRealTimers()}
 })
 it('retains selection and stop controls without the disabled-member warning',()=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],createdAt:1}
  const member:ChatSession={id:'member',teamLeadId:'lead',teamMemberName:'writer',title:'Writer',createdAt:2,messages:[]}
  const select=vi.fn(),stop=vi.fn()
  const props={projectId:'project-a',activityHost:null,lead,members:[member],running:new Set<string>(),waiting:new Set<string>(),onSelect:select,onCreate:async()=>{},onStop:stop}
  const view=render(<AgentTeamTree {...props} currentId="lead"/> )
  try{
   expect(screen.queryByText('成员执行暂不可用，请返回组长发送')).not.toBeInTheDocument()
   fireEvent.click(screen.getByRole('button',{name:/writer.*空闲/}))
   expect(select).toHaveBeenCalledWith('member')
   view.rerender(<AgentTeamTree {...props} currentId="member"/> )
   expect(screen.queryByText('成员执行暂不可用，请返回组长发送')).not.toBeInTheDocument()
   expect(screen.getByRole('button',{name:/返回组长/})).toBeVisible()
   fireEvent.click(screen.getByRole('button',{name:'停止 writer'}))
   expect(stop).toHaveBeenCalledWith('member')
   fireEvent.click(screen.getByRole('button',{name:/返回组长/}))
   expect(select).toHaveBeenCalledWith('lead')
  }finally{view.unmount()}
 })
 it('shows the current lead model rather than a stale member model',()=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],createdAt:1,profileId:'lead-model'}
  const member:ChatSession={id:'member',teamLeadId:'lead',teamMemberName:'writer',title:'Writer',createdAt:2,messages:[],profileId:'stale-member-model'}
  const host=document.createElement('div');document.body.append(host)
  const props={projectId:'project-a',activityHost:host,members:[member],currentId:'lead',running:new Set<string>(),waiting:new Set<string>(),onSelect:vi.fn(),onCreate:async()=>{},onStop:vi.fn()}
  const view=render(<AgentTeamTree {...props} lead={lead} leadModelName="组长显示模型"/> )
  try{
   expect(host.textContent).toContain('组长显示模型')
   expect(host.textContent).not.toContain('lead-model')
   expect(host.textContent).not.toContain('stale-member-model')
   view.rerender(<AgentTeamTree {...props} lead={{...lead,profileId:'new-lead-model'}} leadModelName="新模型"/> )
   expect(host.textContent).toContain('新模型');expect(host.textContent).not.toContain('组长显示模型');expect(host.textContent).not.toContain('new-lead-model')
  }finally{view.unmount();host.remove()}
 })
 it('keeps steps collapsed, marks waiting and places labeled images in exact project',()=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],createdAt:1}
  const member:ChatSession={id:'member',teamLeadId:'lead',teamMemberName:'设计师',title:'Designer',createdAt:2,messages:[{role:'assistant',content:'',attachments:[{type:'image',url:'data:image/png;base64,AA=='}]}]}
  const host=document.createElement('div');document.body.append(host)
  const view=render(<AgentTeamTree projectId="project-a" activityHost={host} lead={lead} members={[member]} currentId="lead" running={new Set(['member'])} waiting={new Set(['member'])} onSelect={vi.fn()} onCreate={async()=>{}} onStop={vi.fn()}/> )
  try{
   expect(host.querySelector('details')).not.toHaveAttribute('open')
   expect(host.textContent).toContain('待审批')
   fireEvent.click(screen.getByRole('button',{name:'投放 设计师·图1',hidden:true}))
   expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({fileName:'设计师·图1'}),'project-a','member',{teamImageLabel:'设计师·图1'})
  }finally{view.unmount();host.remove()}
 })
})
