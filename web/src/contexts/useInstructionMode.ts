import { useContext } from 'react'
import { InstructionModeContext } from './InstructionModeContext.types'

export function useInstructionMode() {
  const context = useContext(InstructionModeContext)
  if (context === undefined) {
    throw new Error(
      'useInstructionMode must be used within an InstructionModeProvider',
    )
  }
  return context
}
