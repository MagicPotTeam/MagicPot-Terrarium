import React, { useMemo, useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Box } from '@mui/material'
import ChatPrimarySelection from './components/ChatPrimarySelection'
import {
  NO_SKILL_VALUE,
  findCustomSkillById,
  getCustomSkillName,
  getSkillCategoryForSkillId
} from './chatSkillUtils'
import {
  BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
  BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
  mergeBuiltInSkills
} from './builtInSkills'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

const persistedCustomSkills = [
  {
    id: 'design-critic',
    category: 'Design',
    skillName: 'Design Critic',
    prompt: 'Review the design.',
    type: 'normal' as const
  },
  {
    id: 'ops-agent',
    category: 'Ops',
    skillName: 'Ops Agent',
    prompt: 'Handle operational tasks.',
    type: 'agent' as const,
    apiAddress: 'https://example.com/agent'
  },
  {
    id: 'ops-draft',
    category: 'Ops',
    skillName: 'Ops Draft',
    prompt: 'Draft operational copy.',
    type: 'normal' as const
  }
]

const availableSkills = mergeBuiltInSkills(persistedCustomSkills, { language: 'zh-CN' })

const selectedProfileId = 'gpt-4o'

const SkillHarness: React.FC = () => {
  const [activeProfileId, setActiveProfileId] = useState<string | null>(selectedProfileId)
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [selectedSkillCategory, setSelectedSkillCategory] = useState<string>(NO_SKILL_VALUE)

  const selectedSkill = useMemo(
    () => findCustomSkillById(availableSkills, selectedSkillId),
    [selectedSkillId]
  )

  const handleSelectSkill = (skillId: string | null) => {
    const nextSkill = findCustomSkillById(availableSkills, skillId)
    const nextCategory = nextSkill
      ? getSkillCategoryForSkillId(availableSkills, nextSkill.id)
      : selectedSkillCategory || NO_SKILL_VALUE

    setSelectedSkillId(nextSkill?.id || null)
    setSelectedSkillCategory(nextCategory)
  }

  return (
    <Box sx={{ p: 4 }}>
      <ChatPrimarySelection
        compact={false}
        isAgentSkillSelected={selectedSkill?.type === 'agent'}
        selectedProfileId={activeProfileId}
        availableProfiles={[{ id: selectedProfileId, model_name: 'GPT-4o' }]}
        selectedSkillLabel={selectedSkill ? getCustomSkillName(selectedSkill) : 'chat.skill_none'}
        onSelectProfile={setActiveProfileId}
      />
      {/* Stands in for the "/" menu's Skills group: one control per skill. */}
      <Box sx={{ mt: 4 }} data-skill-category={selectedSkillCategory}>
        {availableSkills.map((skill) => (
          <button
            key={skill.id}
            type="button"
            aria-pressed={skill.id === selectedSkillId}
            onClick={() => handleSelectSkill(skill.id === selectedSkillId ? null : skill.id)}
          >
            {`choose ${getCustomSkillName(skill)}`}
          </button>
        ))}
      </Box>
    </Box>
  )
}

describe('ChatPage agent skill flow', () => {
  it('keeps the model selector while a normal skill is selected', async () => {
    render(<SkillHarness />)
    const user = userEvent.setup()

    expect(screen.getByRole('button', { name: 'GPT-4o' })).toBeInTheDocument()

    const opsDraftSkill = screen.getByRole('button', { name: 'choose Ops Draft' })
    await user.click(opsDraftSkill)
    expect(opsDraftSkill).toHaveAttribute('aria-pressed', 'true')
    expect(opsDraftSkill.parentElement).toHaveAttribute('data-skill-category', 'Ops')

    expect(screen.getByRole('button', { name: 'GPT-4o' })).toBeInTheDocument()
    expect(screen.getByText('chat.model:')).toBeTruthy()
    expect(screen.queryByText('chat.agent_skill_active:')).toBeNull()

    await user.click(opsDraftSkill)
    expect(screen.getByRole('button', { name: 'GPT-4o' })).toBeInTheDocument()
  })

  it('switches the primary selector into agent mode after choosing an agent skill', async () => {
    render(<SkillHarness />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'choose Ops Agent' }))

    expect(screen.queryByRole('button', { name: 'GPT-4o' })).toBeNull()
    expect(screen.getByText('chat.agent_skill_active:')).toBeTruthy()
    expect(screen.getAllByText('Ops Agent').length).toBeGreaterThan(0)
  })

  it('offers image interrogation as a normal skill', () => {
    render(<SkillHarness />)

    expect(findCustomSkillById(availableSkills, BUILT_IN_IMAGE_INTERROGATION_SKILL_ID)?.type).toBe(
      'normal'
    )
    expect(screen.getByRole('button', { name: 'GPT-4o' })).toBeInTheDocument()
    expect(screen.queryByText('chat.agent_skill_active:')).toBeNull()
  })

  it('offers prompt translation as a normal skill', () => {
    render(<SkillHarness />)

    expect(findCustomSkillById(availableSkills, BUILT_IN_PROMPT_TRANSLATION_SKILL_ID)?.type).toBe(
      'normal'
    )
    expect(screen.getByRole('button', { name: 'GPT-4o' })).toBeInTheDocument()
  })
})
