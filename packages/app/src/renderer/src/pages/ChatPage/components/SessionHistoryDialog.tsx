import React from 'react'
import {
  Box,
  Button,
  Dialog,
  IconButton,
  InputAdornment,
  InputBase,
  List,
  ListItem,
  ListItemButton,
  Typography
} from '@mui/material'
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Search as SearchIcon,
  History as HistoryIcon,
  ChatBubbleOutline as ChatBubbleIcon
} from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { type ChatSession } from '../chatStorage'

interface SessionHistoryDialogProps {
  open: boolean
  onClose: () => void
  visibleSessions: ChatSession[]
  currentSessionId: string | null
  searchKeyword: string
  onSearchChange: (keyword: string) => void
  onCreateSession: () => void
  onSelectSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  getDisplaySessionTitle: (title?: string | null) => string
}

const SessionHistoryDialog: React.FC<SessionHistoryDialogProps> = ({
  open,
  onClose,
  visibleSessions,
  currentSessionId,
  searchKeyword,
  onSearchChange,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  getDisplaySessionTitle
}) => {
  const { t } = useTranslation()

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: (theme) => ({
          bgcolor: theme.palette.mode === 'dark' ? '#1a1a1a' : 'rgba(245, 245, 250, 0.98)',
          backgroundImage: 'none',
          backdropFilter: 'blur(20px)',
          borderRadius: '16px',
          border:
            theme.palette.mode === 'dark'
              ? '1px solid rgba(255, 255, 255, 0.08)'
              : '1px solid rgba(0, 0, 0, 0.08)',
          height: '65vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxShadow:
            theme.palette.mode === 'dark'
              ? '0 24px 48px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255,255,255,0.03) inset'
              : '0 24px 48px rgba(0, 0, 0, 0.15)'
        })
      }}
    >
      {/* 标题栏 */}
      <Box
        sx={(theme) => ({
          px: 2.5,
          pt: 2,
          pb: 1.5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom:
            theme.palette.mode === 'dark'
              ? '1px solid rgba(255, 255, 255, 0.06)'
              : '1px solid rgba(0, 0, 0, 0.06)'
        })}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <HistoryIcon
            sx={(theme) => ({
              fontSize: 20,
              color:
                theme.palette.mode === 'dark'
                  ? 'rgba(255, 255, 255, 0.7)'
                  : theme.palette.text.secondary
            })}
          />
          <Typography
            variant="subtitle1"
            sx={(theme) => ({
              fontWeight: 700,
              fontSize: 15,
              letterSpacing: '-0.01em',
              color:
                theme.palette.mode === 'dark'
                  ? 'rgba(255, 255, 255, 0.85)'
                  : theme.palette.text.primary
            })}
          >
            {t('chat.history_title')}
          </Typography>
        </Box>
        <Button
          size="small"
          startIcon={<AddIcon sx={{ fontSize: '16px !important' }} />}
          onClick={() => {
            onCreateSession()
            onClose()
          }}
          sx={(theme) => ({
            textTransform: 'none',
            fontSize: 12,
            fontWeight: 600,
            px: 1.5,
            py: 0.5,
            borderRadius: '8px',
            color: theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.7)' : 'text.primary',
            bgcolor:
              theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.05)',
            border:
              theme.palette.mode === 'dark'
                ? '1px solid rgba(255, 255, 255, 0.12)'
                : '1px solid rgba(0, 0, 0, 0.1)',
            '&:hover': {
              bgcolor:
                theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)',
              border:
                theme.palette.mode === 'dark'
                  ? '1px solid rgba(255, 255, 255, 0.2)'
                  : '1px solid rgba(0, 0, 0, 0.16)'
            },
            transition: 'all 0.2s ease'
          })}
        >
          {t('chat.new_conversation')}
        </Button>
      </Box>

      {/* 搜索栏 */}
      <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
        <InputBase
          fullWidth
          placeholder={t('chat.search_placeholder')}
          value={searchKeyword}
          onChange={(e) => onSearchChange(e.target.value)}
          autoFocus
          startAdornment={
            <InputAdornment position="start" sx={{ mr: 1, ml: 1.5 }}>
              <SearchIcon fontSize="small" sx={{ color: 'text.disabled', fontSize: 18 }} />
            </InputAdornment>
          }
          sx={(theme) => ({
            bgcolor:
              theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.03)',
            borderRadius: '10px',
            border: '1px solid',
            borderColor:
              theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)',
            transition: 'all 0.2s ease',
            height: 36,
            '&:hover': {
              borderColor:
                theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.15)'
            },
            '&.Mui-focused': {
              borderColor:
                theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)',
              bgcolor:
                theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)'
            },
            '& .MuiInputBase-input': {
              fontSize: 13,
              p: 0,
              '&::placeholder': { color: 'text.disabled', opacity: 0.7 },
              '&:focus': {
                outline: 'none',
                boxShadow: 'none'
              },
              '&:focus-visible': {
                outline: 'none',
                boxShadow: 'none'
              }
            }
          })}
        />
      </Box>

      {/* 会话列表 */}
      <Box
        sx={(theme) => ({
          flex: 1,
          overflow: 'auto',
          px: 1.5,
          pb: 2,
          '&::-webkit-scrollbar': {
            width: 12
          },
          '&::-webkit-scrollbar-track': {
            background: 'transparent'
          },
          '&::-webkit-scrollbar-thumb': {
            background:
              theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)',
            backgroundClip: 'content-box',
            border: '2px solid transparent',
            borderRadius: 3,
            minHeight: 40,
            '&:hover': {
              background:
                theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'
            }
          }
        })}
      >
        {visibleSessions.length === 0 ? (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              py: 8,
              gap: 1.5,
              opacity: 0.5
            }}
          >
            <ChatBubbleIcon sx={{ fontSize: 40, color: 'text.disabled' }} />
            <Typography variant="body2" color="text.disabled" sx={{ fontSize: 13 }}>
              {searchKeyword ? t('chat.no_results') : t('chat.no_conversations')}
            </Typography>
          </Box>
        ) : (
          <List disablePadding>
            {visibleSessions.map((session) => {
              const isSelected = session.id === currentSessionId
              const messageCount = session.messages.length
              const createdAt = session.createdAt
              let timeLabel = ''
              if (createdAt) {
                const date = new Date(createdAt)
                const now = new Date()
                const pad = (n: number) => String(n).padStart(2, '0')
                const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
                const isToday = date.toDateString() === now.toDateString()
                const yesterday = new Date(now)
                yesterday.setDate(yesterday.getDate() - 1)
                const isYesterday = date.toDateString() === yesterday.toDateString()
                if (isToday) timeLabel = time
                else if (isYesterday) timeLabel = t('chat.history_yesterday_time', { time })
                else timeLabel = `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${time}`
              }
              return (
                <ListItem key={session.id} disablePadding sx={{ mb: 0.5 }}>
                  <ListItemButton
                    selected={isSelected}
                    onClick={() => {
                      onSelectSession(session.id)
                      onClose()
                    }}
                    sx={(theme) => ({
                      borderRadius: '10px',
                      py: 1.25,
                      px: 1.5,
                      position: 'relative',
                      overflow: 'hidden',
                      transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                      '&::before': isSelected
                        ? {
                            content: '""',
                            position: 'absolute',
                            left: 0,
                            top: '15%',
                            bottom: '15%',
                            width: 3,
                            borderRadius: '0 3px 3px 0',
                            background:
                              theme.palette.mode === 'dark'
                                ? 'linear-gradient(180deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0.3) 100%)'
                                : `linear-gradient(180deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.light} 100%)`
                          }
                        : {},
                      '&.Mui-selected': {
                        bgcolor:
                          theme.palette.mode === 'dark'
                            ? 'rgba(255, 255, 255, 0.08)'
                            : 'rgba(0, 0, 0, 0.06)',
                        '&:hover': {
                          bgcolor:
                            theme.palette.mode === 'dark'
                              ? 'rgba(255, 255, 255, 0.12)'
                              : 'rgba(0, 0, 0, 0.08)'
                        }
                      },
                      '&:hover': {
                        bgcolor:
                          theme.palette.mode === 'dark'
                            ? 'rgba(255, 255, 255, 0.05)'
                            : 'rgba(0, 0, 0, 0.04)'
                      }
                    })}
                  >
                    {/* Chat icon */}
                    <Box
                      sx={(theme) => ({
                        width: 34,
                        height: 34,
                        borderRadius: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        mr: 1.5,
                        flexShrink: 0,
                        bgcolor: isSelected
                          ? theme.palette.mode === 'dark'
                            ? 'rgba(255, 255, 255, 0.12)'
                            : 'rgba(105, 136, 230, 0.12)'
                          : theme.palette.mode === 'dark'
                            ? 'rgba(255, 255, 255, 0.06)'
                            : 'rgba(0, 0, 0, 0.04)',
                        transition: 'all 0.2s ease'
                      })}
                    >
                      <ChatBubbleIcon
                        sx={(theme) => ({
                          fontSize: 16,
                          color: isSelected
                            ? theme.palette.mode === 'dark'
                              ? 'rgba(255, 255, 255, 0.7)'
                              : theme.palette.primary.main
                            : 'text.disabled',
                          transition: 'color 0.2s ease'
                        })}
                      />
                    </Box>

                    {/* Text content */}
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        variant="body2"
                        noWrap
                        sx={{
                          fontWeight: isSelected ? 600 : 400,
                          fontSize: 13,
                          color: isSelected ? 'text.primary' : 'text.primary',
                          lineHeight: 1.4,
                          transition: 'font-weight 0.2s ease'
                        }}
                      >
                        {getDisplaySessionTitle(session.title)}
                      </Typography>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.25 }}>
                        <Typography
                          variant="caption"
                          noWrap
                          sx={{
                            fontSize: 11,
                            color: 'text.disabled',
                            lineHeight: 1.3
                          }}
                        >
                          {messageCount} {t('chat.messages')}
                        </Typography>
                        {timeLabel && (
                          <>
                            <Box
                              sx={{
                                width: 2,
                                height: 2,
                                borderRadius: '50%',
                                bgcolor: 'text.disabled',
                                flexShrink: 0
                              }}
                            />
                            <Typography
                              variant="caption"
                              noWrap
                              sx={{
                                fontSize: 11,
                                color: 'text.disabled',
                                lineHeight: 1.3
                              }}
                            >
                              {timeLabel}
                            </Typography>
                          </>
                        )}
                      </Box>
                    </Box>

                    {/* Delete button */}
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDeleteSession(session.id)
                      }}
                      sx={{
                        ml: 0.5,
                        opacity: 0,
                        transition: 'all 0.15s ease',
                        color: 'text.disabled',
                        p: 0.5,
                        '&:hover': {
                          color: '#f87171',
                          bgcolor: 'rgba(248, 113, 113, 0.1)'
                        },
                        '.MuiListItemButton-root:hover &': { opacity: 0.7 }
                      }}
                    >
                      <DeleteIcon sx={{ fontSize: 15 }} />
                    </IconButton>
                  </ListItemButton>
                </ListItem>
              )
            })}
          </List>
        )}
      </Box>
    </Dialog>
  )
}

const MemoizedSessionHistoryDialog = React.memo(SessionHistoryDialog)

MemoizedSessionHistoryDialog.displayName = 'SessionHistoryDialog'

export default MemoizedSessionHistoryDialog
