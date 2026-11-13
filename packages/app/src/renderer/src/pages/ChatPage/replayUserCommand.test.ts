import { describe, expect, it } from 'vitest'
import { parseReplayUserCommand, planReplay } from './replayUserCommand'
import type { ChatMessage } from '@shared/llm'
describe('P6 supplied branch replay planning', () => {
  it('parses strict commands without invoking provider or mutating history', () => {
    expect(parseReplayUserCommand('/branch')).toEqual({kind:'branch'})
    expect(parseReplayUserCommand('/edit 1 changed')).toEqual({kind:'edit',index:0,text:'changed'})
    expect(()=>parseReplayUserCommand('/regen extra')).toThrow()
    const messages: ChatMessage[] = [{role:'user',content:'original'},{role:'assistant',content:'old answer'}]
    const plan = planReplay(messages,{kind:'regen'})
    expect(plan).toMatchObject({ content:'original',baseMessages:[],originalMessages:messages })
    expect(messages).toHaveLength(2)
    expect(plan.originalMessages).not.toBe(messages)
  })
  it('rejects replay of tool or hidden context rather than silently re-executing effects', () => {
    expect(()=>planReplay([{role:'user',content:'/branch'}],{kind:'regen'})).toThrow('Slash-prefixed')
    expect(()=>planReplay([{role:'user',content:'old'}],{kind:'edit',index:0,text:'/regen'})).toThrow('Slash-prefixed')
    expect(()=>planReplay([{role:'user',content:'old',hiddenContext:'private'}],{kind:'regen'})).toThrow()
    expect(()=>planReplay([{role:'assistant',content:'not a user'}],{kind:'edit',index:0,text:'changed'})).toThrow()
  })
})
