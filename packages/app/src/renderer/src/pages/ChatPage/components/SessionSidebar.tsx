import React from 'react'
import {
  Box,
  Paper,
  TextField,
  Typography,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  InputAdornment,
  IconButton,
  useTheme
} from '@mui/material'
import { Add as AddIcon, Delete as DeleteIcon, Search as SearchIcon } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { type ChatSession } from '../chatStorage'

interface SessionSidebarProps {
  sessions: ChatSession[]
  visibleSessions: ChatSession[]
  currentSessionId: string | null
  searchKeyword: string
  onSearchChange: (keyword: string) => void
  onCreateSession: () => void
  onSelectSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  getDisplaySessionTitle: (title?: string | null) => string
}

const SessionSidebar: React.FC<SessionSidebarProps> = ({
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
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'

  return (
    <Paper
      elevation={0}
      sx={{
        width: { xs: 180, sm: 220, md: 260 },
        minWidth: 180,
        flexShrink: 0,
        borderRadius: 0,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: isLight ? 'transparent' : undefined
      }}
    >
      <Box sx={{ p: 1.5, pb: 1 }}>
        <TextField
          fullWidth
          size="small"
          placeholder="搜索对话"
          value={searchKeyword}
          onChange={(e) => onSearchChange(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            )
          }}
        />
      </Box>
      <List sx={{ flex: 1, overflow: 'auto', overflowX: 'hidden' }} disablePadding>
        <ListItem disablePadding>
          <ListItemButton
            onClick={onCreateSession}
            sx={{
              borderRadius: 0,
              py: 1.5,
              '&:hover': {
                bgcolor: 'action.hover'
              }
            }}
          >
            <AddIcon color="primary" sx={{ fontSize: 20 }} />
            <Typography variant="body2" sx={{ ml: 1.5, fontWeight: 500 }}>
              {t('chat.new_conversation')}
            </Typography>
          </ListItemButton>
        </ListItem>
        {visibleSessions.map((session) => (
          <ListItem key={session.id} disablePadding>
            <ListItemButton
              selected={session.id === currentSessionId}
              onClick={() => onSelectSession(session.id)}
              sx={{
                borderRadius: 0,
                opacity: session.archived ? 0.7 : 1,
                '&.Mui-selected': {
                  bgcolor: theme.palette.primary.main + '20'
                }
              }}
            >
              <ListItemText
                primary={
                  <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                    {getDisplaySessionTitle(session.title)}
                  </Typography>
                }
                primaryTypographyProps={{ noWrap: true }}
                secondary={
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {session.messages.length} {t('chat.messages')}
                    </Typography>
                    {session.createdAt && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        noWrap
                        sx={{ opacity: 0.7 }}
                      >
                        {new Date(session.createdAt).toLocaleDateString()}{' '}
                        {new Date(session.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </Typography>
                    )}
                  </Stack>
                }
              />
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation()
                  onDeleteSession(session.id)
                }}
                sx={{
                  ml: 1,
                  color: 'text.secondary',
                  '&:hover': { color: 'error.main' }
                }}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </Paper>
  )
}

const MemoizedSessionSidebar = React.memo(SessionSidebar)

MemoizedSessionSidebar.displayName = 'SessionSidebar'

export default MemoizedSessionSidebar
