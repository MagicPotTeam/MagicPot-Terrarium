import { describe, expect, it } from 'vitest'
import { reviewPlanningResult } from './hostPlanningClient'

describe('reviewPlanningResult input boundary', () => {
  it.each(['null', '[1, 2, 3]', '42', '"preview"', '{'])(
    'rejects malformed or non-object model output as INVALID_PREVIEW: %s',
    (content) => {
      expect(() => reviewPlanningResult(content, {} as never)).toThrow('INVALID_PREVIEW')
    }
  )
})
