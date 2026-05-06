// packages/app/src/renderer/src/pages/ContactPage/ContactPage.tsx
import React, { useState } from 'react'
import { Box, Paper, Typography, Divider, Stack, Snackbar, useTheme } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { api } from '@renderer/utils/windowUtils'

/** 可点击颜色 */
const CLICKABLE_PURPLE = '#6f52adff'
const CLICKABLE_PURPLE_DARK = '#c9bbff'
const SECTION_GAP = 1.25

/** 一行「标签 : 内容」 */
const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '110px auto', sm: '65px auto' },
        alignItems: 'center',
        gap: 1.5
      }}
    >
      <Typography
        variant="body2"
        sx={{
          color: (t) => t.palette.menu.inactive,
          whiteSpace: 'nowrap',
          fontWeight: 600
        }}
      >
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: (t) => t.palette.menu.inactive,
          wordBreak: 'break-all',
          fontWeight: 600
        }}
      >
        {children}
      </Typography>
    </Box>
  )
}

/** 分组标题 */
const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Typography
    variant="subtitle1"
    sx={{ fontWeight: 600, color: (t) => t.palette.menu.inactive, py: 1 }}
  >
    {children}
  </Typography>
)

/** 可复制文本：展示为紫色，点击复制并提示 */
const CopyableText: React.FC<{
  text: string
  onCopied: (s?: string) => void
  inline?: boolean
  openOnClick?: boolean
}> = ({ text, onCopied, inline = true, openOnClick = false }) => {
  const [pressing, setPressing] = useState(false)

  const doAction = async () => {
    if (openOnClick) {
      api().svcShell.openExternal(text)
      return
    }

    try {
      await navigator.clipboard.writeText(text)
      onCopied()
    } catch {
      // 兜底：execCommand
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      onCopied()
    }
  }

  return (
    <Typography
      role="button"
      tabIndex={0}
      onClick={doAction}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && doAction()}
      onMouseDown={() => setPressing(true)}
      onMouseUp={() => setPressing(false)}
      onMouseLeave={() => setPressing(false)}
      sx={{
        display: inline ? 'inline' : 'inline-block',
        cursor: 'pointer',
        color: (theme) =>
          theme.palette.mode === 'light' ? CLICKABLE_PURPLE : CLICKABLE_PURPLE_DARK,
        userSelect: 'none',
        transition: 'transform 0.08s ease',
        transform: pressing ? 'scale(0.98)' : 'none',
        textDecoration: 'none',
        fontWeight: 700,
        fontSize: 12, // 👈 再小一点；想更小可用 12

        '&:hover': { textDecoration: 'underline' }
      }}
    >
      {text}
    </Typography>
  )
}

const ContactPage: React.FC = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const [snack, setSnack] = useState<{ open: boolean; msg: string }>({ open: false, msg: '' })
  const notify = (msg?: string) => setSnack({ open: true, msg: msg || t('contact.copied') })

  return (
    <Box
      sx={{
        height: '100%',
        overflow: 'auto',
        p: { xs: 2, md: 3 },
        // 背景与 SettingsPage 一致
        bgcolor: isLight ? '#e7e9f5' : theme.palette.background.default
      }}
    >
      <Paper
        elevation={0}
        sx={{
          mx: 'auto',
          maxWidth: 1080,
          minHeight: 560,
          p: { xs: 2, md: 3 },
          borderRadius: 3,
          // 内层卡片底色与 SettingsPage 一致
          bgcolor: isLight ? '#d1d2e6' : undefined,
          border: `1px solid ${theme.palette.divider}`,
          color: 'text.primary'
        }}
      >
        {/* 顶部留白 */}
        <Box sx={{ p: { xs: 1, md: 0 } }} />

        <Box sx={{ mt: 0 }}>
          <SectionTitle>{t('contact.business_support')}</SectionTitle>
          <Divider sx={{ borderColor: 'divider' }} />
          <Row label={t('contact.email')}>
            <CopyableText text="2049760120@qq.com" onCopied={notify} />
            {' / '}
            <CopyableText text="shuke9779@gmail.com" onCopied={notify} />
          </Row>
        </Box>

        {/* ====== Bug反馈 / 功能建议 ====== */}
        <Box sx={{ mt: SECTION_GAP }}>
          <SectionTitle>{t('contact.bug_feedback')}</SectionTitle>
          <Divider sx={{ borderColor: 'divider' }} />
          <Row label={t('contact.qq_channel')}>
            <CopyableText text="https://pd.qq.com/g/GameAI6666" onCopied={notify} openOnClick />
          </Row>
          <Row label={t('contact.qq_group')}>
            <CopyableText text="882914613" onCopied={notify} />
          </Row>
          <Row label={t('contact.discord')}>
            <CopyableText text="https://discord.gg/njBMYJ7mRF" onCopied={notify} openOnClick />
          </Row>
        </Box>

        {/* ====== 模型训练 / ComfyUI教学 ====== */}
        <Box sx={{ mt: SECTION_GAP }}>
          <SectionTitle>{t('contact.training_tutorial')}</SectionTitle>
          <Divider sx={{ borderColor: 'divider' }} />
          <Row label={t('contact.bilibili')}>
            <CopyableText
              text="https://space.bilibili.com/2058330491"
              onCopied={notify}
              openOnClick
            />
          </Row>
          <Row label={t('contact.qq_channel')}>
            <CopyableText text="https://pd.qq.com/g/GameAI6666" onCopied={notify} openOnClick />
          </Row>
          <Row label={t('contact.qq_group')}>
            <CopyableText text="882914613" onCopied={notify} />
          </Row>
        </Box>

        <Stack sx={{ height: 240 }} />
      </Paper>

      {/* 复制提示 */}
      <Snackbar
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        open={snack.open}
        autoHideDuration={1500}
        message={snack.msg}
        onClose={() => setSnack((s) => ({ ...s, open: false }))}
      />
    </Box>
  )
}

export default ContactPage
