import React from 'react'
import { Link } from '@mui/material'
import { api } from '@renderer/utils/windowUtils'

type ExternalLinkProps = {
  href: string
  children: React.ReactNode
}

const ExternalLink: React.FC<ExternalLinkProps> = ({ href, children }) => {
  return (
    <Link
      onClick={(e) => {
        e.preventDefault()
        api().svcShell.openExternal(href)
      }}
    >
      {children}
    </Link>
  )
}

export default ExternalLink
