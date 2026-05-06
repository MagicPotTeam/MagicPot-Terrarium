import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { PROJECT_CANVAS_ROUTE_PATH } from './projectCanvasRouting'

const LegacyProjectWebglRedirectPage: React.FC = () => {
  const location = useLocation()

  return (
    <Navigate
      replace
      to={`${PROJECT_CANVAS_ROUTE_PATH}${location.search || ''}${location.hash || ''}`}
    />
  )
}

export default LegacyProjectWebglRedirectPage
