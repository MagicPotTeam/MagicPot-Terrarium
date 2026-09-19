import { describe, expect, it } from 'vitest'
import { ComfyBatchPngDownloadError, downloadCompletedBatchPng } from './batchOutput'

const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
)

const context = {
  profileId: 'gpu-a',
  promptId: 'prompt-123',
  file: { filename: 'result.png', subfolder: 'out', type: 'output' as const }
}

describe('completed batch PNG download', () => {
  it('re-downloads a partial response without submitting the prompt again', async () => {
    let downloads = 0
    await expect(
      downloadCompletedBatchPng(
        async () => {
          downloads += 1
          return downloads === 1 ? validPng.subarray(0, 20) : validPng
        },
        context,
        { delayMs: 0 }
      )
    ).resolves.toEqual(validPng)
    expect(downloads).toBe(2)
  })

  it('stops on a real non-PNG response and includes output context', async () => {
    let downloads = 0
    const error = await downloadCompletedBatchPng(
      async () => {
        downloads += 1
        return new Uint8Array(Buffer.from('<html>not png</html>'))
      },
      context,
      { delayMs: 0 }
    ).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ComfyBatchPngDownloadError)
    expect(downloads).toBe(1)
    expect(String((error as Error).message)).toMatch(
      /profile=gpu-a promptId=prompt-123 file=out\/result\.png type=output.*non-PNG format/i
    )
  })

  it('exits after the bounded retry count while leaving source ownership to the caller', async () => {
    let downloads = 0
    const error = await downloadCompletedBatchPng(
      async () => {
        downloads += 1
        return validPng.subarray(0, 20)
      },
      context,
      { delayMs: 0 }
    ).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ComfyBatchPngDownloadError)
    expect(downloads).toBe(3)
    expect((error as ComfyBatchPngDownloadError).attempts).toBe(3)
    expect(String((error as Error).message)).toMatch(/PNG truncation/i)
  })
})
