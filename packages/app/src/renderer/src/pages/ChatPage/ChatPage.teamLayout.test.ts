import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, 'ChatPage.tsx'), 'utf8')
const file = ts.createSourceFile(
  'ChatPage.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)

describe('conversation team structure', () => {
  it('keeps member rows without mounting team management in the column header or composer', () => {
    const names: string[] = []
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node)) names.push(node.tagName.getText(file))
      if (ts.isJsxOpeningElement(node)) names.push(node.tagName.getText(file))
      ts.forEachChild(node, visit)
    }
    visit(file)
    // Helper jobs and processes are listed by /jobs; finished ones leave a divider in the transcript.
    expect(names).not.toContain('AgentProcessArea')
    // No "add member" form: upstream has no such entry, and nothing here opens one.
    expect(names).not.toContain('AgentTeamMemberForm')
    expect(names).not.toContain('AgentTeamMemberCreator')
    expect(names).not.toContain('TeamLeadJobEntries')
    expect(source.match(/\buseTeamImagePlacement\(/g)).toHaveLength(1)
    expect(names).not.toContain('AgentTeamTree')
    expect(names).not.toContain('AgentTeamStatus')
    expect(names).not.toContain('AgentThreadJobsPanel')
    expect(names).not.toContain('AgentThreadProcessesPanel')
    expect(names).not.toContain('AgentTeamMenu')
    expect(names).toContain('AgentTeamThreadRows')
    expect(source).not.toContain('buttonHost=')
    expect(source).not.toContain('managementSlot=')
    expect(source).not.toContain('hideTriggerWithoutHost')
    expect(source).not.toContain('addMenuSlot=')
    expect(source).not.toContain('agent-header-team')
    expect(source).not.toContain('agent-header-add-member')
    expect(source).not.toContain('setCreatingTeamMember')
    expect(source).not.toContain('team-conversation-actions')
  })
})
