import { createTheme } from '@mui/material/styles'

const appFontFamily = [
  '-apple-system',
  'BlinkMacSystemFont',
  '"Segoe UI"',
  '"Roboto"',
  '"Oxygen"',
  '"Ubuntu"',
  '"Cantarell"',
  '"Fira Sans"',
  '"Droid Sans"',
  '"Helvetica Neue"',
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  '"Microsoft YaHei"',
  '"Noto Sans CJK SC"',
  'sans-serif'
].join(', ')

/**
 * Attention:
 *
 * 主题颜色必须完全在 colorSchemes 字段中定义，不能定义到 palette 字段中，
 * 否则 pallete 字段中的颜色（包括未主动设置的字段颜色），会覆盖 colorSchemes 字段中的颜色
 */

export const theme = createTheme({
  colorSchemes: {
    dark: {
      palette: {
        primary: { main: '#6988e6', light: '#8ba3f0', dark: '#4a6bc7', contrastText: '#ffffff' },
        secondary: { main: '#f50057', light: '#ff5983', dark: '#c51162', contrastText: '#ffffff' },
        background: { default: '#1a1a1a', paper: '#1a1a1a' },
        text: { primary: '#ffffff', secondary: '#b0b0b0' },
        divider: '#333333',
        menu: {
          inactive: '#808694',
          selectedBg: '#7e72fd',
          hoverBg: 'rgba(144, 144, 192, 0.18)',
          sideShadow: '8px 0 14px rgba(0,0,0,0.45), 0 8px 18px rgba(0,0,0,0.55)'
        }
      }
    },
    light: {
      palette: {
        primary: { main: '#6988e6', light: '#8ba3f0', dark: '#4a6bc7', contrastText: '#ffffff' },
        secondary: { main: '#f50057', light: '#ff5983', dark: '#c51162', contrastText: '#ffffff' },
        // 按你的要求，浅色主题的主背景和卡片背景都统一为 #e7eaf5
        background: { default: '#e7eaf5', paper: '#e7eaf5' },
        text: { primary: '#111111', secondary: '#4d4d4d' },
        divider: '#e5e7eb',
        menu: {
          inactive: '#808694',
          selectedBg: '#7e72fd',
          hoverBg: 'rgba(144, 144, 192, 0.3)',
          sideShadow: '8px 0 16px rgba(0,0,0,0.10), 0 8px 16px rgba(0,0,0,0.12)'
        }
      }
    }
  },
  typography: {
    // 把你的字体放在最前，后面是安全回退 & 中文回退
    fontFamily: appFontFamily,
    h1: { fontSize: '2.5rem', fontWeight: 800 },
    h2: { fontSize: '2rem', fontWeight: 800 },
    h3: { fontSize: '1.5rem', fontWeight: 700 },
    h4: { fontSize: '1.25rem', fontWeight: 700 },
    h5: { fontSize: '1.125rem', fontWeight: 700 },
    h6: { fontSize: '1rem', fontWeight: 700 }
  },
  shape: { borderRadius: 8 },
  components: {
    MuiCssBaseline: {
      // 可选：再次兜底 body 的 font-family，防止外部 CSS 覆盖
      styleOverrides: {
        body: {
          fontFamily: appFontFamily
        }
      }
    },
    MuiButton: {
      styleOverrides: {
        root: { textTransform: 'none', borderRadius: 8, fontWeight: 700 }
      }
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          fontFamily: appFontFamily,
          lineHeight: 1.4,
          overflow: 'visible'
        }
      }
    },
    MuiCard: {
      styleOverrides: {
        root: ({ theme }) => ({
          background:
            theme.palette.mode === 'dark'
              ? 'linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%)'
              : theme.palette.background.paper,
          border: `1px solid ${theme.palette.divider}`,
          boxShadow:
            theme.palette.mode === 'dark'
              ? '0 4px 20px rgba(0,0,0,0.30)'
              : '0 2px 12px rgba(0,0,0,0.06)'
        })
      }
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: ({ theme }) => ({
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor:
              theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.15)',
            borderWidth: '1px'
          }
        })
      }
    },
    MuiInputBase: {
      styleOverrides: {
        input: {
          outline: 'none !important'
        }
      }
    },
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } }
  }
})
