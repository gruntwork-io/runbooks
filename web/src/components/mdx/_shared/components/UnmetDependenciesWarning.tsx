import { AlertTriangle } from 'lucide-react'
import { formatVariableLabel } from '../lib/formatVariableLabel'
import type { InputName, BlockOutput } from '@/lib/templateUtils'

interface UnmetDependenciesWarningProps {
  /** The type of block (used in the help text) */
  blockType: string
  /** Input dependency names that don't have values yet */
  unmetInputDeps: InputName[]
  /** Output dependencies that haven't been produced yet */
  unmetOutputDeps: BlockOutput[]
}

/**
 * Unified warning component for unmet template dependencies.
 * Consolidates input and output dependency warnings into a single component.
 *
 * Renders:
 * - "Waiting for input values: region, env" (when inputs are missing)
 * - "Waiting for outputs from: create_account (account_id)" (when outputs are missing)
 * - Both warnings when both are missing
 */
export const UnmetDependenciesWarning: React.FC<UnmetDependenciesWarningProps> = ({
  blockType,
  unmetInputDeps,
  unmetOutputDeps,
}) => {
  if (unmetInputDeps.length === 0 && unmetOutputDeps.length === 0) return null

  return (
    <div className="mb-3 text-sm text-yellow-700 flex items-start gap-2">
      <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
      <div>
        {unmetInputDeps.length > 0 && (
          <div>
            <strong>Waiting for input values:</strong>{' '}
            {unmetInputDeps.map((varName, i) => (
              <span key={varName}>
                {i > 0 && ', '}
                <code className="bg-yellow-100 px-1 rounded text-xs">{formatVariableLabel(varName)}</code>
              </span>
            ))}
          </div>
        )}
        {unmetOutputDeps.length > 0 && (
          <div className={unmetInputDeps.length > 0 ? 'mt-1' : ''}>
            <strong>Waiting for outputs from:</strong>{' '}
            {unmetOutputDeps.map((dep, i) => (
              <span key={dep.blockId}>
                {i > 0 && ', '}
                <code className="bg-yellow-100 px-1 rounded text-xs">{dep.blockId}</code>
                {' '}({dep.outputNames.join(', ')})
              </span>
            ))}
          </div>
        )}
        <div className="text-xs mt-1 text-yellow-600">
          {unmetInputDeps.length > 0 && unmetOutputDeps.length > 0
            ? `Fill in the required values and run the required blocks to use this ${blockType}.`
            : unmetInputDeps.length > 0
              ? `Fill in the above variable(s) to use this ${blockType}.`
              : `Run the above block(s) first to produce the required outputs.`
          }
        </div>
      </div>
    </div>
  )
}
