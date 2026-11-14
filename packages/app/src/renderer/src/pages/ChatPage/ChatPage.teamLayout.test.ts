import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, 'ChatPage.tsx'), 'utf8')
const file = ts.createSourceFile('ChatPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

describe('conversation process area structure', () => {
  it('mounts one shared process area and keeps team management out of the top toolbar', () => {
    const names: string[] = []
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node)) names.push(node.tagName.getText(file))
      if (ts.isJsxOpeningElement(node)) names.push(node.tagName.getText(file))
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(names.filter(name => name === 'AgentProcessArea')).toHaveLength(1)
    expect(names.filter(name => name === 'AgentTeamMemberForm')).toHaveLength(1)
    expect(names).not.toContain('AgentTeamMemberCreator')
    expect(names.filter(name => name === 'TeamLeadJobEntries')).toHaveLength(1)
    expect(source.match(/\buseTeamImagePlacement\(/g)).toHaveLength(1)
    expect(names).not.toContain('AgentTeamTree')
    expect(names).not.toContain('AgentTeamStatus')
    expect(names).not.toContain('AgentThreadJobsPanel')
    expect(names).not.toContain('AgentThreadProcessesPanel')
    // Team management has no trigger of its own; the composer "+" menu opens it and the member form.
    expect(source).not.toContain('buttonHost=')
    expect(source).not.toContain('managementSlot=')
    expect(source).toContain('hideTriggerWithoutHost')
    expect(source).toContain('key="team-management"')
    expect(source).toContain('key="team-add-member"')
    expect(source).toContain('setCreatingTeamMember(true)')
    expect(source).not.toContain('team-conversation-actions')
  })
})
