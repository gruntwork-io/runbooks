import { AlertTriangle } from 'lucide-react'
import { formatVariableLabel } from '../lib/formatVariableLabel'

interface UnmetInputDependenciesWarningProps {
  /** The type of block (used in the message text) */
  blockType: 'check' | 'command'
  /** List of all required variable names */
  requiredVariables: string[]
  /** Current input values to check which are missing */
  inputValues: Record<string, unknown>
}

/**
 * Displays a warning when a block is waiting for required input variables.
 * Shows which variables need values before the block can be run.
 */
export const UnmetInputDependenciesWarning: React.FC<UnmetInputDependenciesWarningProps> = ({
  blockType,
  requiredVariables,
  inputValues
}) => {
  const missingVariables = requiredVariables.filter(varName => {
    const value = inputValues[varName]
    return value === undefined || value === null || value === ''
  })

  if (missingVariables.length === 0) return null

  return (
    <div className="mb-3 text-sm text-yellow-700 flex items-center gap-2">
      <AlertTriangle className="size-4" />
      You can run the {blockType} once we have values for the following variables:{' '}
      {missingVariables.map(varName => formatVariableLabel(varName)).join(', ')}
    </div>
  )
}
