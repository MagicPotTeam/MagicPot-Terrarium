import React from 'react'
import { Typography } from '@mui/material'
import PanelShell from './PanelShell'
import ModelDropZone from './ModelDropZone'
import { ParamSegment, SectionLabel, TipBanner } from './ui'
import type { Hy3dParams } from './types'
import {
  CONVERT_MODEL_EXTENSIONS,
  CONVERT_TARGET_FORMATS,
  getHy3dPostProcessModelCompatibility
} from './types'

interface ConvertPanelProps {
  params: Hy3dParams
  onParamsChange: (p: Partial<Hy3dParams>) => void
  onGenerate?: () => void
}

const ConvertPanel: React.FC<ConvertPanelProps> = ({ params, onParamsChange, onGenerate }) => {
  const modelCompatibility = getHy3dPostProcessModelCompatibility('Convert3DFormat', params)

  return (
    <PanelShell
      title="格式转换"
      submitLabel="开始转换"
      submitDisabled={!params.modelUrl || modelCompatibility.status === 'incompatible'}
      onSubmit={onGenerate}
    >
      <TipBanner>官方格式转换接口只接受公开可访问的 GLB / OBJ / FBX 链接。</TipBanner>
      {modelCompatibility.status === 'incompatible' && (
        <Typography sx={{ mt: 1, fontSize: 11.5, color: '#ffb15e' }}>
          当前模型格式看起来是 {modelCompatibility.inferredFormat}，格式转换只接受{' '}
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
        label="源模型 URL"
        acceptExtensions={CONVERT_MODEL_EXTENSIONS}
        allowedFormatsLabel="GLB / OBJ / FBX"
        urlOnly
        enableLocalUpload
      />

      <SectionLabel>目标格式</SectionLabel>
      <ParamSegment
        options={CONVERT_TARGET_FORMATS.map((format) => ({
          value: format.value,
          label: format.label
        }))}
        value={params.convertTargetFormat}
        onChange={(value) =>
          onParamsChange({ convertTargetFormat: value as Hy3dParams['convertTargetFormat'] })
        }
      />
    </PanelShell>
  )
}

export default ConvertPanel
