import {act,render,screen,fireEvent,waitFor,within} from '@testing-library/react'
import {describe,it,expect,vi} from 'vitest'
import AgentTeamMenu from './AgentTeamMenu'
import type {ChatSession} from '../chatStorage'
const deferred = () => {
 let resolve!: (value:boolean)=>void, reject!: (reason?:unknown)=>void
 const promise=new Promise<boolean>((res,rej)=>{resolve=res;reject=rej})
 return {promise,resolve,reject}
}
describe('team menu summaries',()=>{
 it('closes the keyboard-opened team dialog on Escape and restores focus to the trigger',()=>{
  const host=document.createElement('div');document.body.append(host)
  const lead:ChatSession={id:'lead',title:'Lead',messages:[]},onSave=vi.fn(),onEnd=vi.fn()
  const view=render(<AgentTeamMenu lead={lead} members={[]} models={[]} onSave={onSave} onEnd={onEnd} buttonHost={host}/>)
  try{
   const trigger=screen.getByRole('button',{name:'团队管理'});act(()=>trigger.focus());fireEvent.click(trigger,{detail:0})
   const close=screen.getByRole('button',{name:'关闭团队管理'});expect(close).toHaveFocus()
   fireEvent.keyDown(close,{key:'Escape',code:'Escape'})
   expect(screen.queryByRole('dialog',{name:'团队管理'})).not.toBeInTheDocument()
   expect(trigger).toHaveFocus();expect(onSave).not.toHaveBeenCalled();expect(onEnd).not.toHaveBeenCalled()
  }finally{view.unmount();host.remove()}
 })
 it('moves focus for detail-zero trigger activation and restores only on explicit close while focused',()=>{
  const host=document.createElement('div');document.body.append(host)
  const lead:ChatSession={id:'lead',title:'Lead',messages:[]}
  const view=render(<AgentTeamMenu lead={lead} members={[]} models={[]} onSave={vi.fn()} onEnd={vi.fn()} buttonHost={host}/>)
  try{
   const trigger=screen.getByRole('button',{name:'团队管理'});act(()=>trigger.focus())
   fireEvent.click(trigger,{detail:0})
   const close=screen.getByRole('button',{name:'关闭团队管理'})
   expect(close).toHaveFocus()
   fireEvent.click(close,{detail:0});expect(trigger).toHaveFocus()
   fireEvent.click(trigger,{detail:0});expect(screen.getByRole('button',{name:'关闭团队管理'})).toHaveFocus()
   const outside=document.createElement('button');document.body.append(outside);act(()=>outside.focus())
   fireEvent.click(screen.getByRole('button',{name:'关闭团队管理'}));expect(outside).toHaveFocus();outside.remove()
  }finally{view.unmount();host.remove()}
 })
 it('does not move or restore focus for pointer activation or detached triggers',()=>{
  const host=document.createElement('div');document.body.append(host)
  const lead:ChatSession={id:'lead',title:'Lead',messages:[]}
  const view=render(<AgentTeamMenu lead={lead} members={[]} models={[]} onSave={vi.fn()} onEnd={vi.fn()} buttonHost={host}/>)
  try{
   const trigger=screen.getByRole('button',{name:'团队管理'});act(()=>trigger.focus())
   fireEvent.click(trigger,{detail:1});expect(trigger).toHaveFocus()
   const close=screen.getByRole('button',{name:'关闭团队管理'});act(()=>close.focus());fireEvent.click(close);expect(trigger).not.toHaveFocus()
   act(()=>trigger.focus());fireEvent.click(trigger,{detail:0});expect(screen.getByRole('button',{name:'关闭团队管理'})).toHaveFocus()
   host.remove();fireEvent.click(screen.getByRole('button',{name:'关闭团队管理'}));expect(trigger).not.toHaveFocus()
  }finally{view.unmount();host.remove()}
 })
 it('does not restore to a hidden origin or navigate focus on add and End',()=>{
  const host=document.createElement('div');document.body.append(host)
  const lead:ChatSession={id:'lead',title:'Lead',messages:[]},onEnd=vi.fn(),onAddMember=vi.fn()
  const view=render(<AgentTeamMenu lead={lead} members={[]} models={[]} onSave={vi.fn()} onEnd={onEnd} onAddMember={onAddMember} buttonHost={host}/>)
  try{
   const trigger=screen.getByRole('button',{name:'团队管理'});act(()=>trigger.focus());fireEvent.click(trigger,{detail:0})
   host.hidden=true;fireEvent.click(screen.getByRole('button',{name:'关闭团队管理'}));expect(trigger).not.toHaveFocus();host.hidden=false
   act(()=>trigger.focus());fireEvent.click(trigger,{detail:0});fireEvent.click(screen.getByRole('button',{name:'结束团队'}));expect(onEnd).toHaveBeenCalledOnce();expect(trigger).not.toHaveFocus()
   fireEvent.click(screen.getByRole('button',{name:'组建团队 / 添加成员'}));expect(onAddMember).toHaveBeenCalledOnce();expect(trigger).not.toHaveFocus()
  }finally{view.unmount();host.remove()}
 })
 it('does not restore focus to a trigger hidden by a transparent ancestor',()=>{
  const host=document.createElement('div');document.body.append(host)
  const lead:ChatSession={id:'lead',title:'Lead',messages:[]},onSave=vi.fn(),onEnd=vi.fn()
  const view=render(<AgentTeamMenu lead={lead} members={[]} models={[]} onSave={onSave} onEnd={onEnd} buttonHost={host}/>)
  try{
   const trigger=screen.getByRole('button',{name:'团队管理'});act(()=>trigger.focus());fireEvent.click(trigger,{detail:0})
   const close=screen.getByRole('button',{name:'关闭团队管理'});expect(close).toHaveFocus()
   host.style.opacity='0'
   fireEvent.click(close,{detail:0})
   expect(trigger).not.toHaveFocus()
   expect(onSave).not.toHaveBeenCalled();expect(onEnd).not.toHaveBeenCalled()
  }finally{view.unmount();host.remove()}
 })
 it('opens from an explicit zero-member request without adding a top trigger or reopening after close',async()=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:false}}
  const props={lead,members:[] as ChatSession[],models:[],onSave:vi.fn(),onEnd:vi.fn(),hideTriggerWithoutHost:true}
  const view=render(<AgentTeamMenu {...props} openRequest={0}/>)
  try {
   expect(screen.queryByRole('button',{name:'团队管理'})).not.toBeInTheDocument()
   expect(screen.queryByRole('dialog',{name:'团队管理'})).not.toBeInTheDocument()
   view.rerender(<AgentTeamMenu {...props} openRequest={1}/>)
   expect(screen.getByRole('dialog',{name:'团队管理'})).toBeVisible()
   await waitFor(()=>expect(screen.getByRole('button',{name:'关闭团队管理'})).toHaveFocus())
   fireEvent.click(screen.getByRole('button',{name:'关闭团队管理'}))
   view.rerender(<AgentTeamMenu {...props} openRequest={1}/>)
   expect(screen.queryByRole('dialog',{name:'团队管理'})).not.toBeInTheDocument()
   view.rerender(<AgentTeamMenu {...props} openRequest={2}/>)
   expect(screen.getByRole('dialog',{name:'团队管理'})).toBeVisible()
   expect(props.onSave).not.toHaveBeenCalled();expect(props.onEnd).not.toHaveBeenCalled()
  } finally {view.unmount()}
 })
 it('warns that a channel draft should be copied before ending, without blocking or sending it',()=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[]},onSave=vi.fn(),onEnd=vi.fn(),onBroadcast=vi.fn()
  const view=render(<AgentTeamMenu lead={lead} members={[]} models={[]} onSave={onSave} onEnd={onEnd} onBroadcast={onBroadcast}/> )
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   const end=screen.getByRole('button',{name:'结束团队'}),draft=screen.getByLabelText('频道消息')
   const warning='结束团队前请复制未发送的频道草稿，结束后不保证保留。'
   expect(screen.queryByText(warning)).not.toBeInTheDocument()
   fireEvent.change(draft,{target:{value:'本地频道草稿'}})
   expect(screen.getByText(warning)).toBeVisible()
   expect(end).toHaveAccessibleDescription(warning)
   expect(end).toBeEnabled();expect(draft).toHaveValue('本地频道草稿')
   expect(onSave).not.toHaveBeenCalled();expect(onBroadcast).not.toHaveBeenCalled()
   fireEvent.click(end)
   expect(onEnd).toHaveBeenCalledOnce();expect(onSave).not.toHaveBeenCalled();expect(onBroadcast).not.toHaveBeenCalled()
  }finally{view.unmount()}
 })
 it('shows current member capacity and empty states only while applicable',()=>{
  const onSave=vi.fn(), onEnd=vi.fn(), lead:ChatSession={id:'lead',title:'Lead',messages:[]}
  const props={lead,members:[] as ChatSession[],models:[],onSave,onEnd}
  const view=render(<AgentTeamMenu {...props}/>)
  try {
   expect(screen.queryByText('暂无共享任务')).not.toBeInTheDocument()
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   expect(screen.getByText('成员总数 0 · 上限 6')).toBeVisible()
   expect(screen.getByText('暂无共享任务')).toBeVisible();expect(screen.getByText('暂无频道记录')).toBeVisible()
   view.rerender(<AgentTeamMenu {...props} members={[{id:'m',title:'Member',messages:[],teamLeadId:'lead'}]} lead={{...lead,teamSettings:{maxMembers:3,defaultModel:null,autoCleanup:false},teamTasks:[{id:'t',title:'Task',ownerId:'',status:'pending',dependsOn:[]}],teamChannel:[{id:'c',senderId:'user',text:'Hello',createdAt:1}]}} />)
   expect(screen.getByText('成员总数 1 · 上限 3')).toBeVisible()
   expect(screen.queryByText('暂无共享任务')).not.toBeInTheDocument();expect(screen.queryByText('暂无频道记录')).not.toBeInTheDocument()
   view.rerender(<AgentTeamMenu {...props} lead={{...lead,teamSettings:{maxMembers:7,defaultModel:null,autoCleanup:false},teamTasks:[{id:'t',title:'Task',ownerId:'',status:'pending',dependsOn:['missing']}]}} />)
   expect(screen.getByText('成员总数 0 · 上限 设置无效')).toBeVisible()
   expect(screen.getByText('任务依赖无效')).toBeVisible();expect(screen.queryByText('暂无共享任务')).not.toBeInTheDocument()
   expect(screen.getByText('暂无频道记录')).toBeVisible()
   expect(onSave).not.toHaveBeenCalled();expect(onEnd).not.toHaveBeenCalled()
  } finally {view.unmount()}
 })
 it('shows when the saved channel record view omits older entries without changing data or dispatch',()=>{
  const records=Object.freeze(Array.from({length:52},(_,index)=>Object.freeze({id:`record-${index}`,senderId:'user',text:`独立记录${index}`,createdAt:index})))
  const lead:ChatSession={id:'lead',title:'Lead',messages:[]},onSave=vi.fn(),onBroadcast=vi.fn(),onEnd=vi.fn()
  const props={lead,members:[] as ChatSession[],models:[],onSave,onBroadcast,onEnd}
  const view=render(<AgentTeamMenu {...props} lead={{...lead,teamChannel:records.slice(0,50)}}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   expect(screen.queryByText('此处仅显示最近 50 条频道记录。')).not.toBeInTheDocument()
   view.rerender(<AgentTeamMenu {...props} lead={{...lead,teamChannel:records.slice()}}/>)
   expect(screen.getByText('此处仅显示最近 50 条频道记录。')).toBeVisible()
   expect(screen.queryByText('用户 · 独立记录0')).not.toBeInTheDocument()
   expect(screen.queryByText('用户 · 独立记录1')).not.toBeInTheDocument()
   expect(screen.getByText('用户 · 独立记录2')).toBeVisible()
   expect(screen.getByText('用户 · 独立记录51')).toBeVisible()
   expect(records).toHaveLength(52)
   expect(records.map(item=>item.text)).toEqual(Array.from({length:52},(_,index)=>`独立记录${index}`))
   expect(onSave).not.toHaveBeenCalled();expect(onBroadcast).not.toHaveBeenCalled();expect(onEnd).not.toHaveBeenCalled()
   view.rerender(<AgentTeamMenu {...props} lead={{...lead,teamChannel:records.slice(0,50)}}/>)
   expect(screen.queryByText('此处仅显示最近 50 条频道记录。')).not.toBeInTheDocument()
  }finally{view.unmount()}
 })
 it('warns before adding a 201st channel record and keeps the existing save and broadcast behavior',async()=>{
  const records=Object.freeze(Array.from({length:201},(_,index)=>Object.freeze({id:`record-limit-${index}`,senderId:'user',text:`记录${index}`,createdAt:index})))
  const lead:ChatSession={id:'lead',title:'Lead',messages:[]},onSave=vi.fn(async(_value:ChatSession)=>true),onBroadcast=vi.fn(),onEnd=vi.fn()
  const props={lead,members:[] as ChatSession[],models:[],onSave,onBroadcast,onEnd}
  const view=render(<AgentTeamMenu {...props} lead={{...lead,teamChannel:records.slice(0,199)}}/>)
  const warning='根据当前记录，添加新记录时只提交最后 199 条旧记录和新记录，较早记录不会包含在此次保存内容中；请先另存重要记录。'
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   expect(screen.queryByText(warning)).not.toBeInTheDocument()
   view.rerender(<AgentTeamMenu {...props} lead={{...lead,teamChannel:records.slice()}}/>)
   const add=screen.getByRole('button',{name:'添加到频道记录'})
   expect(screen.getByText(warning)).toBeVisible()
   expect(add).toHaveAccessibleDescription(warning)
   view.rerender(<AgentTeamMenu {...props} lead={{...lead,teamChannel:records.slice(0,200)}}/>)
   expect(screen.getByText(warning)).toBeVisible()
   expect(onSave).not.toHaveBeenCalled();expect(onBroadcast).not.toHaveBeenCalled()
   fireEvent.change(screen.getByLabelText('频道消息'),{target:{value:'新记录'}})
   fireEvent.click(add)
   await waitFor(()=>expect(onSave).toHaveBeenCalledOnce())
   const submitted=onSave.mock.calls[0][0].teamChannel!
   expect(submitted).toHaveLength(200)
   expect(submitted.slice(0,199)).toEqual(records.slice(1,200))
   expect(submitted[199]).toMatchObject({senderId:'user',text:'新记录'})
   expect(records).toHaveLength(201);expect(records[0].text).toBe('记录0')
   expect(onBroadcast).not.toHaveBeenCalled();expect(onEnd).not.toHaveBeenCalled()
  }finally{view.unmount()}
 })
 it('labels an optimistic setting unconfirmed until the save resolves',async()=>{
  const pending=deferred(),lead:ChatSession={id:'lead',title:'Lead',messages:[]}
  const props={lead,members:[],models:[],onEnd:vi.fn(),onSave:vi.fn(()=>pending.promise)}
  const view=render(<AgentTeamMenu {...props}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   fireEvent.change(screen.getByLabelText('最大成员数'),{target:{value:'3'}})
   view.rerender(<AgentTeamMenu {...props} lead={{...lead,teamSettings:{maxMembers:3,defaultModel:null,autoCleanup:false}}}/>)
   expect(screen.getByText('成员总数 0 · 上限 3（待确认）')).toBeVisible()
   await act(async()=>pending.resolve(false))
   expect(screen.getByText('成员总数 0 · 上限 3（待确认）')).toBeVisible()
  }finally{view.unmount()}
 })
})

describe('user channel broadcast', () => {
 const lead:ChatSession={id:'lead',title:'Lead',messages:[]}
 it.each([0,2])('reports %i queued without saving the record',async queued=>{
  const onSave=vi.fn(),onBroadcast=vi.fn(async(_input:{id:string;text:string})=>({queued}))
  const view=render(<AgentTeamMenu lead={lead} members={[]} models={[]} onEnd={vi.fn()} onSave={onSave} onBroadcast={onBroadcast}/>)
  try {
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   const input=screen.getByLabelText('频道消息')
   fireEvent.change(input,{target:{value:' hello '}})
   fireEvent.click(screen.getByRole('button',{name:'广播给订阅成员'}))
   expect(await screen.findByText(queued?'已排队，非送达':'未送出，请检查订阅')).toBeVisible()
   expect(input).toHaveValue(queued?'':' hello ')
   expect(onSave).not.toHaveBeenCalled()
   expect(onBroadcast).toHaveBeenCalledOnce()
   expect(onBroadcast.mock.calls[0][0]).toEqual({id:expect.any(String),text:'hello'})
  } finally {view.unmount()}
 })
 it('does not invoke a scheduled broadcast after unmount',async()=>{
  const onBroadcast=vi.fn(async()=>({queued:1}))
  const view=render(<AgentTeamMenu lead={lead} members={[]} models={[]} onEnd={vi.fn()} onSave={vi.fn()} onBroadcast={onBroadcast}/>)
  fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
  fireEvent.change(screen.getByLabelText('频道消息'),{target:{value:'hello'}})
  fireEvent.click(screen.getByRole('button',{name:'广播给订阅成员'}))
  view.unmount()
  await act(async()=>{await Promise.resolve()})
  expect(onBroadcast).not.toHaveBeenCalled()
 })
 it('locks pending broadcasts and retains text after rejection',async()=>{
  let reject!:(error:Error)=>void
  const onBroadcast=vi.fn(()=>new Promise<{queued:number}>((_resolve,rej)=>{reject=rej}))
  const onSave=vi.fn()
  const view=render(<AgentTeamMenu lead={lead} members={[]} models={[]} onEnd={vi.fn()} onSave={onSave} onBroadcast={onBroadcast}/>)
  try {
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   const input=screen.getByLabelText('频道消息'),button=screen.getByRole('button',{name:'广播给订阅成员'})
   fireEvent.change(input,{target:{value:'hello'}}); fireEvent.click(button); fireEvent.click(button)
   await waitFor(()=>expect(onBroadcast).toHaveBeenCalledOnce())
   expect(button).toBeDisabled(); expect(onSave).not.toHaveBeenCalled()
   await act(async()=>{reject(Error('full'))})
   expect(await screen.findByText('广播结果未确认，请先核对相关会话，避免重复发送。')).toBeVisible(); expect(input).toHaveValue('hello')
   expect(onBroadcast).toHaveBeenCalledOnce(); expect(onSave).not.toHaveBeenCalled()
  } finally {view.unmount()}
 })
 it.each([undefined, null, {}, {queued:-1}, {queued:1.5}, {queued:'1'}, {queued:false}, {queued:null}, {queued:'0'}, {queued:NaN}, {queued:Infinity}, {queued:Number.MAX_SAFE_INTEGER + 1}])('retains the broadcast draft and reports unknown for invalid results %#',async result=>{
  const onSave=vi.fn(),onBroadcast=vi.fn(async()=>result)
  const view=render(<AgentTeamMenu lead={lead} members={[]} models={[]} onEnd={vi.fn()} onSave={onSave} onBroadcast={onBroadcast as unknown as (input:{id:string;text:string})=>Promise<{queued:number}>}/>)
  try {
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   const input=screen.getByLabelText('频道消息')
   fireEvent.change(input,{target:{value:'hello'}}); fireEvent.click(screen.getByRole('button',{name:'广播给订阅成员'}))
   expect(await screen.findByText('广播结果未确认，请先核对相关会话，避免重复发送。')).toBeVisible()
   expect(input).toHaveValue('hello'); expect(onBroadcast).toHaveBeenCalledOnce(); expect(onSave).not.toHaveBeenCalled()
  } finally {view.unmount()}
 })
 it.each([0,Number.MAX_SAFE_INTEGER])('handles a synchronous result %s without saving the record',async queued=>{
  const onSave=vi.fn(),onBroadcast=vi.fn(()=>({queued}))
  const view=render(<AgentTeamMenu lead={lead} members={[]} models={[]} onEnd={vi.fn()} onSave={onSave} onBroadcast={onBroadcast}/>)
  try {
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   const input=screen.getByLabelText('频道消息')
   fireEvent.change(input,{target:{value:' hello '}}); fireEvent.click(screen.getByRole('button',{name:'广播给订阅成员'}))
   expect(await screen.findByText(queued?'已排队，非送达':'未送出，请检查订阅')).toBeVisible()
   expect(input).toHaveValue(queued?'':' hello '); expect(onBroadcast).toHaveBeenCalledOnce(); expect(onSave).not.toHaveBeenCalled()
  } finally {view.unmount()}
 })
 it('retains the draft and reports unknown when the broadcast callback throws synchronously',async()=>{
  const onSave=vi.fn(),onBroadcast=vi.fn(()=>{throw Error('unknown side effect')})
  const view=render(<AgentTeamMenu lead={lead} members={[]} models={[]} onEnd={vi.fn()} onSave={onSave} onBroadcast={onBroadcast}/>)
  try {
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   const input=screen.getByLabelText('频道消息')
   fireEvent.change(input,{target:{value:'hello'}}); fireEvent.click(screen.getByRole('button',{name:'广播给订阅成员'}))
   expect(await screen.findByText('广播结果未确认，请先核对相关会话，避免重复发送。')).toBeVisible()
   expect(input).toHaveValue('hello'); expect(onBroadcast).toHaveBeenCalledOnce(); expect(onSave).not.toHaveBeenCalled()
  } finally {view.unmount()}
 })
})

describe('reopen dependency explanation', () => {
 const makeLead = (status: 'pending' | 'running' | 'done'): ChatSession => ({ id: 'lead', title: 'Lead', messages: [], teamTasks: [
  { id: 'a', title: '前置', ownerId: '', status: 'done', dependsOn: [] },
  { id: 'b', title: '后续', ownerId: '', status, dependsOn: ['a'] }
 ] })
 it.each(['running', 'done'] as const)('explains blocked reopen when successor is %s', status => {
  const onSave = vi.fn(async (_value: ChatSession) => true), onDispatch = vi.fn()
  const view = render(<AgentTeamMenu lead={makeLead(status)} members={[]} models={[]} onEnd={vi.fn()} onSave={onSave} onDispatch={onDispatch} />)
  try {
   fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
   const row = screen.getByText(/前置 ·/).parentElement!
   const button = within(row).getByRole('button', { name: '当前列表第 1 项（位置随列表变化），重开：前置' })
   expect(button).toBeDisabled()
   const description = within(row).getByText('有进行中或已完成的后续任务，无法重开。')
   expect(description).toBeVisible()
   expect(description.id).not.toBe('')
   expect(button).toHaveAttribute('aria-describedby', description.id)
   fireEvent.click(button)
   expect(onSave).not.toHaveBeenCalled(); expect(onDispatch).not.toHaveBeenCalled()
  } finally { view.unmount() }
 })
 it('allows reopening when the successor is pending', async () => {
  const lead = makeLead('pending'), onSave = vi.fn(async (_value: ChatSession) => true), onDispatch = vi.fn()
  const view = render(<AgentTeamMenu lead={lead} members={[]} models={[]} onEnd={vi.fn()} onSave={onSave} onDispatch={onDispatch} />)
  try {
   fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
   const button = within(screen.getByText(/前置 ·/).parentElement!).getByRole('button', { name: '当前列表第 1 项（位置随列表变化），重开：前置' })
   expect(button).toBeEnabled(); expect(button).not.toHaveAttribute('aria-describedby')
   fireEvent.click(button)
   await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
   expect(onSave).toHaveBeenCalledWith({ ...lead, teamTasks: [{ ...lead.teamTasks![0], status: 'pending' }, lead.teamTasks![1]] })
   expect(onDispatch).not.toHaveBeenCalled()
  } finally { view.unmount() }
 })
 it('does not attribute a pending save lock to dependencies', async () => {
  const pending = deferred(), lead = makeLead('pending'), onSave = vi.fn(() => pending.promise), onDispatch = vi.fn()
  const view = render(<AgentTeamMenu lead={lead} members={[]} models={[]} onEnd={vi.fn()} onSave={onSave} onDispatch={onDispatch} />)
  try {
   fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
   fireEvent.change(screen.getByLabelText('最大成员数'), { target: { value: '3' } })
   const button = within(screen.getByText(/前置 ·/).parentElement!).getByRole('button', { name: '当前列表第 1 项（位置随列表变化），重开：前置' })
   expect(button).toBeDisabled(); expect(button).not.toHaveAttribute('aria-describedby')
   expect(screen.queryByText('有进行中或已完成的后续任务，无法重开。')).not.toBeInTheDocument()
   fireEvent.click(button); expect(onSave).toHaveBeenCalledOnce(); expect(onDispatch).not.toHaveBeenCalled()
   await act(async () => pending.resolve(true))
  } finally { view.unmount() }
 })
})

describe('running task result guidance', () => {
 it('shows neutral guidance only while running without changing task actions', async () => {
  const member: ChatSession = { id: 'member', title: 'Member', messages: [], teamLeadId: 'lead', teamMemberName: 'writer' }
  const task = { id: 'task', title: '任务一', ownerId: 'member', status: 'pending' as const, dependsOn: [] }
  const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: [task] }
  const onSave = vi.fn(async (_value: ChatSession) => true), onDispatch = vi.fn()
  const props = { lead, members: [member], models: [], onEnd: vi.fn(), onSave, onDispatch }
  const text = '任务状态不等于执行结果，请查看对应会话确认。'
  const view = render(<AgentTeamMenu {...props} />)
  try {
   fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
   expect(screen.queryByText(text)).not.toBeInTheDocument()
   fireEvent.click(screen.getByRole('button', { name: '执行 任务一' }))
   expect(onDispatch).toHaveBeenCalledExactlyOnceWith('task'); expect(onSave).not.toHaveBeenCalled()
   view.rerender(<AgentTeamMenu {...props} lead={{ ...lead, teamTasks: [{ ...task, status: 'running' }] }} />)
   expect(screen.getByText(text)).toBeVisible()
   expect(screen.getByRole('button', { name: '执行 任务一' })).toBeDisabled()
   expect(onSave).not.toHaveBeenCalled(); expect(onDispatch).toHaveBeenCalledTimes(1)
   const doneLead: ChatSession = { ...lead, teamTasks: [{ ...task, status: 'done' }] }
   view.rerender(<AgentTeamMenu {...props} lead={doneLead} />)
   expect(screen.queryByText(text)).not.toBeInTheDocument()
   fireEvent.click(screen.getByRole('button', { name: '当前列表第 1 项（位置随列表变化），重开：任务一' }))
   await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
   expect(onSave).toHaveBeenCalledWith({ ...doneLead, teamTasks: [task] })
   expect(onDispatch).toHaveBeenCalledTimes(1)
  } finally { view.unmount() }
 })
 it('uses the same neutral guidance for a running lead-owned task', () => {
  const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: [{ id: 'task', title: '组长任务', ownerId: '', status: 'running', dependsOn: [] }] }
  const onSave = vi.fn(), onDispatch = vi.fn()
  const view = render(<AgentTeamMenu lead={lead} members={[]} models={[]} onEnd={vi.fn()} onSave={onSave} onDispatch={onDispatch} />)
  try {
   fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
   expect(screen.getByText('任务状态不等于执行结果，请查看对应会话确认。')).toBeVisible()
   expect(screen.queryByText('任务状态不等于执行结果，请查看成员会话确认。')).not.toBeInTheDocument()
   expect(screen.getByText(/组长任务 · 组长 · 进行中/)).toBeVisible()
   expect(screen.getByRole('button', { name: '执行 组长任务' })).toBeDisabled()
   expect(onSave).not.toHaveBeenCalled(); expect(onDispatch).not.toHaveBeenCalled()
  } finally { view.unmount() }
 })
})

describe('manual task dispatch prototype', () => {
 const member: ChatSession = { id: 'member', title: 'Member', messages: [], teamLeadId: 'lead', teamMemberName: 'writer' }
 const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: [
  { id: 'a', title: '前置', ownerId: 'member', status: 'pending', dependsOn: [] },
  { id: 'b', title: '后续', ownerId: 'member', status: 'pending', dependsOn: ['a'] }
 ] }
 it('dispatches the selected task id only after dependencies are done', () => {
  const onDispatch = vi.fn(), props = { lead, members: [member], models: [], onEnd: vi.fn(), onSave: vi.fn(), onDispatch }
  const view = render(<AgentTeamMenu {...props} />)
  try {
   fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
   const blocked = screen.getByRole('button', { name: '执行 后续' })
   expect(blocked).toBeDisabled(); fireEvent.click(blocked); expect(onDispatch).not.toHaveBeenCalled()
   fireEvent.click(screen.getByRole('button', { name: '执行 前置' }))
   expect(onDispatch).toHaveBeenCalledExactlyOnceWith('a')
   view.rerender(<AgentTeamMenu {...props} lead={{ ...lead, teamTasks: lead.teamTasks!.map(task => task.id === 'a' ? { ...task, status: 'done' } : task) }} />)
   fireEvent.click(screen.getByRole('button', { name: '执行 后续' }))
   expect(onDispatch).toHaveBeenLastCalledWith('b'); expect(onDispatch).toHaveBeenCalledTimes(2)
  } finally { view.unmount() }
 })
 it.each([
  { name: 'ended', lead: { ...lead, teamEnded: true }, members: [member] },
  { name: 'missing member', lead, members: [] },
  { name: 'archived member', lead, members: [{ ...member, archived: true }] },
  { name: 'wrong generation', lead: { ...lead, teamGeneration: 1 }, members: [member] },
  { name: 'lead owner', lead: { ...lead, teamTasks: lead.teamTasks!.map(task => ({ ...task, ownerId: '' })) }, members: [member] },
  { name: 'running task', lead: { ...lead, teamTasks: lead.teamTasks!.map(task => task.id === 'a' ? { ...task, status: 'running' as const } : task) }, members: [member] }
 ])('does not dispatch for $name', ({ lead: testLead, members }) => {
  const onDispatch = vi.fn()
  const view = render(<AgentTeamMenu lead={testLead} members={members} models={[]} onEnd={vi.fn()} onSave={vi.fn()} onDispatch={onDispatch} />)
  try {
   fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
   const button = screen.getByRole('button', { name: '执行 前置' })
   expect(button).toBeDisabled(); fireEvent.click(button); expect(onDispatch).not.toHaveBeenCalled()
  } finally { view.unmount() }
 })
 it('explains that lead tasks cannot be dispatched and completion is only a status change', async () => {
  const task = { id: 'lead-task', title: '组长准备', ownerId: '', status: 'pending' as const, dependsOn: [] }
  const onDispatch = vi.fn(), onSave = vi.fn(async (_value: ChatSession) => true)
  const view = render(<AgentTeamMenu lead={{ ...lead, teamTasks: [task] }} members={[member]} models={[]} onEnd={vi.fn()} onSave={onSave} onDispatch={onDispatch} />)
  try {
   fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
   expect(screen.getByText('组长任务暂不支持执行')).toBeVisible()
   expect(screen.getByText('“完成”与“重开”只修改状态，不会运行或停止任务。')).toBeVisible()
   expect(screen.getByRole('button', { name: '执行 组长准备' })).toBeDisabled()
   fireEvent.click(screen.getByRole('button', { name: '当前列表第 1 项（位置随列表变化），完成：组长准备' }))
   await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
   expect(onSave.mock.calls[0][0].teamTasks).toEqual([{ ...task, status: 'done' }])
   expect(onDispatch).not.toHaveBeenCalled()
  } finally { view.unmount() }
 })
 it('disables dispatch when callback is absent', () => {
  const view = render(<AgentTeamMenu lead={lead} members={[member]} models={[]} onEnd={vi.fn()} onSave={vi.fn()} />)
  try {
   fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
   expect(screen.getByRole('button', { name: '执行 前置' })).toBeDisabled()
   expect(screen.getByText('任务执行尚未接入')).toBeVisible()
  } finally { view.unmount() }
 })
})

describe('draft save confirmation',()=>{
 const lead:ChatSession={id:'lead',title:'Lead',messages:[]}
 const drafts=[{label:'任务',button:'添加任务'},{label:'频道消息',button:'添加到频道记录'}]
 it.each(drafts)('locks double submissions and clears $label only after confirmation',async({label,button})=>{
  const pending=deferred(),save=vi.fn((_value:ChatSession)=>pending.promise)
  const props={lead,members:[],models:[],onEnd:vi.fn(),onSave:save}
  const view=render(<AgentTeamMenu {...props}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   const input=screen.getByLabelText(label),submit=screen.getByRole('button',{name:button})
   fireEvent.change(input,{target:{value:'待保存草稿'}})
   act(()=>{submit.click();submit.click()})
   expect(save).toHaveBeenCalledTimes(1)
   view.rerender(<AgentTeamMenu {...props} lead={save.mock.calls[0][0]}/>)
   const marked=label==='任务'?'待保存草稿 · 未确认 · 组长 · 待处理 · 依赖 无':'未确认 · 用户 · 待保存草稿'
   const confirmed=label==='任务'?'待保存草稿 · 组长 · 待处理 · 依赖 无':'用户 · 待保存草稿'
   expect(screen.getByText(marked,{exact:true})).toBeVisible()
   expect(input).toHaveValue('待保存草稿');expect(input).toHaveAttribute('readonly');expect(input).toBeEnabled();expect(submit).toBeDisabled()
   await act(async()=>pending.resolve(true))
   expect(screen.queryByText(marked,{exact:true})).not.toBeInTheDocument()
   expect(screen.getByText(confirmed,{exact:true})).toBeVisible()
   expect(input).toHaveValue('');expect(submit).toBeDisabled()
  }finally{view.unmount()}
 })
 it.each(drafts.flatMap(draft=>['false','reject'].map(outcome=>({...draft,outcome}))))('preserves $label and blocks retry on $outcome',async({label,button,outcome})=>{
  const pending=deferred(),save=vi.fn((_value:ChatSession)=>pending.promise)
  const initial:ChatSession={...lead,teamTasks:[{id:'prior-task',title:'保留草稿',ownerId:'',status:'pending',dependsOn:[]}],teamChannel:[{id:'prior-message',senderId:'user',text:'保留草稿',createdAt:1}]}
  const props={lead:initial,members:[],models:[],onEnd:vi.fn(),onSave:save}
  const view=render(<AgentTeamMenu {...props}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   const input=screen.getByLabelText(label),submit=screen.getByRole('button',{name:button})
   fireEvent.change(input,{target:{value:'保留草稿'}});fireEvent.click(submit)
   const candidate=save.mock.calls[0][0] as ChatSession
   view.rerender(<AgentTeamMenu {...props} lead={candidate}/>)
   await act(async()=>{if(outcome==='reject')pending.reject(new Error('unconfirmed'));else pending.resolve(false)})
   expect(input).toHaveValue('保留草稿');expect(input).toBeVisible();expect(input).toHaveAttribute('readonly');expect(input).toBeEnabled()
   const marked=label==='任务'?'保留草稿 · 未确认 · 组长 · 待处理 · 依赖 无':'未确认 · 用户 · 保留草稿'
   const unmarked=label==='任务'?'保留草稿 · 组长 · 待处理 · 依赖 无':'用户 · 保留草稿'
   expect(screen.getByText(marked,{exact:true})).toBeVisible()
   expect(screen.getByText(unmarked,{exact:true})).toBeVisible()
   expect(screen.getByText('保存未确认，请保留草稿并检查会话状态；切换团队前请复制草稿')).toBeVisible()
   expect(submit).toBeDisabled();fireEvent.click(submit);expect(save).toHaveBeenCalledTimes(1)
  }finally{view.unmount()}
 })
 it.each(drafts)('locks task transitions, dependencies and settings while $label is saving then restores them',async({label,button})=>{
  const pending=deferred(),save=vi.fn(()=>pending.promise),onEnd=vi.fn()
  const taskLead:ChatSession={...lead,profileId:'base',teamTasks:[{id:'a',title:'Alpha',ownerId:'',status:'pending',dependsOn:[]},{id:'b',title:'Beta',ownerId:'',status:'pending',dependsOn:[]}]}
  const view=render(<AgentTeamMenu lead={taskLead} members={[]} models={[{id:'base',name:'组长模型'}]} onEnd={onEnd} onSave={save}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   fireEvent.click(screen.getByText('编辑依赖 · Alpha'))
   const complete=screen.getByRole('button',{name:'当前列表第 1 项（位置随列表变化），完成：Alpha'})
   const dependency=screen.getByRole('checkbox',{name:'Alpha 依赖 Beta'})
   const count=screen.getByLabelText('最大成员数'),model=screen.getByRole('combobox',{name:'成员默认模型'}),archive=screen.getByRole('checkbox',{name:'结束后归档成员'})
   expect(complete).toBeEnabled();expect(dependency).toBeEnabled();expect(count).toBeEnabled();expect(model).not.toHaveAttribute('aria-disabled','true');expect(archive).toBeEnabled()
   const end=screen.getByRole('button',{name:'结束团队'})
   expect(end).toBeEnabled()
   fireEvent.change(screen.getByLabelText(label),{target:{value:'draft'}})
   fireEvent.click(screen.getByRole('button',{name:button}))
   expect(complete).toBeDisabled();expect(dependency).toBeDisabled();expect(count).toBeDisabled();expect(model).toHaveAttribute('aria-disabled','true');expect(archive).toBeDisabled()
   expect(end).toBeDisabled();end.click();end.click();expect(onEnd).not.toHaveBeenCalled()
   complete.click();dependency.click();archive.click()
   expect(save).toHaveBeenCalledTimes(1)
   await act(async()=>pending.resolve(true))
   expect(end).toBeEnabled();fireEvent.click(end);expect(onEnd).toHaveBeenCalledOnce()
   expect(complete).toBeEnabled();expect(dependency).toBeEnabled();expect(count).toBeEnabled();expect(model).not.toHaveAttribute('aria-disabled','true');expect(archive).toBeEnabled()
  }finally{view.unmount()}
 })
 it.each(drafts)('does not clear a new keyed scope $label when the old save resolves',async({label,button})=>{
  const pending=deferred(),save=vi.fn(()=>pending.promise)
  const props={lead,members:[],models:[],onEnd:vi.fn(),onSave:save}
  const view=render(<AgentTeamMenu key="a" {...props}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   fireEvent.change(screen.getByLabelText(label),{target:{value:'旧草稿'}})
   fireEvent.click(screen.getByRole('button',{name:button}))
   view.rerender(<AgentTeamMenu key="b" {...props} lead={{...lead,id:'other'}}/>)
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   const input=screen.getByLabelText(label)
   fireEvent.change(input,{target:{value:'新草稿'}})
   await act(async()=>pending.resolve(true))
   expect(input).toHaveValue('新草稿')
   expect(screen.getByRole('button',{name:button})).toBeEnabled()
   expect(save).toHaveBeenCalledTimes(1)
  }finally{view.unmount()}
 })
})
describe('unconfirmed safety regression',()=>{
 const lead:ChatSession={id:'lead',title:'Lead',messages:[],profileId:'base',teamTasks:[{id:'a',title:'Alpha',ownerId:'',status:'pending',dependsOn:[]},{id:'b',title:'Beta',ownerId:'',status:'pending',dependsOn:[]}]}
 it.each([{label:'任务',button:'添加任务'},{label:'频道消息',button:'添加到频道记录'}].flatMap(d=>['false','reject'].map(outcome=>({...d,outcome}))))('locks all writes after unconfirmed $label $outcome',async({label,button,outcome})=>{
  const pending=deferred(),save=vi.fn(()=>pending.promise),end=vi.fn()
  const view=render(<AgentTeamMenu lead={lead} members={[]} models={[{id:'base',name:'Base'}]} onEnd={end} onSave={save}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}));fireEvent.click(screen.getByText('编辑依赖 · Alpha'))
   const input=screen.getByLabelText(label) as HTMLInputElement
   fireEvent.change(input,{target:{value:'草稿可复制'}});fireEvent.click(screen.getByRole('button',{name:button}))
   await act(async()=>{if(outcome==='reject')pending.reject(new Error('failure'));else pending.resolve(false)})
   expect(input).toHaveValue('草稿可复制');expect(input).toHaveAttribute('readonly');expect(input).toBeEnabled()
   act(()=>{input.focus();input.select()});expect(input.selectionStart).toBe(0);expect(input.selectionEnd).toBe('草稿可复制'.length)
   expect(screen.getByRole('button',{name:button})).toBeDisabled()
   expect(screen.getByRole('button',{name:'当前列表第 1 项（位置随列表变化），完成：Alpha'})).toBeDisabled()
   expect(screen.getByRole('checkbox',{name:'Alpha 依赖 Beta'})).toBeDisabled()
   expect(screen.getByLabelText('最大成员数')).toBeDisabled()
   expect(screen.getByRole('combobox',{name:'成员默认模型'})).toHaveAttribute('aria-disabled','true')
   expect(screen.getByRole('checkbox',{name:'结束后归档成员'})).toBeDisabled()
   expect(screen.getByRole('button',{name:'结束团队'})).toBeDisabled()
   screen.getByRole('button',{name:button}).click();expect(save).toHaveBeenCalledTimes(1);expect(end).not.toHaveBeenCalled()
  }finally{view.unmount()}
 })
 it.each(['true','false','reject'])('serializes different setting saves and handles %s confirmation',async outcome=>{
  const pending=deferred(),save=vi.fn(()=>pending.promise)
  const view=render(<AgentTeamMenu lead={lead} members={[]} models={[{id:'base',name:'Base'}]} onEnd={vi.fn()} onSave={save}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   const count=screen.getByLabelText('最大成员数'),archive=screen.getByRole('checkbox',{name:'结束后归档成员'})
   act(()=>{fireEvent.change(count,{target:{value:'4'}});fireEvent.click(archive)})
   expect(save).toHaveBeenCalledTimes(1)
   await act(async()=>{if(outcome==='reject')pending.reject(new Error('failure'));else pending.resolve(outcome==='true')})
   if(outcome==='true'){
    expect(archive).toBeEnabled();fireEvent.click(archive);expect(save).toHaveBeenCalledTimes(2)
   }else{
    expect(screen.getByText(/保存未确认/)).toBeVisible();expect(archive).toBeDisabled();archive.click();expect(save).toHaveBeenCalledTimes(1)
   }
  }finally{view.unmount()}
 })
})
describe('compact team menu',()=>{
 it('starts collapsed and records task ownership without running a model',()=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],createdAt:1},save=vi.fn(async()=>true)
  const view=render(<AgentTeamMenu models={[]} onEnd={vi.fn()} lead={lead} members={[]} onSave={save}/> )
  try{
   expect(screen.queryByLabelText('任务')).toBeNull()
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   fireEvent.change(screen.getByLabelText('任务'),{target:{value:'check synthetic image'}})
   fireEvent.click(screen.getByRole('button',{name:'添加任务'}))
   expect(save).toHaveBeenCalledWith(expect.objectContaining({teamTasks:[expect.objectContaining({title:'check synthetic image',status:'pending',dependsOn:[]})]}))
  }finally{view.unmount()}
 })
 it.each(['组长','新人','原成员'])('requires explicit reselection of %s after selected owner leaves', choice=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],createdAt:1},save=vi.fn(async()=>true)
  const former:ChatSession={id:'former',title:'Former',messages:[],teamMemberName:'原成员'}
  const replacement:ChatSession={id:'new',title:'New',messages:[],teamMemberName:'新人'}
  const props={models:[],onEnd:vi.fn(),lead,onSave:save}
  const view=render(<AgentTeamMenu {...props} members={[former,replacement]}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   fireEvent.change(screen.getByLabelText('任务'),{target:{value:'保留草稿'}})
   fireEvent.mouseDown(screen.getByRole('combobox',{name:'负责人'}))
   fireEvent.click(screen.getByRole('option',{name:'原成员'}))
   expect(screen.getByRole('button',{name:'添加任务'})).toBeEnabled()
   view.rerender(<AgentTeamMenu {...props} members={[replacement]}/>)
   expect(screen.getByRole('combobox',{name:'负责人'})).toHaveTextContent('原成员（请选择）')
   expect(screen.getByRole('button',{name:'添加任务'})).toBeDisabled()
   fireEvent.click(screen.getByRole('button',{name:'添加任务'}))
   expect(save).not.toHaveBeenCalled()
   if(choice==='原成员') {
    view.rerender(<AgentTeamMenu {...props} members={[former,replacement]}/>)
    expect(screen.getByRole('button',{name:'添加任务'})).toBeDisabled()
   }
   fireEvent.mouseDown(screen.getByRole('combobox',{name:'负责人'}))
   fireEvent.click(screen.getByRole('option',{name:choice}))
   expect(screen.getByRole('button',{name:'添加任务'})).toBeEnabled()
   fireEvent.click(screen.getByRole('button',{name:'添加任务'}))
   expect(save).toHaveBeenCalledWith(expect.objectContaining({teamTasks:[expect.objectContaining({title:'保留草稿',ownerId:choice==='组长'?'':choice==='新人'?'new':'former'})]}))
  }finally{view.unmount()}
 })
 it('shows removed owners without relabeling their tasks as the lead',()=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],createdAt:1,teamTasks:[{id:'assigned',title:'Assigned',ownerId:'former-member',status:'pending',dependsOn:[]},{id:'lead-task',title:'Lead task',ownerId:'',status:'pending',dependsOn:[]}]}
  const view=render(<AgentTeamMenu models={[]} onEnd={vi.fn()} lead={lead} members={[]} onSave={vi.fn(async()=>true)}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   expect(screen.getByText(/Assigned · 原成员/)).toBeVisible()
   expect(screen.getByText(/Lead task · 组长/)).toBeVisible()
  }finally{view.unmount()}
 })
 it.each(['继承组长','组长模型'])('preserves an unavailable historical model until explicitly choosing %s',choice=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],profileId:'base',teamSettings:{maxMembers:4,defaultModel:'deleted',autoCleanup:false}}
  const save=vi.fn(async()=>true), props={onEnd:vi.fn(),lead,members:[],onSave:save}
  const view=render(<AgentTeamMenu {...props} models={[]}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   expect(screen.getByRole('combobox',{name:'成员默认模型'})).toHaveTextContent('原模型不可用')
   expect(save).not.toHaveBeenCalled()
   view.rerender(<AgentTeamMenu {...props} models={[{id:'base',name:'组长模型'},{id:'other',name:'其他模型'}]}/>)
   expect(screen.getByRole('combobox',{name:'成员默认模型'})).toHaveTextContent('原模型不可用')
   expect(save).not.toHaveBeenCalled()
   fireEvent.mouseDown(screen.getByRole('combobox',{name:'成员默认模型'}))
   expect(screen.getByRole('option',{name:'原模型不可用'})).toHaveAttribute('aria-disabled','true')
   expect(screen.getByRole('option',{name:'其他模型'})).toHaveAttribute('aria-disabled','true')
   fireEvent.click(screen.getByRole('option',{name:'其他模型'}));expect(save).not.toHaveBeenCalled()
   fireEvent.mouseDown(screen.getByRole('combobox',{name:'成员默认模型'}))
   fireEvent.click(screen.getByRole('option',{name:choice}))
   expect(save).toHaveBeenCalledOnce()
   expect(save).toHaveBeenCalledWith(expect.objectContaining({teamSettings:{maxMembers:4,defaultModel:choice==='继承组长'?null:'base',autoCleanup:false}}))
  }finally{view.unmount()}
 })
 it.each([{version:1,profileId:'other'}, {version:7,profileId:'future'}])('preserves an unhandled model selection when changing unrelated settings %#',async selection=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],profileId:'base',teamSettings:{maxMembers:6,defaultModel:'old',autoCleanup:false,memberModelSelection:selection} as unknown as NonNullable<ChatSession['teamSettings']>}
  const save=vi.fn(async()=>true)
  const view=render(<AgentTeamMenu models={[{id:'base',name:'组长模型'}]} onEnd={vi.fn()} lead={lead} members={[]} onSave={save}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   expect(screen.getByText('成员模型设置暂不可用')).toBeVisible()
   expect(screen.getByRole('textbox',{name:'成员默认模型'})).toBeDisabled()
   expect(screen.getByRole('textbox',{name:'成员默认模型'})).toHaveValue('设置暂不可用')
   expect(screen.queryByRole('combobox',{name:'成员默认模型'})).not.toBeInTheDocument()
   fireEvent.change(screen.getByLabelText('最大成员数'),{target:{value:'4'}})
   expect(save).toHaveBeenLastCalledWith(expect.objectContaining({teamSettings:{...lead.teamSettings,maxMembers:4}}))
   await waitFor(()=>expect(screen.getByRole('checkbox',{name:'结束后归档成员'})).toBeEnabled())
   fireEvent.click(screen.getByRole('checkbox',{name:'结束后归档成员'}))
   expect(save).toHaveBeenLastCalledWith(expect.objectContaining({teamSettings:{...lead.teamSettings,autoCleanup:true}}))
  }finally{view.unmount()}
 })
 it('explains that the team default is inherited when no explicit member choice exists', () => {
  const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], profileId: 'base' }
  const selected: ChatSession = { id: 'member', title: 'Member', messages: [], teamLeadId: 'lead', memberModelChoice: { version: 1, profileId: 'other' } }
  const view=render(<AgentTeamMenu models={[{ id: 'base', name: '组长模型' }, { id: 'other', name: '其他模型' }]} onEnd={vi.fn()} lead={lead} members={[selected]} onSave={vi.fn()} />)
  try {
   fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
   expect(screen.getByText('成员未单独选模型时继承组长')).toBeVisible()
   fireEvent.mouseDown(screen.getByRole('combobox', { name: '成员默认模型' }))
   expect(screen.getByRole('option', { name: '其他模型' })).toHaveAttribute('aria-disabled', 'true')
  } finally {view.unmount()}
 })
 it('keeps member model choices aligned with the lead and names archive behavior accurately',async()=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],createdAt:1,profileId:'base'}
  const save=vi.fn(async()=>true),end=vi.fn()
  const view=render(<AgentTeamMenu models={[{id:'base',name:'组长模型'},{id:'other',name:'其他模型'}]} onEnd={end} lead={lead} members={[]} onSave={save}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   expect(screen.getByText('成员未单独选模型时继承组长')).toBeVisible()
   fireEvent.mouseDown(screen.getByRole('combobox',{name:'成员默认模型'}))
   expect(screen.getByRole('option',{name:'其他模型'})).toHaveAttribute('aria-disabled','true')
   fireEvent.click(screen.getByRole('option',{name:'其他模型'}))
   expect(save).not.toHaveBeenCalled()
   fireEvent.mouseDown(screen.getByRole('combobox',{name:'成员默认模型'}))
   fireEvent.click(screen.getByRole('option',{name:'组长模型'}))
   expect(save).toHaveBeenCalledWith(expect.objectContaining({teamSettings:{maxMembers:6,defaultModel:'base',autoCleanup:false}}))
   await waitFor(()=>expect(screen.getByRole('checkbox',{name:'结束后归档成员'})).toBeEnabled())
   fireEvent.click(screen.getByRole('checkbox',{name:'结束后归档成员'}))
   expect(save).toHaveBeenCalledWith(expect.objectContaining({teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:true}}))
   expect(end).not.toHaveBeenCalled()
  }finally{view.unmount()}
 })
 it('labels the local channel record without implying member delivery',()=>{
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],createdAt:1,teamChannel:[{id:'old',senderId:'former',text:'prior note',createdAt:1}]},save=vi.fn(async()=>true)
  const view=render(<AgentTeamMenu models={[]} onEnd={vi.fn()} lead={lead} members={[]} onSave={save}/> )
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   expect(screen.getByText('记录与广播分开；广播会调用模型')).toBeVisible()
   expect(screen.getByText(/原成员 · prior note/)).toBeVisible()
   fireEvent.change(screen.getByLabelText('频道消息'),{target:{value:'synthetic note'}})
   fireEvent.click(screen.getByRole('button',{name:'添加到频道记录'}))
   expect(save).toHaveBeenCalledWith(expect.objectContaining({teamChannel:[lead.teamChannel![0],expect.objectContaining({senderId:'user',text:'synthetic note'})]}))
  }finally{view.unmount()}
 })
 it('preserves channel record whitespace and wraps long unbroken text without writes',()=>{
  const text=`第一行\n第二行  间隔 ${'长'.repeat(300)}`
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],teamChannel:[{id:'multi',senderId:'user',text,createdAt:1},{id:'normal',senderId:'user',text:'普通记录',createdAt:2}]}
  const save=vi.fn(),broadcast=vi.fn()
  const view=render(<AgentTeamMenu models={[]} onEnd={vi.fn()} lead={lead} members={[]} onSave={save} onBroadcast={broadcast}/> )
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   const row=screen.getByText((_,element)=>element?.textContent===`用户 · ${text}`)
   expect(row.textContent).toBe(`用户 · ${text}`)
   expect(row).toHaveStyle({whiteSpace:'pre-wrap',overflowWrap:'anywhere'})
   expect(screen.getByText('用户 · 普通记录')).toBeVisible()
   expect(save).not.toHaveBeenCalled();expect(broadcast).not.toHaveBeenCalled()
  }finally{view.unmount()}
 })
 it('renders task statuses and dependency editing as local records',()=>{
  const done={id:'done',title:'准备',ownerId:'',status:'done' as const,dependsOn:[]}
  const running={id:'running',title:'处理',ownerId:'',status:'running' as const,dependsOn:['done']}
  const pending={id:'pending',title:'检查',ownerId:'',status:'pending' as const,dependsOn:['running']}
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],teamTasks:[done,running,pending]},save=vi.fn(async()=>true)
  const view=render(<AgentTeamMenu models={[]} onEnd={vi.fn()} lead={lead} members={[]} onSave={save}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   expect(screen.getByText('任务执行尚未接入')).toBeVisible()
   expect(screen.getByText('准备 · 组长 · 已完成 · 依赖 无')).toBeVisible()
   expect(screen.getByText('处理 · 组长 · 进行中 · 依赖 准备')).toBeVisible()
   expect(screen.getByText('检查 · 组长 · 待处理 · 依赖 处理 · 等待 处理')).toBeVisible()
   fireEvent.click(screen.getByText('编辑依赖 · 检查'))
   const dependency=screen.getByRole('checkbox',{name:'检查 依赖 处理'})
   expect(dependency).toBeChecked()
   fireEvent.click(dependency)
   expect(save).toHaveBeenCalledWith(expect.objectContaining({teamTasks:[done,running,{...pending,dependsOn:[]}]}))
  }finally{view.unmount()}
 })
 it('explains graph-invalid dependency choices accessibly without labelling valid or removable choices',()=>{
  const first={id:'first',title:'Prepare',ownerId:'',status:'pending' as const,dependsOn:[]}
  const second={id:'second',title:'Execute',ownerId:'',status:'pending' as const,dependsOn:['first']}
  const third={id:'third',title:'Review',ownerId:'',status:'pending' as const,dependsOn:[]}
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],teamTasks:[first,second,third]},save=vi.fn(async()=>true)
  const view=render(<AgentTeamMenu models={[]} onEnd={vi.fn()} lead={lead} members={[]} onSave={save}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   fireEvent.click(screen.getByText('编辑依赖 · Prepare'))
   const invalid=screen.getByRole('checkbox',{name:'Prepare 依赖 Execute'})
   const valid=screen.getByRole('checkbox',{name:'Prepare 依赖 Review'})
   expect(invalid).toBeDisabled()
   expect(invalid).toHaveAccessibleDescription('不可选择：任务依赖或状态不允许')
   expect(valid).toBeEnabled();expect(valid).not.toHaveAccessibleDescription('不可选择：任务依赖或状态不允许')
   fireEvent.click(screen.getByText('编辑依赖 · Execute'))
   const selected=screen.getByRole('checkbox',{name:'Execute 依赖 Prepare'})
   expect(selected).toBeChecked();expect(selected).toBeEnabled()
   expect(selected).not.toHaveAccessibleDescription('不可选择：任务依赖或状态不允许')
   fireEvent.click(selected)
   expect(save).toHaveBeenCalledWith(expect.objectContaining({teamTasks:[first,{...second,dependsOn:[]},third]}))
  }finally{view.unmount()}
 })
 it('does not describe a valid dependency as graph-invalid when only a draft save locks it',async()=>{
  const pending=deferred(),save=vi.fn(()=>pending.promise)
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],teamTasks:[{id:'a',title:'Alpha',ownerId:'',status:'pending',dependsOn:[]},{id:'b',title:'Beta',ownerId:'',status:'pending',dependsOn:[]}]}
  const view=render(<AgentTeamMenu models={[]} onEnd={vi.fn()} lead={lead} members={[]} onSave={save}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}));fireEvent.click(screen.getByText('编辑依赖 · Alpha'))
   const dependency=screen.getByRole('checkbox',{name:'Alpha 依赖 Beta'})
   fireEvent.change(screen.getByLabelText('任务'),{target:{value:'draft'}});fireEvent.click(screen.getByRole('button',{name:'添加任务'}))
   expect(dependency).toBeDisabled()
   expect(dependency).not.toHaveAccessibleDescription('不可选择：任务依赖或状态不允许')
   expect(save).toHaveBeenCalledTimes(1)
   await act(async()=>pending.resolve(true))
   expect(dependency).toBeEnabled()
  }finally{view.unmount()}
 })
 it('records selected dependencies and disables completion while waiting',async()=>{
  const first={id:'first',title:'Prepare',ownerId:'',status:'pending' as const,dependsOn:[]}
  const second={id:'second',title:'Execute',ownerId:'',status:'pending' as const,dependsOn:['first']}
  const lead:ChatSession={id:'lead',title:'Lead',messages:[],createdAt:1,teamTasks:[first,second]},save=vi.fn(async()=>true)
  const view=render(<AgentTeamMenu models={[]} onEnd={vi.fn()} lead={lead} members={[]} onSave={save}/>)
  try{
   fireEvent.click(screen.getByRole('button',{name:'团队管理'}))
   expect(screen.getByText(/等待 Prepare/)).toBeVisible()
   expect(screen.getByRole('button',{name:'当前列表第 2 项（位置随列表变化），完成：Execute'})).toBeDisabled()
   fireEvent.click(screen.getByText('编辑依赖 · Prepare'))
   expect(screen.getByRole('checkbox',{name:'Prepare 依赖 Execute'})).toBeDisabled()
   fireEvent.click(screen.getByText('编辑依赖 · Execute'))
   fireEvent.click(screen.getByRole('checkbox',{name:'Execute 依赖 Prepare'}))
   expect(save).toHaveBeenCalledWith(expect.objectContaining({teamTasks:[first,{...second,dependsOn:[]}]}))
   await waitFor(()=>expect(screen.getByRole('checkbox',{name:'Execute 依赖 Prepare'})).toBeEnabled())
   fireEvent.change(screen.getByLabelText('任务'),{target:{value:'Review'}})
   fireEvent.click(screen.getByRole('checkbox',{name:'Prepare'}))
   fireEvent.click(screen.getByRole('button',{name:'添加任务'}))
   expect(save).toHaveBeenCalledWith(expect.objectContaining({teamTasks:[first,second,expect.objectContaining({title:'Review',dependsOn:['first']})]}))
  }finally{view.unmount()}
 })
})
