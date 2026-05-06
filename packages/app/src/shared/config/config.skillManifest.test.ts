import { describe, expect, it } from 'vitest'
import {
  fromSkillManifest,
  normalizeCustomSkill,
  normalizeSkillManifest,
  toSkillManifest,
  type CustomSkill,
  type SkillManifest
} from './config'

describe('skill manifest helpers', () => {
  it('keeps prompt-only legacy skills compatible when promoted to a manifest', () => {
    const legacySkill: CustomSkill = {
      id: 'legacy-skill',
      category: 'Ops',
      skillName: 'Legacy Skill',
      prompt: 'Use the legacy prompt.',
      type: 'normal'
    }

    const manifest = toSkillManifest(legacySkill)

    expect(manifest.instructions).toEqual({
      systemPrompt: 'Use the legacy prompt.',
      userPrompt: undefined
    })
    expect(fromSkillManifest(manifest)).toEqual(
      expect.objectContaining({
        id: 'legacy-skill',
        prompt: 'Use the legacy prompt.',
        instructions: {
          systemPrompt: 'Use the legacy prompt.',
          userPrompt: undefined
        }
      })
    )
    expect(normalizeCustomSkill(legacySkill)).toEqual(fromSkillManifest(manifest))
  })

  it('round-trips rich manifest fields without dropping runtime metadata', () => {
    const manifest: SkillManifest = {
      metadata: {
        id: 'tagging-v2',
        category: 'Tagging',
        name: 'Tagging',
        description: 'Reusable tagging manifest.',
        version: 2,
        builtinOrigin: 'builtin-tagging-default',
        type: 'normal'
      },
      instructions: {
        systemPrompt: 'Generate tags.',
        userPrompt: 'Return tags and caption.'
      },
      execution: {
        mode: 'isolated',
        allowHistory: false,
        outputMode: 'structured',
        fallbackStrategy: 'smaller-batches',
        persistSessionUrl: false
      },
      resources: ['qapp.imageInterrogation.systemPrompt'],
      scripts: ['post:trim-text'],
      bindings: [
        {
          appId: 'qapp.image-interrogation',
          resourceUris: ['qapp.imageInterrogation.systemPrompt']
        }
      ],
      outputSchema: {
        type: 'object',
        required: ['tags'],
        properties: {
          tags: { type: 'array' }
        }
      },
      fallback: {
        strategy: 'smaller-batches',
        message: 'Retry with smaller batches.'
      },
      prompt: 'Generate tags.\n\nReturn tags and caption.',
      apiKey: 'secret',
      apiAddress: 'https://example.com/agent'
    }

    const skill = fromSkillManifest(manifest)
    const normalizedManifest = normalizeSkillManifest(manifest)

    expect(skill).toEqual(
      expect.objectContaining({
        id: 'tagging-v2',
        category: 'Tagging',
        skillName: 'Tagging',
        description: 'Reusable tagging manifest.',
        version: 2,
        builtinOrigin: 'builtin-tagging-default',
        prompt: 'Generate tags.\n\nReturn tags and caption.',
        instructions: {
          systemPrompt: 'Generate tags.',
          userPrompt: 'Return tags and caption.'
        },
        execution: {
          mode: 'isolated',
          allowHistory: false,
          outputMode: 'structured',
          fallbackStrategy: 'smaller-batches',
          persistSessionUrl: false
        },
        resources: ['qapp.imageInterrogation.systemPrompt'],
        scripts: ['post:trim-text'],
        bindings: [
          {
            appId: 'qapp.image-interrogation',
            resourceUris: ['qapp.imageInterrogation.systemPrompt']
          }
        ],
        fallback: {
          strategy: 'smaller-batches',
          message: 'Retry with smaller batches.'
        },
        apiKey: 'secret',
        apiAddress: 'https://example.com/agent'
      })
    )
    expect(toSkillManifest(skill)).toEqual(normalizedManifest)
  })
})
