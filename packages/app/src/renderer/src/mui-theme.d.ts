import '@mui/material/styles'

declare module '@mui/material/styles' {
  interface Palette {
    menu: {
      inactive: string
      selectedBg: string
      hoverBg: string
      sideShadow: string
    }
  }

  interface PaletteOptions {
    menu?: {
      inactive?: string
      selectedBg?: string
      hoverBg?: string
      sideShadow?: string
    }
  }
}
