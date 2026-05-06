import { Box, Stack, Typography } from '@mui/material'
import { CloudDownload as CloudDownloadIcon } from '@mui/icons-material'
import ExternalLink from '@renderer/components/ExternalLInk'
import { QAppRequiredModel } from '@shared/qApp/cfgTypes'
import { useEffect, useRef, useState } from 'react'
import { api } from '@renderer/utils/windowUtils'
import { useConfig } from '@renderer/hooks/useConfig'

type CalloutMissingModelsProps = {
  requiredModels?: QAppRequiredModel[]
}

type MissingRequiredModel = {
  model: QAppRequiredModel
  displayDir: string
}

function getModelBaseDir(model: QAppRequiredModel): NonNullable<QAppRequiredModel['baseDir']> {
  return model.baseDir ?? 'comfyui'
}

function resolveRequiredModelPath(
  model: QAppRequiredModel,
  comfyDir: string,
  homeDir: string
): string {
  const rootDir = getModelBaseDir(model) === 'userHome' ? homeDir : comfyDir
  return window.path.join(rootDir, model.dir, model.name)
}

function formatRequiredModelDir(model: QAppRequiredModel, homeDir: string): string {
  if (getModelBaseDir(model) === 'userHome') {
    return window.path.join(homeDir, model.dir)
  }

  const relativeDir = model.dir.replace(/\//g, '\\')
  return `ComfyUI\\${relativeDir}`
}

/**
 * 缺失模型提示
 *
 * 检测快应用所需的模型文件是否存在，如果缺失则显示提示。
 */
export const CalloutMissingModels = ({ requiredModels }: CalloutMissingModelsProps) => {
  const { configUtils } = useConfig()
  const configUtilsRef = useRef(configUtils)
  configUtilsRef.current = configUtils
  const [missingModels, setMissingModels] = useState<MissingRequiredModel[]>([])

  useEffect(() => {
    if (!requiredModels || requiredModels.length === 0) {
      setMissingModels([])
      return
    }

    const checkModels = async () => {
      const [comfyDir, available] = configUtilsRef.current.getComfyUIDir()
      if (!available) {
        setMissingModels([])
        return
      }

      const needsHomeDir = requiredModels.some((m) => getModelBaseDir(m) === 'userHome')
      const homeDir = needsHomeDir ? await api().svcShell.getHomeDir() : ''
      const resolvedModels = requiredModels.map((model) => ({
        model,
        filePath: resolveRequiredModelPath(model, comfyDir, homeDir),
        displayDir: formatRequiredModelDir(model, homeDir)
      }))

      const results = await api().svcShell.fileExistsBatch(resolvedModels.map((m) => m.filePath))
      setMissingModels(
        resolvedModels
          .filter((_, i) => !results[i])
          .map(({ model, displayDir }) => ({ model, displayDir }))
      )
    }

    checkModels()

    // 每 10 秒自动重新检测，下载完模型后无需重启应用
    const interval = setInterval(checkModels, 10_000)

    // 窗口获得焦点时也重新检测
    const onFocus = () => checkModels()
    window.addEventListener('focus', onFocus)

    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [requiredModels])

  if (missingModels.length === 0) {
    return null
  }

  // 提取 URL 文件名用于对比
  const getUrlFileName = (url: string) => {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop() || '')
    } catch {
      return ''
    }
  }

  const amber = '#e6a117'
  const amberGlow = 'rgba(230, 161, 23, 0.15)'
  const amberBorder = 'rgba(230, 161, 23, 0.4)'

  return (
    <Box
      sx={{
        borderRadius: 2,
        border: `1px solid ${amberBorder}`,
        bgcolor: 'rgba(0,0,0,0.35)',
        boxShadow: `0 0 20px ${amberGlow}, inset 0 0 20px rgba(230,161,23,0.03)`,
        p: 2.5,
        mb: 2
      }}
    >
      {/* 标题区 */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
        <CloudDownloadIcon sx={{ fontSize: 40, color: amber }} />
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 700, color: '#fff', lineHeight: 1.2 }}>
            缺少模型文件
          </Typography>
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)' }}>
            Missing Model Files
          </Typography>
        </Box>
      </Box>

      {/* 模型列表 */}
      <Stack spacing={1.5}>
        {missingModels.map(({ model, displayDir }) => {
          const urlFileName = getUrlFileName(model.url)
          const needsRename = urlFileName && urlFileName !== model.name

          return (
            <Box
              key={`${model.baseDir ?? 'comfyui'}:${model.dir}:${model.name}`}
              sx={{
                p: 1.5,
                borderRadius: 1.5,
                bgcolor: 'rgba(255,255,255,0.04)',
                border: `1px solid ${amberBorder}`,
                boxShadow: `0 0 8px rgba(230,161,23,0.08)`,
                '&:hover': {
                  bgcolor: 'rgba(255,255,255,0.06)',
                  boxShadow: `0 0 12px ${amberGlow}`
                },
                transition: 'all 0.2s ease'
              }}
            >
              {/* 文件名 + 大小 */}
              <Typography variant="subtitle2" sx={{ fontWeight: 600, color: '#fff' }}>
                {model.name}
                <Typography
                  component="span"
                  variant="caption"
                  sx={{ ml: 1, color: 'rgba(255,255,255,0.5)' }}
                >
                  ({model.size})
                </Typography>
              </Typography>

              {/* 目录路径 + 下载链接 */}
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 1.5,
                  mt: 0.3
                }}
              >
                <Typography
                  variant="caption"
                  sx={{ color: 'rgba(255,255,255,0.45)', wordBreak: 'break-all' }}
                >
                  放到: {displayDir}
                </Typography>
                <ExternalLink href={model.url}>
                  <Typography
                    component="span"
                    sx={{
                      color: '#4da6ff',
                      fontWeight: 600,
                      fontSize: '0.85rem',
                      whiteSpace: 'nowrap',
                      '&:hover': { textDecoration: 'underline' }
                    }}
                  >
                    下载链接
                  </Typography>
                </ExternalLink>
              </Box>

              {/* 重命名提示 */}
              {needsRename && (
                <Typography
                  variant="caption"
                  sx={{
                    display: 'block',
                    mt: 0.5,
                    color: '#e67c17',
                    fontWeight: 500
                  }}
                >
                  下载后请重命名为{' '}
                  <Typography
                    component="span"
                    variant="caption"
                    sx={{ fontWeight: 700, color: amber }}
                  >
                    {model.name}
                  </Typography>
                </Typography>
              )}
            </Box>
          )
        })}
      </Stack>
    </Box>
  )
}
