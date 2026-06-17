import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InputLoRAChain, { type LoRAConfig } from './InputLoRAChain'

const comfyMocks = vi.hoisted(() => ({
  listImages: vi.fn(),
  viewImage: vi.fn()
}))
const objectUrlMocks = vi.hoisted(() => ({
  bytesToObjectUrl: vi.fn()
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcComfy: {},
    svcPysssss: {}
  })
}))

vi.mock('@renderer/utils/comfyUtils', () => ({
  ComfyUtils: vi.fn().mockImplementation(function MockComfyUtils() {
    return {
      listImages: comfyMocks.listImages,
      viewImage: comfyMocks.viewImage
    }
  })
}))

vi.mock('@renderer/utils/fileUtils', () => ({
  bytesToObjectUrl: objectUrlMocks.bytesToObjectUrl
}))

vi.mock('./InputSlider', () => ({
  default: ({
    value,
    label,
    onChange
  }: {
    value: number
    label: string
    onChange: (value: number) => void
  }) => (
    <input
      aria-label={label}
      value={value}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
    />
  )
}))

const createLora = (name = ''): LoRAConfig => ({
  lora_name: name,
  strength_model: 1,
  strength_clip: 1,
  trigger_words: ''
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

const renderControlled = ({
  initialValue,
  onLoraSelected,
  onAppendLoraTriggerWords
}: {
  initialValue: LoRAConfig[]
  onLoraSelected?: (
    loraName: string,
    triggerWords?: string
  ) => string | void | Promise<string | void>
  onAppendLoraTriggerWords?: (lora: LoRAConfig) => string | void | Promise<string | void>
}) => {
  const latest = { value: initialValue }
  const onChange = vi.fn((nextValue: LoRAConfig[]) => {
    latest.value = nextValue
  })

  const Harness = () => {
    const [value, setValue] = React.useState(initialValue)
    return (
      <InputLoRAChain
        label="LoRA"
        value={value}
        onChange={(nextValue) => {
          onChange(nextValue)
          setValue(nextValue)
        }}
        lora_options={['alpha.safetensors', 'beta.safetensors']}
        onLoraSelected={onLoraSelected}
        onAppendLoraTriggerWords={onAppendLoraTriggerWords}
      />
    )
  }

  const view = render(<Harness />)
  return { ...view, latest, onChange }
}

describe('InputLoRAChain', () => {
  beforeEach(() => {
    localStorage.clear()
    comfyMocks.listImages.mockReset()
    comfyMocks.viewImage.mockReset()
    objectUrlMocks.bytesToObjectUrl.mockReset()
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        width: 240,
        height: 120,
        top: 0,
        left: 0,
        right: 240,
        bottom: 120,
        x: 0,
        y: 0,
        toJSON: () => undefined
      })
    })
  })

  it('ignores stale LoRA preview responses and revokes stale object URLs', async () => {
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL
    })
    comfyMocks.listImages.mockResolvedValue({
      'alpha.safetensors': 'alpha.png',
      'beta.safetensors': 'beta.png'
    })
    const alphaPreview = deferred<{ image: Uint8Array }>()
    const betaPreview = deferred<{ image: Uint8Array }>()
    comfyMocks.viewImage.mockImplementation(({ name }: { name: string }) => {
      if (name === 'alpha.png') return alphaPreview.promise
      if (name === 'beta.png') return betaPreview.promise
      return Promise.reject(new Error(`unexpected image ${name}`))
    })
    objectUrlMocks.bytesToObjectUrl.mockImplementation((bytes: Uint8Array) => `blob:${bytes[0]}`)

    const { rerender, unmount } = render(
      <InputLoRAChain
        label="LoRA"
        value={[createLora('alpha.safetensors')]}
        onChange={vi.fn()}
        lora_options={['alpha.safetensors', 'beta.safetensors']}
      />
    )

    await waitFor(() => {
      expect(comfyMocks.viewImage).toHaveBeenCalledWith({ name: 'alpha.png' })
    })

    rerender(
      <InputLoRAChain
        label="LoRA"
        value={[createLora('beta.safetensors')]}
        onChange={vi.fn()}
        lora_options={['alpha.safetensors', 'beta.safetensors']}
      />
    )

    await waitFor(() => {
      expect(comfyMocks.viewImage).toHaveBeenCalledWith({ name: 'beta.png' })
    })

    betaPreview.resolve({ image: new Uint8Array([2]) })
    expect(await screen.findByRole('img', { name: 'beta.safetensors' })).toHaveAttribute(
      'src',
      'blob:2'
    )

    alphaPreview.resolve({ image: new Uint8Array([1]) })

    await waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:1')
    })
    expect(screen.queryByRole('img', { name: 'alpha.safetensors' })).toBeNull()
    expect(screen.getByRole('img', { name: 'beta.safetensors' })).toHaveAttribute('src', 'blob:2')

    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:2')
  })

  it('does not apply delayed trigger words after deleting the selected row', async () => {
    comfyMocks.listImages.mockResolvedValue({})
    const triggerWords = deferred<string>()
    const onLoraSelected = vi.fn(() => triggerWords.promise)
    const { latest } = renderControlled({
      initialValue: [createLora('alpha.safetensors'), createLora('')],
      onLoraSelected
    })

    const secondCombo = await screen.findByLabelText('Lora 1')
    fireEvent.mouseDown(secondCombo)
    fireEvent.change(secondCombo, { target: { value: 'beta.safetensors' } })
    fireEvent.click(await screen.findByRole('option', { name: 'beta.safetensors' }))

    await waitFor(() => {
      expect(onLoraSelected).toHaveBeenCalledWith('beta.safetensors', '', expect.any(Array))
      expect(latest.value[1].lora_name).toBe('beta.safetensors')
    })

    const secondDeleteButton = screen.getAllByTestId('DeleteIcon')[1].closest('button')
    expect(secondDeleteButton).toBeTruthy()
    fireEvent.click(secondDeleteButton as HTMLButtonElement)

    await waitFor(() => {
      expect(latest.value).toHaveLength(1)
      expect(latest.value[0].lora_name).toBe('alpha.safetensors')
    })

    triggerWords.resolve('late trigger words')

    await waitFor(() => {
      expect(latest.value).toHaveLength(1)
      expect(latest.value[0]).toMatchObject({
        lora_name: 'alpha.safetensors',
        trigger_words: ''
      })
    })
  })

  it('loads trigger words on selection but appends them only after clicking append', async () => {
    comfyMocks.listImages.mockResolvedValue({})
    const onLoraSelected = vi.fn(async () => 'beta trigger')
    const onAppendLoraTriggerWords = vi.fn()
    const { latest } = renderControlled({
      initialValue: [createLora('')],
      onLoraSelected,
      onAppendLoraTriggerWords
    })

    const combo = await screen.findByLabelText('Lora 0')
    fireEvent.mouseDown(combo)
    fireEvent.change(combo, { target: { value: 'beta.safetensors' } })
    fireEvent.click(await screen.findByRole('option', { name: 'beta.safetensors' }))

    await waitFor(() => {
      expect(latest.value[0]).toMatchObject({
        lora_name: 'beta.safetensors',
        trigger_words: 'beta trigger'
      })
    })
    expect(onAppendLoraTriggerWords).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /追加触发词/ }))

    expect(onAppendLoraTriggerWords).toHaveBeenCalledWith(
      expect.objectContaining({
        lora_name: 'beta.safetensors',
        strength_model: 1,
        trigger_words: 'beta trigger'
      })
    )
  })

  it('applies delayed trigger words to the same row after deleting a row before it', async () => {
    comfyMocks.listImages.mockResolvedValue({})
    const triggerWords = deferred<string>()
    const onLoraSelected = vi.fn(() => triggerWords.promise)
    const { latest } = renderControlled({
      initialValue: [createLora('alpha.safetensors'), createLora('')],
      onLoraSelected
    })

    const secondCombo = await screen.findByLabelText('Lora 1')
    fireEvent.mouseDown(secondCombo)
    fireEvent.change(secondCombo, { target: { value: 'beta.safetensors' } })
    fireEvent.click(await screen.findByRole('option', { name: 'beta.safetensors' }))

    await waitFor(() => {
      expect(onLoraSelected).toHaveBeenCalledWith('beta.safetensors', '', expect.any(Array))
      expect(latest.value[1].lora_name).toBe('beta.safetensors')
    })

    const firstDeleteButton = screen.getAllByTestId('DeleteIcon')[0].closest('button')
    expect(firstDeleteButton).toBeTruthy()
    fireEvent.click(firstDeleteButton as HTMLButtonElement)

    await waitFor(() => {
      expect(latest.value).toHaveLength(1)
      expect(latest.value[0].lora_name).toBe('beta.safetensors')
    })

    triggerWords.resolve('late trigger words')

    await waitFor(() => {
      expect(latest.value[0]).toMatchObject({
        lora_name: 'beta.safetensors',
        trigger_words: 'late trigger words'
      })
    })
  })
})
