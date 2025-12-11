import React, { useState, useEffect } from 'react'
import { CircleCheck } from 'lucide-react'
import styles from './SuccessIndicator.module.css'

interface SuccessIndicatorProps {
  show: boolean
  className?: string
}

/**
 * SuccessIndicator component that shows an animated checkmark when success is indicated.
 * 
 * The component handles its own animation timing:
 * - Appears with a growth animation when show becomes true
 * - Remains visible for 3 seconds
 * - Fades out over 0.5 seconds
 * - Automatically resets its state
 * 
 * @param props - Component props
 * @param props.show - Whether to show the success checkmark
 * @param props.className - Additional CSS classes to apply
 */
export const SuccessIndicator: React.FC<SuccessIndicatorProps> = ({
  show,
  className = ''
}) => {
  const [showAnimation, setShowAnimation] = useState(false)
  const [isFadingOut, setIsFadingOut] = useState(false)

  useEffect(() => {
    if (show) {
      setShowAnimation(true)
      setIsFadingOut(false)
      
      // Start fade out after 3 seconds
      const fadeTimer = setTimeout(() => {
        setIsFadingOut(true)
      }, 3000)
      
      // Reset animation state after fade completes
      const resetTimer = setTimeout(() => {
        setShowAnimation(false)
        setIsFadingOut(false)
      }, 3500) // 3s + 0.5s fade duration
      
      return () => {
        clearTimeout(fadeTimer)
        clearTimeout(resetTimer)
      }
    } else {
      // Reset immediately when show becomes false
      setShowAnimation(false)
      setIsFadingOut(false)
    }
  }, [show])

  if (!showAnimation) {
    return null
  }

  return (
    <CircleCheck 
      className={`size-6 text-green-600 ${className} ${
        showAnimation ? styles.animate : ''
      } ${isFadingOut ? styles.fadeOut : ''}`} 
    />
  )
}