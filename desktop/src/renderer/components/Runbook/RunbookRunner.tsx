import React from 'react'
import type { RunbookTab } from '../../hooks/useRunbook'
import { VariableForm } from '../Variables/VariableForm'
import { OutputLog } from '../Output/OutputLog'
import { OutputPreview } from '../Output/OutputPreview'

interface RunbookRunnerProps {
  tab: RunbookTab
  onSetVariable: (name: string, value: unknown) => void
  onSelectOutputFolder: () => void
  onExecute: () => void
}

export function RunbookRunner({
  tab,
  onSetVariable,
  onSelectOutputFolder,
  onExecute,
}: RunbookRunnerProps) {
  if (tab.state === 'error' && !tab.config) {
    // Clean up error message - strip IPC channel prefixes
    const cleanError = (tab.error || '')
      .replace(/^Error invoking remote method '[^']+': Error: /, '')
      .replace(/^Error: /, '')
    return (
      <div className="p-6">
        <div className="rounded-lg bg-red-50 border border-red-200 p-4">
          <h3 className="text-sm font-medium text-red-800">Unable to load configuration</h3>
          <p className="mt-1 text-sm text-red-600">{cleanError}</p>
        </div>
      </div>
    )
  }

  if (!tab.config) return null

  const isRunning = tab.state === 'running'
  const canExecute = tab.state === 'loaded' || tab.state === 'complete' || tab.state === 'error'

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-4 border-b border-neutral-200 bg-white">
        <h2 className="text-lg font-semibold text-neutral-900">{tab.name}</h2>
        <p className="text-sm text-neutral-500 font-mono">{tab.templateFolder}</p>
        {tab.config.requiredVersion && (
          <p className="text-xs text-neutral-400 mt-1">
            Required version: {tab.config.requiredVersion}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Variables section */}
        <section>
          <h3 className="text-sm font-semibold text-neutral-900 mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
            </svg>
            Variables
            <span className="text-xs text-neutral-400 font-normal">
              ({tab.config.variables.length})
            </span>
          </h3>
          <VariableForm
            variables={tab.config.variables}
            values={tab.variables}
            onChange={onSetVariable}
          />
        </section>

        {/* Dependencies info */}
        {tab.config.dependencies.length > 0 && (
          <section>
            <h3 className="text-sm font-semibold text-neutral-900 mb-2 flex items-center gap-2">
              <svg className="w-4 h-4 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              Dependencies
              <span className="text-xs text-neutral-400 font-normal">
                ({tab.config.dependencies.length})
              </span>
            </h3>
            <div className="space-y-1">
              {tab.config.dependencies.map((dep) => (
                <div
                  key={dep.name}
                  className="text-sm text-neutral-600 flex items-center gap-2 px-3 py-1.5 bg-neutral-50 rounded"
                >
                  <span className="font-medium">{dep.name}</span>
                  <span className="text-neutral-400">→</span>
                  <span className="font-mono text-xs text-neutral-500">{dep.outputFolder}</span>
                  {dep.skip && (
                    <span className="text-xs text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
                      conditional
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Hooks info */}
        {(tab.config.hooks.before.length > 0 || tab.config.hooks.after.length > 0) && (
          <section>
            <h3 className="text-sm font-semibold text-neutral-900 mb-2 flex items-center gap-2">
              <svg className="w-4 h-4 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              Hooks
            </h3>
            {tab.config.hooks.before.length > 0 && (
              <div className="text-xs text-neutral-500 mb-1">
                Before: {tab.config.hooks.before.map((h) => h.command).join(', ')}
              </div>
            )}
            {tab.config.hooks.after.length > 0 && (
              <div className="text-xs text-neutral-500">
                After: {tab.config.hooks.after.map((h) => h.command).join(', ')}
              </div>
            )}
          </section>
        )}

        {/* Output folder */}
        <section>
          <h3 className="text-sm font-semibold text-neutral-900 mb-2 flex items-center gap-2">
            <svg className="w-4 h-4 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            Output
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={onSelectOutputFolder}
              className="px-3 py-1.5 text-sm bg-neutral-100 hover:bg-neutral-200 text-neutral-700 rounded-md transition-colors"
            >
              Choose Output Folder
            </button>
            {tab.outputFolder ? (
              <span className="text-sm font-mono text-neutral-500">{tab.outputFolder}</span>
            ) : (
              <span className="text-sm text-neutral-400 italic">No output folder selected</span>
            )}
          </div>
        </section>

        {/* Execute button */}
        <div className="pt-2">
          <button
            onClick={onExecute}
            disabled={!canExecute || !tab.outputFolder}
            className={`px-6 py-2.5 text-sm font-medium rounded-lg transition-colors ${
              canExecute && tab.outputFolder
                ? 'bg-blue-600 hover:bg-blue-700 text-white'
                : 'bg-neutral-200 text-neutral-400 cursor-not-allowed'
            }`}
          >
            {isRunning ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Running...
              </span>
            ) : (
              'Generate'
            )}
          </button>
        </div>

        {/* Execution log */}
        <OutputLog logs={tab.logs} />

        {/* Results */}
        {tab.result && tab.state === 'complete' && <OutputPreview result={tab.result} />}

        {/* Error display */}
        {tab.error && tab.state === 'error' && tab.config && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4">
            <h3 className="text-sm font-medium text-red-800">Error</h3>
            <pre className="mt-1 text-sm text-red-600 whitespace-pre-wrap font-mono">
              {tab.error}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
