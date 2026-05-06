import { Alert, AlertTitle, Divider, Link, Stack, Typography } from '@mui/material'
import ExternalLink from '@renderer/components/ExternalLInk'
import { findNotInstalledNodeInfo } from '@shared/comfy/funcs'
import { ObjectInfoMap, Workflow } from '@shared/comfy/types'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

type CalloutNodeNotInstalledProps = {
  workflow: Workflow
  objectInfos: ObjectInfoMap
  customNodeUrls?: string[]
}

/**
 * 未安装的节点提示
 *
 * 只会在已连接到 ComfyUI 时显示
 * @param workflow 工作流
 * @param objectInfos 对象信息
 * @returns
 */
export const CalloutNodeNotInstalled = ({
  workflow,
  objectInfos,
  customNodeUrls
}: CalloutNodeNotInstalledProps) => {
  const { t } = useTranslation()
  const notInstalledNodeItemList = useMemo(() => {
    if (!objectInfos || Object.keys(objectInfos).length === 0) {
      // 未连接到 ComfyUI 时，不显示未安装的节点
      return []
    }
    const notInstalledNodeClsList = findNotInstalledNodeInfo(workflow, objectInfos)
    return notInstalledNodeClsList
  }, [workflow, objectInfos])

  if (notInstalledNodeItemList.length === 0) {
    // 未连接到 ComfyUI or 所有节点都已安装
    return null
  }

  return (
    <Alert severity="warning">
      <AlertTitle>{t('qapp.callout.not_installed_title')}</AlertTitle>
      <Typography>{t('qapp.callout.not_installed_desc')}</Typography>
      <Typography component={'ul'} sx={{ listStyle: 'outside' }}>
        {notInstalledNodeItemList.map((cls) => (
          <Typography key={cls} component={'li'}>
            {cls}
          </Typography>
        ))}
      </Typography>
      {customNodeUrls && customNodeUrls.length > 0 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle1">
            {t('qapp.callout.not_installed_custom_node_urls')}
          </Typography>
          <Stack spacing={0.5} sx={{ mt: 1 }}>
            {customNodeUrls.map((url) => (
              <ExternalLink key={url} href={url}>
                {url}
              </ExternalLink>
            ))}
          </Stack>
        </>
      )}
    </Alert>
  )
}
