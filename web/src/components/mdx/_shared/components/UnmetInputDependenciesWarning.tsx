import { AlertTriangle } from 'lucide-react'
import { formatVariableLabel } from '../lib/formatVariableLabel'

interface UnmetInputDependenciesWarningProps {
  /** The type of block (used in the message text) */
  blockType: 'check' | 'command'
  /** List of all input dependency variable names */
  inputDependencies: string[]
  /** Current input values to check which are missing */
  inputValues: Record<string, unknown>
}

/**
 * Displays a warning when a block is waiting for required input variables.
 * Shows which variables need values before the block can be run.
 */
export const UnmetInputDependenciesWarning: React.FC<UnmetInputDependenciesWarningProps> = ({
  blockType,
  inputDependencies,
  inputValues
}) => {
  const missingVariables = inputDependencies.filter(varName => {
    const value = inputValues[varName]
    return value === undefined || value === null || value === ''
  })

  if (missingVariables.length === 0) return null

  return (
    <div className="mb-3 text-sm text-yellow-700 flex items-start gap-2">
      <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
      <div>
        <strong>Waiting for input values:</strong>{' '}
        {missingVariables.map((varName, i) => (
          <span key={varName}>
            {i > 0 && ', '}
            <code className="bg-yellow-100 px-1 rounded text-xs">{formatVariableLabel(varName)}</code>
          </span>
        ))}
        <div className="text-xs mt-1 text-yellow-600">
          Fill in the above variable(s) to run this {blockType}.
        </div>
      </div>
    </div>
  )
}
