import React from 'react'

interface SmartLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href?: string
  children?: React.ReactNode
}

/**
 * A smart link component that:
 * - Opens external links in a new window/tab with rel="noopener noreferrer"
 * - Handles internal anchor links (like footnotes) with smooth scrolling
 */
export const SmartLink = ({ href, children, onClick, ...props }: SmartLinkProps) => {
  const isAnchorLink = href?.startsWith('#')

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (isAnchorLink && href) {
      e.preventDefault()
      const targetId = href.slice(1) // Remove the # prefix
      const targetElement = document.getElementById(targetId)
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
        // Update URL hash without jumping
        window.history.pushState(null, '', href)
      }
    }
    onClick?.(e)
  }

  if (isAnchorLink) {
    return (
      <a 
        href={href}
        onClick={handleClick}
        {...props}
      >
        {children}
      </a>
    )
  }

  // External link - open in new tab
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

