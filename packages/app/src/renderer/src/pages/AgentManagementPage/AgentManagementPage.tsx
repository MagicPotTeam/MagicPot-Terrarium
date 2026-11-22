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
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const id = useId()
  const overview = useMemo(() => (isReady ? projectLocalConfigOverview(config) : null), [config, isReady])
  const unavailable = [
    { heading: t('agent_management.page.account_identity') },
    { heading: t('agent_management.page.persistence') },
    {
      heading: t('agent_management.page.runtime_deployment'),
      detail: t('agent_management.page.unavailable')
    }
  ]
  const backToSettings = () => {
    dispatch(
      openTab({
        id: 'tab-settings',
        label: t('agent_management.page.settings_tab'),
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
        label: t('agent_management.page.settings_tab'),
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
      label: routePath === '/workshop/plugins' ? t('agent_management.page.plugins_tab') : t('agent_management.page.custom_skill_tab'),
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
            {t('agent_management.title')}
          </Typography>
          <Button onClick={backToSettings}>{t('agent_management.page.back_to_settings')}</Button>
        </Stack>
        <Alert severity="info">
          {t('agent_management.page.configuration')}
        </Alert>
        {!overview ? (
          <Typography role="status">{t('agent_management.page.loading_configuration')}</Typography>
        ) : (
          <>
            <Paper
              component="section"
              aria-labelledby={`${id}-profiles`}
              variant="outlined"
              sx={{ p: 2 }}
            >
              <Typography id={`${id}-profiles`} component="h2" variant="h6">
                {t('agent_management.page.model_profiles')}
              </Typography>
              <Typography id={`${id}-model-settings-notice`} variant="body2" sx={{ mb: 1 }}>
                {t('agent_management.page.model_settings')}
              </Typography>
              {config.use_remote_llm && (
                <Typography id={`${id}-model-settings-remote`} variant="body2" sx={{ mb: 1 }}>
                  {t('agent_management.page.model_settings_remote')}
                </Typography>
              )}
              <Button
                disabled={config.use_remote_llm}
                onClick={() => openSettingsPanel('llm')}
                aria-describedby={`${id}-model-settings-notice${config.use_remote_llm ? ` ${id}-model-settings-remote` : ''}`}
              >
                {t('agent_management.page.open_model_settings')}
              </Button>
              {!overview.profiles.length ? (
                <Typography>{t('agent_management.page.no_model_profiles')}</Typography>
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
                        {t('agent_management.page.provider')}:{' '}
                        {profile.provider ?? t('agent_management.page.not_specified')} ·{' '}
                        {t('agent_management.page.call_type')}:{' '}
                        {profile.callType ?? t('agent_management.page.not_specified')}
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
                {t('agent_management.page.skill_sources_heading')}
              </Typography>
              <Typography variant="body2" sx={{ mb: 1 }}>
                {t('agent_management.page.skill_sources')}
              </Typography>
              <Typography id={`${id}-source-settings-notice`} variant="body2" sx={{ mb: 1 }}>
                {t('agent_management.page.environment_settings')}
              </Typography>
              <Button onClick={() => openSettingsPanel('environment')} aria-describedby={`${id}-source-settings-notice`}>
                {t('agent_management.page.open_skill_source_settings')}
              </Button>
              {!overview.sources.length ? (
                <Typography>
                  {t('agent_management.page.no_skill_sources')}
                </Typography>
              ) : (
                <Stack component="ul" spacing={1.5} sx={{ pl: 3 }}>
                  {overview.sources.map((source, index) => (
                    <Box component="li" key={`${index}:${source.id}`}>
                      <Typography sx={{ overflowWrap: 'anywhere' }}>{source.id}</Typography>
                      <Typography variant="body2">
                        {t('agent_management.page.source_type')}: {source.source} ·{' '}
                        {t('agent_management.page.configured_flag')}:{' '}
                        {source.enabled ? t('agent_management.page.enabled') : t('agent_management.page.disabled')}
                      </Typography>
                      {source.projectId !== undefined && (
                        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                          {t('agent_management.page.configured_project_id')}: {source.projectId}
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
              {t('agent_management.page.unavailable_in_view')}
            </Typography>
            {detail && <Typography color="text.secondary">{detail}</Typography>}
          </Paper>
        ))}
      </Stack>
    </Box>
  )
}
