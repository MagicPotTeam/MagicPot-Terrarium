import {
  Alert,
  AlertTitle,
  Button,
  CircularProgress,
  Divider,
  Stack,
  Typography
} from '@mui/material'
import {
  Download as InstallIcon,
  FolderOpen as FolderOpenIcon,
  OpenInNew as OpenInNewIcon
} from '@mui/icons-material'
import { useConfig } from '@renderer/hooks/useConfig'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import { findNotInstalledNodeInfo } from '@shared/comfy/funcs'
import { ObjectInfoMap, Workflow } from '@shared/comfy/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  checkCustomNodeDependencies,
  type QAppCustomNodeDependency
} from '../utils/qAppDependencyCheck'

type CalloutNodeNotInstalledProps = {
  workflow: Workflow
  objectInfos: ObjectInfoMap
  customNodeUrls?: string[]
}

export const CalloutNodeNotInstalled = ({
  workflow,
  objectInfos,
  customNodeUrls
}: CalloutNodeNotInstalledProps) => {
  const { t } = useTranslation()
  const { configUtils } = useConfig()
  const { notifySuccess, notifyError } = useMessage()
  const configUtilsRef = useRef(configUtils)
  configUtilsRef.current = configUtils
  const [customNodes, setCustomNodes] = useState<QAppCustomNodeDependency[]>([])
  const busyNodeKeysRef = useRef<Set<string>>(new Set())
  const [busyNodeKeys, setBusyNodeKeys] = useState<Set<string>>(new Set())

  const notInstalledNodeItemList = useMemo(() => {
    if (!objectInfos || Object.keys(objectInfos).length === 0) {
      return []
    }
    return findNotInstalledNodeInfo(workflow, objectInfos)
  }, [workflow, objectInfos])

  useEffect(() => {
    let cancelled = false

    const checkNodes = async () => {
      const next = await checkCustomNodeDependencies(customNodeUrls, configUtilsRef.current)
      if (!cancelled) {
        setCustomNodes(next)
      }
    }

    void checkNodes()

    return () => {
      cancelled = true
    }
  }, [customNodeUrls])

  if (notInstalledNodeItemList.length === 0) {
    return null
  }

  const addBusyNodeKey = (key: string) => {
    if (busyNodeKeysRef.current.has(key)) {
      return false
    }
    const next = new Set(busyNodeKeysRef.current)
    next.add(key)
    busyNodeKeysRef.current = next
    setBusyNodeKeys(next)
    return true
  }

  const removeBusyNodeKey = (key: string) => {
    const next = new Set(busyNodeKeysRef.current)
    next.delete(key)
    busyNodeKeysRef.current = next
    setBusyNodeKeys(next)
  }

  const installCustomNode = async (node: QAppCustomNodeDependency) => {
    if (!addBusyNodeKey(node.url)) {
      return
    }
    try {
      const result = await api().svcShell.installGitRepository({
        url: node.url,
        outputDir: node.parentDir,
        directoryName: node.directoryName
      })
      setCustomNodes((prev) =>
        prev.map((item) => (item.url === node.url ? { ...item, folderExists: true } : item))
      )
      notifySuccess(
        result.alreadyExists
          ? t('qapp.callout.node_exists_restart')
          : t('qapp.callout.node_installed_restart')
      )
    } catch (error) {
      notifyError(t('qapp.callout.node_install_failed', { error: String(error) }))
    } finally {
      removeBusyNodeKey(node.url)
    }
  }

  const openCustomNodeDir = async (node: QAppCustomNodeDependency) => {
    if (!addBusyNodeKey(node.url)) {
      return
    }
    try {
      await api().svcShell.ensureDirectory({ path: node.parentDir })
      const openError = await api().svcShell.openPath(node.parentDir)
      if (openError) {
        notifyError(openError)
      }
    } catch (error) {
      notifyError(t('qapp.callout.open_directory_failed', { error: String(error) }))
    } finally {
      removeBusyNodeKey(node.url)
    }
  }

  return (
    <Alert severity="warning">
      <AlertTitle>{t('qapp.callout.not_installed_title')}</AlertTitle>
      <Typography>{t('qapp.callout.not_installed_desc')}</Typography>
      <Typography component="ul" sx={{ listStyle: 'outside' }}>
        {notInstalledNodeItemList.map((cls) => (
          <Typography key={cls} component="li">
            {cls}
          </Typography>
        ))}
      </Typography>
      {customNodes.length > 0 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle1">
            {t('qapp.callout.not_installed_custom_node_urls')}
          </Typography>
          <Stack spacing={1} sx={{ mt: 1 }}>
            {customNodes.map((node) => {
              const busy = busyNodeKeys.has(node.url)

              return (
                <Stack
                  key={node.url}
                  spacing={0.75}
                  sx={{
                    p: 1,
                    borderRadius: 1,
                    border: '1px solid rgba(255,255,255,0.12)',
                    bgcolor: 'rgba(0,0,0,0.12)'
                  }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 600, wordBreak: 'break-all' }}>
                    {node.directoryName}
                  </Typography>
                  <Typography variant="caption" sx={{ wordBreak: 'break-all' }}>
                    {t('qapp.callout.install_to', { dir: node.displayDir })}
                    {node.folderExists ? t('qapp.callout.directory_exists_suffix') : ''}
                  </Typography>
                  <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
                    <Button
                      size="small"
                      variant="contained"
                      startIcon={
                        busy ? <CircularProgress size={14} color="inherit" /> : <InstallIcon />
                      }
                      disabled={busy || node.folderExists}
                      onClick={() => void installCustomNode(node)}
                    >
                      {t('qapp.callout.install_node')}
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<FolderOpenIcon />}
                      disabled={busy}
                      onClick={() => void openCustomNodeDir(node)}
                    >
                      {t('qapp.callout.open_directory')}
                    </Button>
                    <Button
                      size="small"
                      variant="text"
                      startIcon={<OpenInNewIcon />}
                      onClick={() => void api().svcShell.openExternal(node.url)}
                    >
                      {t('qapp.callout.open_link')}
                    </Button>
                  </Stack>
                </Stack>
              )
            })}
          </Stack>
        </>
      )}
    </Alert>
  )
}
