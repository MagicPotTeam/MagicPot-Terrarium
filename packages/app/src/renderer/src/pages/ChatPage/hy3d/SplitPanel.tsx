import React from 'react'
import { Typography } from '@mui/material'
import PanelShell from './PanelShell'
import ModelDropZone from './ModelDropZone'
import { TipBanner } from './ui'
import type { Hy3dParams } from './types'
import { SPLIT_MODEL_EXTENSIONS, getHy3dPostProcessModelCompatibility } from './types'

interface SplitPanelProps {
  params: Hy3dParams
  onParamsChange: (p: Partial<Hy3dParams>) => void
  onGenerate?: () => void
}

const SplitPanel: React.FC<SplitPanelProps> = ({ params, onParamsChange, onGenerate }) => {
  const modelCompatibility = getHy3dPostProcessModelCompatibility('SubmitHunyuan3DPartJob', params)

  return (
    <PanelShell
      title="组件拆分"
      submitLabel="开始拆分"
      submitDisabled={!params.modelUrl || modelCompatibility.status === 'incompatible'}
      onSubmit={onGenerate}
    >
      <TipBanner>官方组件拆分接口当前只接受公开可访问的 FBX 链接。</TipBanner>
      {modelCompatibility.status === 'incompatible' && (
        <Typography sx={{ mt: 1, fontSize: 11.5, color: '#ffb15e' }}>
          当前模型格式看起来是 {modelCompatibility.inferredFormat}，组件拆分只接受{' '}
          {modelCompatibility.acceptedFormats.join(' / ')}。请重新选择模型。
        </Typography>
      )}
      <ModelDropZone
        value={params.modelUrl || ''}
        onChange={(value) => onParamsChange({ modelUrl: value })}
        fileName={params.modelSourceFileName || ''}
        storageMeta={{
          sourceFileName: params.modelSourceFileName,
          storageKey: params.modelStorageKey,
          storageBucket: params.modelStorageBucket,
          storageRegion: params.modelStorageRegion,
          signedUrlExpiresAt: params.modelSignedUrlExpiresAt
        }}
        onMetaChange={(meta) =>
          onParamsChange({
            modelSourceFileName: meta.sourceFileName,
            modelStorageKey: meta.storageKey,
            modelStorageBucket: meta.storageBucket,
            modelStorageRegion: meta.storageRegion,
            modelSignedUrlExpiresAt: meta.signedUrlExpiresAt
          })
        }
        label="FBX 模型 URL"
        acceptExtensions={SPLIT_MODEL_EXTENSIONS}
        allowedFormatsLabel="FBX"
        urlOnly
        enableLocalUpload
      />
    </PanelShell>
  )
}

export default SplitPanel
