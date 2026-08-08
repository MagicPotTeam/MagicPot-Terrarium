import { afterEach, describe, expect, it } from 'vitest'
import {
  authorizeMagicAgentApprovalRenderer,
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding,
  unregisterMagicAgentTrustedRouteBinding
} from './trustedRouteBinding'

afterEach(() => {
  clearMagicAgentTrustedRouteBindingsForTest()
})

describe('MagicAgent approval renderer authorization', () => {
  const trustedUrl = 'file:///app/index.html'
  const invocation = {
    methodName: 'svcMagicAgentPlatform.listPendingApprovals',
    senderId: 42,
    senderUrl: `${trustedUrl}#/chat`,
    frameUrl: `${trustedUrl}#/chat`,
    isMainFrame: true
  }

  it('allows a non-Agent-Studio hash only for the registered live main renderer', () => {
    registerMagicAgentTrustedRouteBinding(42, undefined, {
      trustedUrl,
      trustedWebContents: { id: 42, isDestroyed: () => false }
    })

    expect(() => authorizeMagicAgentApprovalRenderer(invocation)).not.toThrow()
  })

  it.each([
    ['spoofed sender', { ...invocation, senderId: 43 }],
    [
      'wrong base URL',
      {
        ...invocation,
        senderUrl: 'file:///other/index.html#/chat',
        frameUrl: 'file:///other/index.html#/chat'
      }
    ],
    ['subframe', { ...invocation, isMainFrame: false }]
  ])('rejects %s', (_label, blockedInvocation) => {
    registerMagicAgentTrustedRouteBinding(42, undefined, {
      trustedUrl,
      trustedWebContents: { id: 42, isDestroyed: () => false }
    })

    expect(() => authorizeMagicAgentApprovalRenderer(blockedInvocation)).toThrow(/not trusted/)
  })

  it('rejects unregistered and destroyed senders', () => {
    expect(() => authorizeMagicAgentApprovalRenderer(invocation)).toThrow(/not trusted/)

    let destroyed = false
    registerMagicAgentTrustedRouteBinding(42, undefined, {
      trustedUrl,
      trustedWebContents: { id: 42, isDestroyed: () => destroyed }
    })
    destroyed = true
    expect(() => authorizeMagicAgentApprovalRenderer(invocation)).toThrow(/not trusted/)

    destroyed = false
    unregisterMagicAgentTrustedRouteBinding(42)
    expect(() => authorizeMagicAgentApprovalRenderer(invocation)).toThrow(/not trusted/)
  })
})
