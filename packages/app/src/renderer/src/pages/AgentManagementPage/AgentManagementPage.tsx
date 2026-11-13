import { useId, useMemo } from 'react'
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useConfig } from '@renderer/hooks/useConfig'
import { useAppDispatch } from '@renderer/store'
import { openTab } from '@renderer/store/slices/layoutSlice'
import { projectLocalConfigOverview } from './localConfigOverview'
import ManagementSessions from './ManagementSessions'
import ManagementInstalledCatalog from './ManagementInstalledCatalog'
import ManagementBundledCreativeDeclarations from './ManagementBundledCreativeDeclarations'
import ManagementStartupStorageMetadata from './ManagementStartupStorageMetadata'
import ManagementStudioWorkspace from './ManagementStudioWorkspace'

/** Existing config projection, independent explicit metadata/summaries and Open; no mount-time service reads. */
export default function AgentManagementPage() {
  const { config, isReady, updateConfig } = useConfig()
  const { i18n } = useTranslation()
  const chinese = i18n.language?.toLowerCase().startsWith('zh')
  const text = (en: string, zh: string) => (chinese ? zh : en)
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const id = useId()
  const overview = useMemo(() => (isReady ? projectLocalConfigOverview(config) : null), [config, isReady])
  const unavailable = [
    { heading: text('Account identity', '账号身份') },
    { heading: text('Persistence', '持久化') },
    {
      heading: text('Runtime and deployment', '运行时与部署'),
      detail: text(
        'Unavailable',
        '不可用'
      )
    }
  ]
  const backToSettings = () => {
    dispatch(
      openTab({
        id: 'tab-settings',
        label: text('Settings', '设置'),
        routePath: '/settings',
        closable: true
      })
    )
    navigate('/settings')
  }

  const openSettingsPanel = (tab: 'environment' | 'llm') => {
    if (tab === 'llm' && config.use_remote_llm) return
    dispatch(
      openTab({
        id: 'tab-settings',
        label: text('Settings', '设置'),
        routePath: '/settings',
        closable: true
      })
    )
    // Use the existing query/remount contract, not inherited legacy state.tab.
    navigate(tab === 'llm' ? '/settings?tab=llm' : '/settings?tab=environment', { state: null })
  }

  const openWorkshop = (routePath: '/workshop/plugins' | '/custom-skill-manager') => {
    dispatch(openTab({
      id: routePath === '/workshop/plugins' ? 'tab-workshop-plugins' : 'tab-custom-skill-manager',
      label: routePath === '/workshop/plugins' ? text('Plugins', '插件') : text('Custom Skill', '自定义技能'),
      routePath,
      closable: true
    }))
    navigate(routePath, { state: null })
  }

  return (
    <Box component="main" sx={{ height: '100%', overflow: 'auto', p: { xs: 2, md: 3 } }}>
      <Stack spacing={2} sx={{ maxWidth: 1000, mx: 'auto' }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
          <Typography component="h1" variant="h5">
            {text('Agent management', 'Agent 管理')}
          </Typography>
          <Button onClick={backToSettings}>{text('Back to Settings', '返回设置')}</Button>
        </Stack>
        <Alert severity="info">
          {text(
            'Configuration',
            '配置'
          )}
        </Alert>
        {!overview ? (
          <Typography role="status">{text('Loading configuration', '正在加载配置')}</Typography>
        ) : (
          <>
            <Paper
              component="section"
              aria-labelledby={`${id}-profiles`}
              variant="outlined"
              sx={{ p: 2 }}
            >
              <Typography id={`${id}-profiles`} component="h2" variant="h6">
                {text('Configured model profiles', '已配置模型档案')}
              </Typography>
              <Typography id={`${id}-model-settings-notice`} variant="body2" sx={{ mb: 1 }}>
                {text(
                  'Model settings',
                  '模型设置'
                )}
              </Typography>
              {config.use_remote_llm && (
                <Typography id={`${id}-model-settings-remote`} variant="body2" sx={{ mb: 1 }}>
                  {text(
                    'Local model-profile editing is unavailable while remote LLM mode is active.',
                    '远程 LLM 模式下，本地模型配置编辑不可用。'
                  )}
                </Typography>
              )}
              <Button
                disabled={config.use_remote_llm}
                onClick={() => openSettingsPanel('llm')}
                aria-describedby={`${id}-model-settings-notice${config.use_remote_llm ? ` ${id}-model-settings-remote` : ''}`}
              >
                {text('Open model-profile settings', '打开模型配置设置')}
              </Button>
              {!overview.profiles.length ? (
                <Typography>{text('No model profiles configured', '尚未配置模型档案')}</Typography>
              ) : (
                <Stack component="ul" spacing={1.5} sx={{ pl: 3 }}>
                  {overview.profiles.map((profile, index) => (
                    <Box component="li" key={`${index}:${profile.id}`}>
                      <Typography
                        component="div"
                        sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                      >
                        {profile.modelName}
                      </Typography>
                      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                        ID: {profile.id}
                      </Typography>
                      <Typography variant="body2">
                        {text('Provider', '服务商')}:{' '}
                        {profile.provider ?? text('Not specified', '未指定')} ·{' '}
                        {text('Call type', '调用类型')}:{' '}
                        {profile.callType ?? text('Not specified', '未指定')}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              )}
            </Paper>
            <Paper
              component="section"
              aria-labelledby={`${id}-sources`}
              variant="outlined"
              sx={{ p: 2 }}
            >
              <Typography id={`${id}-sources`} component="h2" variant="h6">
                {text('Configured procedural skill sources', '已配置程序化技能来源')}
              </Typography>
              <Typography variant="body2" sx={{ mb: 1 }}>
                {text(
                  'Skill sources',
                  '技能来源'
                )}
              </Typography>
              <Typography id={`${id}-source-settings-notice`} variant="body2" sx={{ mb: 1 }}>
                {text(
                  'Environment settings',
                  '环境设置'
                )}
              </Typography>
              <Button onClick={() => openSettingsPanel('environment')} aria-describedby={`${id}-source-settings-notice`}>
                {text('Open skill-source settings', '打开技能来源设置')}
              </Button>
              {!overview.sources.length ? (
                <Typography>
                  {text('No procedural skill sources configured', '尚未配置程序化技能来源')}
                </Typography>
              ) : (
                <Stack component="ul" spacing={1.5} sx={{ pl: 3 }}>
                  {overview.sources.map((source, index) => (
                    <Box component="li" key={`${index}:${source.id}`}>
                      <Typography sx={{ overflowWrap: 'anywhere' }}>{source.id}</Typography>
                      <Typography variant="body2">
                        {text('Source type', '来源类型')}: {source.source} ·{' '}
                        {text('Configured flag', '配置标记')}:{' '}
                        {source.enabled ? text('enabled', '启用') : text('disabled', '禁用')}
                      </Typography>
                      {source.projectId !== undefined && (
                        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                          {text('Configured project ID', '配置项目 ID')}: {source.projectId}
                        </Typography>
                      )}
                    </Box>
                  ))}
                </Stack>
              )}
            </Paper>
          </>
        )}
        <ManagementSessions />
        <ManagementInstalledCatalog />
        <ManagementBundledCreativeDeclarations />
        <ManagementStartupStorageMetadata />
        {isReady && <ManagementStudioWorkspace
          config={config}
          onSave={updateConfig}
          onOpenPlugins={() => openWorkshop('/workshop/plugins')}
          onOpenSkills={() => openWorkshop('/custom-skill-manager')}
        />}
        {unavailable.map(({ heading, detail }, index) => (
          <Paper
            key={heading}
            component="section"
            aria-labelledby={`${id}-unavailable-${index}`}
            variant="outlined"
            sx={{ p: 2 }}
          >
            <Typography id={`${id}-unavailable-${index}`} component="h2" variant="h6">
              {heading}
            </Typography>
            <Typography color="text.secondary">
              {text('Unavailable in this local-config view', '此本地配置视图暂不可用')}
            </Typography>
            {detail && <Typography color="text.secondary">{detail}</Typography>}
          </Paper>
        ))}
      </Stack>
    </Box>
  )
}
