import { describe, expect, it } from 'vitest'
import {
  getAgentTargetAppPrompt,
  getAgentSendMenuCopy,
  getAdobeBridgeDialogTitle,
  getAdobeBridgeFailureNotice,
  getAdobeBridgeMenuCopy,
  getAdobeBridgeSuccessNotice
} from './adobeBridgeUx'

describe('adobeBridgeUx', () => {
  it('keeps Photoshop phrasing direct while AE and PR stay manual-handoff', () => {
    expect(getAgentTargetAppPrompt('photoshop')).toContain('Photoshop')

    const aePrompt = getAgentTargetAppPrompt('after-effects')
    expect(aePrompt).toContain('image + prompt handoff bundle')
    expect(aePrompt).toContain('manifest, instruction payload, recipe, and starter script stub')
    expect(aePrompt).toContain('manual import/manual execution')

    const premierePrompt = getAgentTargetAppPrompt('premiere')
    expect(premierePrompt).toContain('image + prompt handoff bundle')
    expect(premierePrompt).toContain(
      'manifest, instruction payload, recipe, and starter script stub'
    )
    expect(premierePrompt).toContain('manual import/manual execution')
  })

  it('describes AE and PR as generic send actions with app-specific manual-handoff hints', () => {
    expect(getAdobeBridgeMenuCopy('after-effects')).toEqual({
      primary: '\u53d1\u9001',
      secondary:
        '\u8ba9 Agent \u751f\u6210 AE \u811a\u672c\u3001\u8868\u8fbe\u5f0f\u6216\u7279\u6548\u6b65\u9aa4'
    })

    expect(getAdobeBridgeMenuCopy('premiere')).toEqual({
      primary: '\u53d1\u9001',
      secondary: '\u8ba9 Agent \u751f\u6210 PR \u526a\u8f91\u6216\u6548\u679c\u6b65\u9aa4'
    })
  })

  it('keeps the Photoshop action explicit and AE/PR generic', () => {
    expect(getAgentSendMenuCopy('photoshop')).toEqual({
      primary: '\u53d1\u9001\u5230\u5f53\u524d Photoshop \u6587\u6863',
      secondary:
        '\u5c06\u5f53\u524d\u9009\u533a\u4f5c\u4e3a\u65b0\u56fe\u5c42\u63d2\u5165\u5df2\u6253\u5f00\u7684 Photoshop \u6587\u6863'
    })

    expect(getAgentSendMenuCopy('after-effects')).toEqual({
      primary: '\u53d1\u9001',
      secondary:
        '\u8ba9 Agent \u751f\u6210 AE \u811a\u672c\u3001\u8868\u8fbe\u5f0f\u6216\u7279\u6548\u6b65\u9aa4'
    })

    expect(getAgentSendMenuCopy('premiere')).toEqual({
      primary: '\u53d1\u9001',
      secondary: '\u8ba9 Agent \u751f\u6210 PR \u526a\u8f91\u6216\u6548\u679c\u6b65\u9aa4'
    })
  })

  it('makes the export dialog and notices explicit about the handoff package', () => {
    expect(getAdobeBridgeDialogTitle('after-effects')).toBe(
      'Choose an After Effects manual handoff bundle folder'
    )
    expect(getAdobeBridgeDialogTitle('premiere')).toBe(
      'Choose a Premiere Pro manual handoff bundle folder'
    )

    expect(getAdobeBridgeSuccessNotice('after-effects', '/tmp/magicpot')).toBe(
      'After Effects manual handoff bundle generated: /tmp/magicpot\nMagicPot only writes the package artifacts; Adobe execution remains manual.'
    )
    expect(
      getAdobeBridgeSuccessNotice(
        'after-effects',
        '/tmp/magicpot',
        {
          packageDir: '/tmp/magicpot',
          manifestPath: '/tmp/magicpot/bridge-manifest.json',
          instructionsPath: '/tmp/magicpot/handoff-instructions.md',
          recipePath: '/tmp/magicpot/handoff-recipe.json'
        },
        '/tmp/magicpot/after-effects-handoff.jsx'
      )
    ).toBe(
      'After Effects manual handoff bundle generated: /tmp/magicpot\nMagicPot only writes the package artifacts; Adobe execution remains manual.\nManifest: /tmp/magicpot/bridge-manifest.json\nInstructions: /tmp/magicpot/handoff-instructions.md\nRecipe: /tmp/magicpot/handoff-recipe.json\nStarter script stub: /tmp/magicpot/after-effects-handoff.jsx'
    )
    expect(getAdobeBridgeSuccessNotice('premiere', '/tmp/magicpot')).toBe(
      'Premiere Pro manual handoff bundle generated: /tmp/magicpot\nMagicPot only writes the package artifacts; Adobe execution remains manual.'
    )
    expect(getAdobeBridgeFailureNotice('premiere', 'boom')).toBe(
      'Premiere Pro manual handoff bundle failed: boom. No Adobe automation was launched.'
    )
  })
})
