import React from 'react'

type ProjectCanvasPageHiddenInputsProps = {
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>
  modelInputRef: React.MutableRefObject<HTMLInputElement | null>
  videoInputRef: React.MutableRefObject<HTMLInputElement | null>
  allAccept: string
  modelImportExtensions: string[]
  onFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void
  onModelSelect: (event: React.ChangeEvent<HTMLInputElement>) => void
  onVideoSelect: (event: React.ChangeEvent<HTMLInputElement>) => void
}

export default function ProjectCanvasPageHiddenInputs({
  fileInputRef,
  modelInputRef,
  videoInputRef,
  allAccept,
  modelImportExtensions,
  onFileSelect,
  onModelSelect,
  onVideoSelect
}: ProjectCanvasPageHiddenInputsProps) {
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={allAccept}
        multiple
        data-testid="project-canvas-import-input"
        style={{ display: 'none' }}
        onChange={onFileSelect}
      />
      <input
        ref={modelInputRef}
        type="file"
        accept={modelImportExtensions.join(',')}
        multiple
        data-testid="project-canvas-model-import-input"
        style={{ display: 'none' }}
        onChange={onModelSelect}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        multiple
        data-testid="project-canvas-video-import-input"
        style={{ display: 'none' }}
        onChange={onVideoSelect}
      />
    </>
  )
}
