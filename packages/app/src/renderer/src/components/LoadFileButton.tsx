import React from 'react'
import { styled } from '@mui/material/styles'
import Button, { ButtonProps } from '@mui/material/Button'
import CloudUploadIcon from '@mui/icons-material/CloudUpload'

const VisuallyHiddenInput = styled('input')({
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  height: 1,
  overflow: 'hidden',
  position: 'absolute',
  bottom: 0,
  left: 0,
  whiteSpace: 'nowrap',
  width: 1
})

type LoadFileButtonProps = Omit<ButtonProps, 'onClick' | 'onLoad'> & { accept: string } & (
    | {
        readAs: 'text'
        onLoad: (text: string) => void | Promise<void>
      }
    | {
        readAs: 'binary'
        onLoad: (binary: Uint8Array) => void | Promise<void>
      }
    | {
        readAs: 'dataUrl'
        onLoad: (dataUrl: string) => void | Promise<void>
      }
  )

export default function LoadFileButton({ onLoad, readAs, accept, ...props }: LoadFileButtonProps) {
  const handleLoad = (files: File[]) => {
    if (files.length === 0) {
      return
    }
    const file = files[0]
    if (readAs === 'text') {
      const reader = new FileReader()
      reader.onload = async (event) => await onLoad((event.target?.result as string) ?? '')
      reader.readAsText(file)
    }
    if (readAs === 'binary') {
      const reader = new FileReader()
      reader.onload = async (event) =>
        await onLoad(new Uint8Array(event.target?.result as ArrayBuffer))
      reader.readAsArrayBuffer(file)
    }
    if (readAs === 'dataUrl') {
      const reader = new FileReader()
      reader.onload = async (event) => await onLoad((event.target?.result as string) ?? '')
      reader.readAsDataURL(file)
    }
  }
  return (
    <Button component="label" role={undefined} variant="contained" tabIndex={-1} {...props}>
      {props.children}
      <VisuallyHiddenInput
        type="file"
        onChange={(event) => handleLoad(Array.from(event.target.files ?? []))}
        accept={accept}
      />
    </Button>
  )
}
