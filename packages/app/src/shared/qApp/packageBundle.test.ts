import { describe, expect, it } from 'vitest'
import {
  createQAppPackagePayload,
  getQAppCompatibilityError,
  isAppVersionCompatible,
  parseQAppPackage
} from './packageBundle'

describe('packageBundle', () => {
  const cfg = {
    icon: 'icon.png',
    inputs: []
  }

  const workflow = {
    node1: {
      class_type: 'TestNode',
      inputs: {}
    }
  }

  it('creates versioned package payloads with manifest metadata', () => {
    const payload = createQAppPackagePayload({
      cfg,
      workflow,
      manifest: {
        name: 'Demo App',
        version: '2.1.0',
        author: 'MagicPot',
        description: 'A bundled demo quick app.',
        category: 'video',
        source: 'remote',
        compatibleAppVersions: '>=1.0.0'
      }
    })

    expect(payload.magic).toBe('MAGICPOT_QAPP')
    expect(payload.version).toBe(2)
    expect(payload.manifest?.name).toBe('Demo App')
    expect(payload.manifest?.category).toBe('video')
  })

  it('parses legacy packages without manifest and keeps them importable', () => {
    const parsed = parseQAppPackage(
      {
        magic: 'MAGICPOT_QAPP',
        version: 1,
        name: 'Legacy App',
        cfg,
        workflow
      },
      '1.0.101',
      'fallback-name'
    )

    expect(parsed.keyName).toBe('Legacy App')
    expect(parsed.manifest.compatibleAppVersions).toBe('*')
    expect(getQAppCompatibilityError('1.0.101', parsed.manifest)).toBeNull()
  })

  it('validates compatible app version ranges for imported packages', () => {
    expect(isAppVersionCompatible('1.0.101', '>=1.0.0 <2.0.0')).toBe(true)
    expect(
      getQAppCompatibilityError('1.0.101', {
        name: 'Next Gen App',
        version: '1.0.0',
        compatibleAppVersions: '>=2.0.0'
      })
    ).toContain('requires MagicPot >=2.0.0')
  })
})
