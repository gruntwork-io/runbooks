import React from 'react'

interface ExternalLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href?: string
  children?: React.ReactNode
}

/**
 * A custom link component that opens all links in a new window/tab.
 * Also adds rel="noopener noreferrer" for security.
 */
export const ExternalLink = ({ href, children, ...props }: ExternalLinkProps) => {
  return (
    <a 
      href={href} 
      target="_blank" 
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  )
}

