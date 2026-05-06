import React from 'react'
import { Typography } from '@mui/material'
import PanelShell from './PanelShell'
import ModelDropZone from './ModelDropZone'
import { ParamSegment, SectionLabel, TipBanner } from './ui'
import { hyColors } from './theme'
import type { Hy3dParams } from './types'
import {
  FACE_LEVEL_OPTIONS,
  POLYGON_TYPE_OPTIONS,
  TOPOLOGY_MODEL_EXTENSIONS,
  getHy3dPostProcessModelCompatibility
} from './types'

interface TopologyPanelProps {
  params: Hy3dParams
  onParamsChange: (p: Partial<Hy3dParams>) => void
  onGenerate?: () => void
}

const TopologyPanel: React.FC<TopologyPanelProps> = ({ params, onParamsChange, onGenerate }) => {
  const modelCompatibility = getHy3dPostProcessModelCompatibility('SubmitReduceFaceJob', params)

  return (
    <PanelShell
      title="智能拓扑"
      submitLabel="开始优化"
      submitDisabled={!params.modelUrl || modelCompatibility.status === 'incompatible'}
      onSubmit={onGenerate}
    >
      <TipBanner>
        官方智能拓扑接口仅接受公开可访问的 OBJ / GLB 链接，并支持 FaceLevel 与 PolygonType
        两个参数。
      </TipBanner>
      {modelCompatibility.status === 'incompatible' && (
        <Typography sx={{ mt: 1, fontSize: 11.5, color: '#ffb15e' }}>
          当前模型格式看起来是 {modelCompatibility.inferredFormat}，智能拓扑只接受{' '}
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
        acceptExtensions={TOPOLOGY_MODEL_EXTENSIONS}
        allowedFormatsLabel="OBJ / GLB"
        urlOnly
        enableLocalUpload
      />

      <SectionLabel info="接口文档可选值：low / medium / high。">目标面数等级</SectionLabel>
      <ParamSegment
        options={FACE_LEVEL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
        value={params.topoFaceLevel || 'low'}
        onChange={(value) =>
          onParamsChange({ topoFaceLevel: value as Hy3dParams['topoFaceLevel'] })
        }
      />
      <Typography sx={{ fontSize: 11, color: hyColors.textSecondary, mt: 0.5, px: 0.5 }}>
        {
          FACE_LEVEL_OPTIONS.find((option) => option.value === (params.topoFaceLevel || 'low'))
            ?.desc
        }
      </Typography>

      <SectionLabel>多边形类型</SectionLabel>
      <ParamSegment
        options={POLYGON_TYPE_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label
        }))}
        value={params.polygonType}
        onChange={(value) => onParamsChange({ polygonType: value as Hy3dParams['polygonType'] })}
      />
    </PanelShell>
  )
}

export default TopologyPanel
