import { describe, expect, it } from 'vitest'
import { summarizeCompletedImageToolReceipt } from './imageToolReceipt'

const receipt = {
  completed: true,
  image_count: 1,
  edited_images: 5,
  output_format: 'gif',
  images: [
    {
      type: 'image',
      url: 'data:image/gif;base64,legacy',
      media: { relativePath: '/private/output' }
    }
  ],
  diagnostic: 'untrusted extra field'
}

describe('completed image tool provider receipt', () => {
  it('describes only validated counts and optional format, never attachment descriptors', () => {
    expect(summarizeCompletedImageToolReceipt(JSON.stringify(receipt))).toBe(
      'Image generation completed. image_count=1; edited_images=5; output_format=gif.'
    )
  })
  it.each([
    undefined,
    'legacy completion text',
    'x'.repeat(128 * 1024 + 1),
    ...[
      { completed: false },
      { image_count: '1' },
      { image_count: 2 },
      { image_count: 17 },
      { images: [null] },
      { edited_images: undefined },
      { edited_images: -1 },
      { edited_images: 6 },
      { output_format: '/private/legacy.gif' }
    ].map((patch) => JSON.stringify({ ...receipt, ...patch }))
  ])('does not guess counts for malformed/legacy receipt %#', (content) => {
    expect(summarizeCompletedImageToolReceipt(content)).toBe('Image generation completed.')
  })
})
