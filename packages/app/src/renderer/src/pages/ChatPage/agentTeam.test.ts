import {describe,it,expect} from 'vitest'
import {createTeamMember,resolveTeamRecipient,memberActivity,resolveTeamRequestSettings,readMemberModelChoice} from './agentTeam'
import type {ChatSession} from './chatStorage'
describe('member choice data and routing', () => {
 it('routes only a strict explicit member marker and preserves inherited skill', () => {
  const lead: ChatSession = {id:'l',title:'Lead',messages:[],profileId:'lead'}
  const member: ChatSession = {id:'m',title:'Member',messages:[],teamLeadId:'l',teamMemberName:'member',profileId:'historic'}
  expect(readMemberModelChoice(member)).toBeNull()
  const chosen = {...member,memberModelChoice:{version:1 as const,profileId:'chosen'}}
  expect(readMemberModelChoice(chosen)).toBe('chosen')
  expect(resolveTeamRequestSettings(chosen,lead)).toEqual({profileId:'chosen',skillId:null})
  for (const marker of [undefined, null, {version:2,profileId:'x'}, {version:1,profileId:' x'}, {version:1,profileId:'x',extra:true}]) {
   expect(() => readMemberModelChoice({...member,memberModelChoice:marker} as ChatSession)).toThrow()
   expect(() => resolveTeamRequestSettings({...member,memberModelChoice:marker} as ChatSession,lead)).toThrow()
  }
 })
})

describe('right-column team ownership',()=>{
 const lead:ChatSession={id:'lead',title:'Lead',messages:[],createdAt:1,profileId:'model-a',skillId:'skill-a',sessionUrl:'must-not-copy'}
 it('creates independent member history without continuation or elevated model selection',()=>{
  const member=createTeamMember(lead,'设计师','图片设计','member',2)
  expect(member).toMatchObject({teamLeadId:'lead',profileId:'model-a',skillId:'skill-a',messages:[]})
  expect(member.sessionUrl).toBeUndefined();expect(lead.messages).toEqual([])
  expect(resolveTeamRecipient('@设计师 draw a tree',[member])).toEqual({session:member,text:'draw a tree'})
  expect(()=>createTeamMember(member,'nested','role','nested',3)).toThrow()
 })
 it('derives current tools and error state without publishing member steps into lead history',()=>{
  const member=createTeamMember(lead,'writer','notes','member',2)
  member.messages=[{role:'assistant',content:'',toolHistory:[{runId:'r',toolCallId:'t',toolName:'files.read',args:{},status:'failed'}]}]
  expect(memberActivity(member,false)).toMatchObject({failed:true,status:'出错',tool:'files.read'})
  expect(memberActivity(member,true).status).toBe('运行中')
  expect(lead.messages).toEqual([])
 })
 it('resolves member settings only from the live lead, honoring explicit none and team model',()=>{
  const member={...createTeamMember(lead,'writer','notes','member',2),skillId:'elevated-member-skill',profileId:'member-profile'}
  expect(resolveTeamRequestSettings(member,{...lead,skillId:undefined,profileId:undefined})).toEqual({skillId:null,profileId:null})
  expect(resolveTeamRequestSettings(member,{...lead,skillId:'lead-skill',profileId:'lead-profile'})).toEqual({skillId:'lead-skill',profileId:'lead-profile'})
  expect(resolveTeamRequestSettings(member,{...lead,teamSettings:{maxMembers:6,defaultModel:'team-model',autoCleanup:false}})).toMatchObject({profileId:'model-a'})
  expect(()=>resolveTeamRequestSettings(member,undefined)).toThrow()
  expect(()=>resolveTeamRequestSettings(member,{...lead,id:'other'})).toThrow()
  expect(()=>resolveTeamRequestSettings(member,{...lead,teamLeadId:'nested'})).toThrow()
  expect(()=>resolveTeamRequestSettings(member,{...lead,archived:true})).toThrow()
  expect(()=>resolveTeamRequestSettings({...member,archived:true},lead)).toThrow()
 })
 it('keeps unmarked historical defaults inherited and rejects the legacy lead marker',()=>{
  const member=createTeamMember(lead,'writer','notes','member',2)
  const settings={maxMembers:6,defaultModel:'historic-other',autoCleanup:false}
  expect(resolveTeamRequestSettings(member,{...lead,teamSettings:settings}).profileId).toBe('model-a')
  expect(()=>resolveTeamRequestSettings(member,{...lead,teamSettings:{...settings,memberModelSelection:{version:1,profileId:'model-b'}}} as ChatSession)).toThrow('Team model selection is not available yet.')
  expect(()=>resolveTeamRequestSettings(member,{...lead,teamSettings:{...settings,memberModelSelection:{version:2,profileId:'model-b'}}} as unknown as ChatSession)).toThrow()
 })
 it('inherits the live lead for every unmarked legacy default, but rejects versioned settings until routing is authorized',()=>{
  const member=createTeamMember(lead,'writer','notes','member',2)
  for(const defaultModel of [null,'','model-a','historical-other','missing-profile']) {
   expect(resolveTeamRequestSettings(member,{...lead,teamSettings:{maxMembers:6,defaultModel,autoCleanup:false}})).toEqual({skillId:'skill-a',profileId:'model-a'})
  }
  expect(()=>resolveTeamRequestSettings(member,{...lead,teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:false,memberModelSelection:{version:1,profileId:'model-b'}}})).toThrow('Team model selection is not available yet.')
 })
 it('rejects malformed explicit choices without treating them as inherit',()=>{
  const member=createTeamMember(lead,'writer','notes','member',2)
  const settings={maxMembers:6,defaultModel:null,autoCleanup:false}
  for(const selection of [null,{}, {version:1,profileId:''}, {version:1,profileId:'model-b',extra:true}, {version:2,profileId:'model-b'}]) {
   expect(()=>resolveTeamRequestSettings(member,{...lead,teamSettings:{...settings,memberModelSelection:selection}} as unknown as ChatSession)).toThrow()
  }
 })
 it('does not create or start members after the lead has ended',()=>{
  const member=createTeamMember(lead,'writer','notes','member',2)
  const ended={...lead,teamEnded:true}
  expect(()=>createTeamMember(ended,'second','notes','second',3)).toThrow('Team unavailable')
  expect(()=>resolveTeamRequestSettings(member,ended)).toThrow('Team owner unavailable')
 })
 it('rejects ambiguous recipients rather than broadcasting or falling through to lead',()=>{
  const member=createTeamMember(lead,'writer','文案','member',2)
  expect(()=>resolveTeamRecipient('@writer hello',[member,{...member,id:'other'}])).toThrow()
 })
})
