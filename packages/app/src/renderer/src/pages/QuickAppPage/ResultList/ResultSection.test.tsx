import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ResultSection from './ResultSection'

const useQAppContextMock = vi.fn()
const multiComfyBatchButtonMock = vi.fn((_props: Record<string, unknown>) => (
  <div data-testid="multi-comfy-batch" />
))

vi.mock('../components/QAppContext', () => ({
  useQAppContext: () => useQAppContextMock()
}))

vi.mock('@renderer/store/hooks/comfyStatus', () => ({
  useComfyStatus: () => ({ state: { isConnected: true } })
}))

vi.mock('./ResultList', () => ({
  default: () => <div data-testid="result-list" />
}))

vi.mock('../QAppExecutePanel/SubmitWorkflowButton', () => ({
  default: () => <div data-testid="submit-workflow" />
}))

vi.mock('../QAppExecutePanel/RealtimeGenerationSwitch', () => ({
  default: () => <div data-testid="realtime-generation" />
}))

vi.mock('../QAppExecutePanel/MultiComfyBatchButton', () => ({
  default: (props: Record<string, unknown>) => multiComfyBatchButtonMock(props)
}))

describe('ResultSection batch controls', () => {
  beforeEach(() => {
    useQAppContextMock.mockReset()
    multiComfyBatchButtonMock.mockClear()
  })

  it('propagates the configured batch workflow in the full Quick App view', () => {
    const validate = vi.fn(() => true)
    const validateBatch = vi.fn(() => true)
    const buildWorkflow = vi.fn(() => ({ nodes: {} }))

    useQAppContextMock.mockReturnValue({
      currentQAppKey: 'portrait/full-app',
      qAppCfg: {
        outputNodeIds: ['output-node'],
        batchProcess: {
          enabled: true,
          imageInputSlot: '10.inputs.image',
          batchWorkflow: 'portrait-batch.prompt.json',
          batchImageInputSlot: '20.inputs.image'
        }
      },
      validate,
      validateBatch,
      buildWorkflow
    })

    render(<ResultSection />)

    expect(multiComfyBatchButtonMock).toHaveBeenCalledTimes(1)
    expect(multiComfyBatchButtonMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        currentQAppKey: 'portrait/full-app',
        imageInputSlot: '20.inputs.image',
        outputNodeIds: ['output-node'],
        buildWorkflow,
        validateBatch,
        batchWorkflow: 'portrait-batch.prompt.json',
        batchImageInputSlot: '20.inputs.image'
      })
    )
  })
})
