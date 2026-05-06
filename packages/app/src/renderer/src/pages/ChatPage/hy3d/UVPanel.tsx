import React from 'react'
import { Box, Typography } from '@mui/material'
import PanelShell from './PanelShell'
import ModelDropZone from './ModelDropZone'
import { TipBanner } from './ui'
import { hyColors } from './theme'
import type { Hy3dParams } from './types'
import { UV_MODEL_EXTENSIONS, getHy3dPostProcessModelCompatibility } from './types'

interface UVPanelProps {
  params: Hy3dParams
  onParamsChange: (p: Partial<Hy3dParams>) => void
  onGenerate?: () => void
}

const UV_FLOW_STEPS = [
  { label: '输入公开可访问的模型 URL' },
  { label: '云端分析模型网格与纹理信息' },
  { label: '自动切线并展开 UV' },
  { label: '返回可下载的结果文件' }
]

const UVPanel: React.FC<UVPanelProps> = ({ params, onParamsChange, onGenerate }) => {
  const modelCompatibility = getHy3dPostProcessModelCompatibility('SubmitHunyuanTo3DUVJob', params)
  const shouldShowGlbFallbackHint = modelCompatibility.inferredFormat === 'GLB'

  return (
    <PanelShell
      title="UV 展开"
      submitLabel="开始 UV 展开"
      submitDisabled={!params.modelUrl || modelCompatibility.status === 'incompatible'}
      onSubmit={onGenerate}
    >
      <TipBanner>
        官方 UV 展开接口只接受公开可访问的 FBX / OBJ / GLB 链接；官方文档还写了模型面数需小于 30000
        faces。
      </TipBanner>
      {shouldShowGlbFallbackHint && (
        <TipBanner>
          当前模型看起来是 GLB。如果 UV 展开持续报服务内部错误，可先用“格式转换”输出 FBX，再重新执行
          UV 展开。
        </TipBanner>
      )}
      {modelCompatibility.status === 'incompatible' && (
        <Typography sx={{ mt: 1, fontSize: 11.5, color: '#ffb15e' }}>
          当前模型格式看起来是 {modelCompatibility.inferredFormat}，UV 展开只接受{' '}
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
        label="模型 URL"
        acceptExtensions={UV_MODEL_EXTENSIONS}
        allowedFormatsLabel="FBX / OBJ / GLB"
        urlOnly
        enableLocalUpload
      />

      <Box sx={{ mt: 3, px: 1 }}>
        <Typography sx={{ fontSize: 12, fontWeight: 600, color: hyColors.textPrimary, mb: 1.5 }}>
          处理流程
        </Typography>
        {UV_FLOW_STEPS.map((step, index, items) => (
          <Box key={step.label} sx={{ display: 'flex', alignItems: 'stretch', gap: 1.2 }}>
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                width: 28,
                flexShrink: 0
              }}
            >
              <Box
                sx={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  bgcolor: 'rgba(99,102,241,0.15)',
                  border: '1.5px solid rgba(99,102,241,0.4)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <Typography sx={{ fontSize: 10, fontWeight: 700, color: '#818cf8' }}>
                  {index + 1}
                </Typography>
              </Box>
              {index < items.length - 1 && (
                <Box
                  sx={{ width: 1.5, flex: 1, minHeight: 12, bgcolor: 'rgba(99,102,241,0.15)' }}
                />
              )}
            </Box>
            <Box sx={{ py: 0.3 }}>
              <Typography sx={{ fontSize: 12, color: hyColors.textSecondary }}>
                {step.label}
              </Typography>
            </Box>
          </Box>
        ))}
      </Box>
    </PanelShell>
  )
}

export default UVPanel
