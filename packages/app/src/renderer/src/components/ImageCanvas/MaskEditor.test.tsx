import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import MaskEditor from './MaskEditor'

vi.mock(import('konva'), () => {
  return {}
})

vi.mock(import('react-konva'), () => {
  return {}
})

describe('MaskEditor', () => {
  it('should render', () => {
    render(<MaskEditor imageUrl="https://example.com/image.png" />)
    screen.debug()
  })
})
