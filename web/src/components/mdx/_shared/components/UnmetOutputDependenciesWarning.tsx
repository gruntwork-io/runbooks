import { AlertTriangle } from 'lucide-react'
import type { UnmetDependency } from '../hooks/useScriptExecution'

interface UnmetOutputDependenciesWarningProps {
  unmetDependencies: UnmetDependency[]
}

/**
 * Displays a warning when a block is waiting for outputs from other blocks.
 * Shows which block IDs need to be run first and what outputs are expected.
 */
export const UnmetOutputDependenciesWarning: React.FC<UnmetOutputDependenciesWarningProps> = ({
  unmetDependencies
}) => {
  if (unmetDependencies.length === 0) return null

  return (
    <div className="mb-3 text-sm text-yellow-700 flex items-start gap-2">
      <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
      <div>
        <strong>Waiting for outputs from:</strong>{' '}
        {unmetDependencies.map((dep, i) => (
          <span key={dep.blockId}>
            {i > 0 && ', '}
            <code className="bg-yellow-100 px-1 rounded text-xs">{dep.blockId}</code>
            {' '}({dep.outputNames.join(', ')})
          </span>
        ))}
        <div className="text-xs mt-1 text-yellow-600">
          Run the above block(s) first to produce the required outputs.
        </div>
      </div>
    </div>
  )
}
