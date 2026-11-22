import { beforeEach, describe, expect, it, vi } from 'vitest'

const { purge } = vi.hoisted(() => ({ purge: vi.fn() }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcReportBundles: { purge } }) }))

import {
  purgeReportBundlesOfDeletedConversation,
  purgeReportBundlesOfDeletedProject
} from './reportBundlePurge'

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('report bundle purge on delete', () => {
  beforeEach(() => {
    purge.mockReset()
    purge.mockResolvedValue({ purged: 1, complete: true })
  })

  it('purges a deleted conversation in its storage scope', async () => {
    purgeReportBundlesOfDeletedConversation('conv-1', 'project-1.agent-1')
    await flush()
    expect(purge).toHaveBeenCalledWith({
      conversationIds: ['conv-1'],
      storageScope: 'project-1.agent-1'
    })
  })

  it('purges a deleted project’s pane scopes by prefix', async () => {
    purgeReportBundlesOfDeletedProject('project-1')
    await flush()
    expect(purge).toHaveBeenCalledWith({ storageScopePrefix: 'project-1.' })
  })

  it('never purges without an id and swallows a refusal', async () => {
    purgeReportBundlesOfDeletedConversation('', 'scope')
    purgeReportBundlesOfDeletedProject('')
    await flush()
    expect(purge).not.toHaveBeenCalled()
    purge.mockRejectedValueOnce(new Error('Report bundle access denied.'))
    purge.mockImplementationOnce(() => {
      throw new Error('no api')
    })
    purgeReportBundlesOfDeletedConversation('conv-1', 'scope')
    purgeReportBundlesOfDeletedProject('project-1')
    await flush()
    expect(purge).toHaveBeenCalledTimes(2)
  })
})
