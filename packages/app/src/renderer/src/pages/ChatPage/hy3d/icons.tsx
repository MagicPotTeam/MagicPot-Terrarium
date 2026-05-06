import React from 'react'

const strokeProps = {
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

const secondaryStrokeProps = {
  ...strokeProps,
  strokeWidth: 1.5,
  opacity: 0.58
}

const StepBadge: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg width="26" height="26" viewBox="0 0 28 28" fill="none" aria-hidden="true">
    {children}
  </svg>
)

export const IconConcept: React.FC = () => (
  <StepBadge>
    <path {...secondaryStrokeProps} d="M9 18.3h5.8" />
    <path {...strokeProps} d="M10.2 17.4l3.5-8.1 3.1 3.2-7.4 3.7.8 1.2z" />
    <path {...secondaryStrokeProps} d="M16 8.5l1.8 1.8" />
    <path {...strokeProps} d="M17.6 15.1l.7-1.4m0 0l1.4-.7m-1.4.7l1.4.7m-1.4-.7l-.7-1.4" />
  </StepBadge>
)

export const IconGeometry: React.FC = () => (
  <StepBadge>
    <path {...strokeProps} d="M14 7.3l5 2.8v5.8L14 18.7 9 15.9v-5.8L14 7.3z" />
    <path {...secondaryStrokeProps} d="M14 7.3v11.4M9 10.1l5 2.9 5-2.9" />
  </StepBadge>
)

export const IconProfile: React.FC = () => (
  <StepBadge>
    <circle {...strokeProps} cx="14" cy="10.6" r="2.8" />
    <path {...strokeProps} d="M9.6 18.2c1.1-2.5 3-3.8 4.4-3.8s3.3 1.3 4.4 3.8" />
    <path {...secondaryStrokeProps} d="M18.2 9.2l.6-1.1m0 0l1.1-.6m-1.1.6l1.1.6m-1.1-.6l-.6-1.1" />
  </StepBadge>
)

export const IconSplit: React.FC = () => (
  <StepBadge>
    <rect {...strokeProps} x="8.3" y="8.3" width="11.4" height="11.4" rx="2.4" />
    <path {...strokeProps} d="M14 8.8v10.4M8.8 14h10.4" />
    <path {...secondaryStrokeProps} d="M10.5 10.5h2.2v2.2h-2.2zM15.3 15.3h2.2v2.2h-2.2z" />
  </StepBadge>
)

export const IconTopology: React.FC = () => (
  <StepBadge>
    <path {...strokeProps} d="M9.2 18l4.9-8.2 4.7 8.2H9.2z" />
    <path {...secondaryStrokeProps} d="M11.2 14.6h5.7M14.1 9.9v7.9" />
    <circle cx="14.1" cy="9.9" r="1.1" fill="currentColor" />
    <circle cx="11.2" cy="14.6" r="1.1" fill="currentColor" />
    <circle cx="17" cy="14.6" r="1.1" fill="currentColor" />
    <circle cx="9.2" cy="18" r="1.1" fill="currentColor" />
    <circle cx="18.8" cy="18" r="1.1" fill="currentColor" />
  </StepBadge>
)

export const IconUV: React.FC = () => (
  <StepBadge>
    <path {...strokeProps} d="M9.2 9.2h6.2l3.4 3.4v6.2H12l-2.8-2.8V9.2z" />
    <path {...secondaryStrokeProps} d="M15.4 9.2v3.4h3.4M12 12.5v4.4M9.8 14.7h6.8" />
  </StepBadge>
)

export const IconTexture: React.FC = () => (
  <StepBadge>
    <path {...strokeProps} d="M10.1 18.1l2.9-2.9 2.3 2.3-2.9 2.9H10.1v-2.3z" />
    <path {...strokeProps} d="M12.9 15.3l3.8-3.8c.8-.8 1.8-1 2.5-.3s.5 1.7-.3 2.5l-3.8 3.8" />
    <path {...secondaryStrokeProps} d="M8.9 9.1h2.1M8.9 12h2.1M6.8 11V8.9" />
  </StepBadge>
)

export const IconConvert: React.FC = () => (
  <StepBadge>
    <path {...strokeProps} d="M10 9.5h7.4l-1.8-1.8M18 9.5l-1.8 1.8" />
    <path {...strokeProps} d="M18 18.5h-7.4l1.8 1.8M10 18.5l1.8-1.8" />
    <rect {...secondaryStrokeProps} x="8.8" y="11.5" width="10.4" height="5" rx="1.8" />
  </StepBadge>
)
