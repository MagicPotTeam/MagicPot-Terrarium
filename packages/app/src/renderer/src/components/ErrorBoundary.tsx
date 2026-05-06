import React from 'react'
import { Box, Button, Typography, Container, Paper } from '@mui/material'
import { ErrorOutline as ErrorIcon } from '@mui/icons-material'

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

/**
 * Error Boundary component to catch and display React rendering errors
 * Prevents the entire app from crashing when a component throws an error
 */
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null
    }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log the error to console for debugging
    console.error('[ErrorBoundary] Caught error:', error)
    console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack)

    this.setState({ errorInfo })
  }

  handleReload = (): void => {
    // Reset error state and try to reload
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null
    })
  }

  handleHardReload = (): void => {
    window.location.reload()
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <Container maxWidth="md" sx={{ py: 8 }}>
          <Paper
            elevation={3}
            sx={{
              p: 4,
              textAlign: 'center',
              borderRadius: 2,
              background: (theme) =>
                theme.palette.mode === 'dark'
                  ? 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)'
                  : 'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)'
            }}
          >
            <ErrorIcon
              sx={{
                fontSize: 64,
                color: 'error.main',
                mb: 2
              }}
            />

            <Typography variant="h4" gutterBottom sx={{ fontWeight: 700 }}>
              出错了
            </Typography>

            <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
              应用遇到了一个错误。请尝试重新加载或刷新页面。
            </Typography>

            {this.state.error && (
              <Paper
                variant="outlined"
                sx={{
                  p: 2,
                  mb: 3,
                  textAlign: 'left',
                  bgcolor: 'action.hover',
                  maxHeight: 200,
                  overflow: 'auto'
                }}
              >
                <Typography
                  variant="body2"
                  component="pre"
                  sx={{
                    fontFamily: 'monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    m: 0
                  }}
                >
                  {this.state.error.message}
                </Typography>
              </Paper>
            )}

            <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
              <Button variant="contained" color="primary" onClick={this.handleReload} size="large">
                重试
              </Button>
              <Button
                variant="outlined"
                color="secondary"
                onClick={this.handleHardReload}
                size="large"
              >
                刷新页面
              </Button>
            </Box>

            {/* Show component stack in development */}
            {process.env.NODE_ENV === 'development' && this.state.errorInfo && (
              <Paper
                variant="outlined"
                sx={{
                  p: 2,
                  mt: 3,
                  textAlign: 'left',
                  bgcolor: 'action.hover',
                  maxHeight: 300,
                  overflow: 'auto'
                }}
              >
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ mb: 1, display: 'block' }}
                >
                  组件堆栈 (仅开发模式可见):
                </Typography>
                <Typography
                  variant="body2"
                  component="pre"
                  sx={{
                    fontFamily: 'monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    m: 0,
                    fontSize: '0.75rem'
                  }}
                >
                  {this.state.errorInfo.componentStack}
                </Typography>
              </Paper>
            )}
          </Paper>
        </Container>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
