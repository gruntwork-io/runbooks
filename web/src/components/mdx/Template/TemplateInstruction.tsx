import { useMemo, useState, useCallback, useEffect } from 'react'
import { FileCode } from 'lucide-react'
import { BoilerplateInputsForm } from '../_shared/components/BoilerplateInputsForm'
import { ErrorDisplay } from '../_shared/components/ErrorDisplay'
import { LoadingDisplay } from '../_shared/components/LoadingDisplay'
import { CodeBlock } from '../_shared/components/CodeBlock'
import { BlockIdLabel } from '../_shared/components/BlockIdLabel'
import { CompletionCheckbox } from '../_shared/components/CompletionCheckbox'
import { useBlockCompletion } from '../_shared/hooks/useBlockCompletion'
import { useApiGetBoilerplateConfig } from '@/hooks/useApiGetBoilerplateConfig'
import { useRunbookContext, useInputs, flattenInputs } from '@/contexts/useRunbook'
import { buildBoilerplateInvocation } from '@/components/mdx/_shared/lib/instructionCommands'

interface TemplateInstructionProps {
  id: string
  path: string
  inputsId?: string | string[]
  target?: 'generated' | 'worktree'
}

/**
 * Instruction-mode rendering of a Template block (spec §6.4): the form is kept
 * (it's how the user supplies variables) but the Generate button is gone.
 * Instead we show a copy-pasteable `boilerplate` invocation built from the
 * collected variables. No files are written — the render-to-disk path
 * (`useApiBoilerplateRender`) is never invoked because this is a separate
 * component from the interactive Template.
 */
export function TemplateInstruction({ id, path, inputsId, target }: TemplateInstructionProps) {
  const { registerInputs } = useRunbookContext()
  const inputs = useInputs(inputsId)
  const inputValues = useMemo(() => flattenInputs(inputs), [inputs])

  const { data: config, isLoading, error } = useApiGetBoilerplateConfig(path, '', true)

  // Initial form values from the template's defaults / imported values.
  const initialData = useMemo(() => {
    if (!config) return {}
    const data: Record<string, unknown> = {}
    for (const variable of config.variables) {
      data[variable.name] =
        inputValues[variable.name] !== undefined
          ? inputValues[variable.name]
          : variable.default
    }
    return data
  }, [config, inputValues])

  const [formValues, setFormValues] = useState<Record<string, unknown>>({})

  // Publish collected variables to the runbook context so sibling blocks resolve
  // them, exactly as the interactive Template does — minus any file generation.
  const handleFormChange = useCallback(
    (data: Record<string, unknown>) => {
      setFormValues(data)
      if (config) {
        registerInputs(id, { ...inputValues, ...data }, config)
      }
    },
    [config, id, inputValues, registerInputs],
  )

  useEffect(() => {
    if (config) registerInputs(id, { ...inputValues, ...initialData }, config)
  }, [config, id, inputValues, initialData, registerInputs])

  const invocation = useMemo(
    () =>
      buildBoilerplateInvocation({
        path,
        variables: { ...inputValues, ...formValues },
        target,
      }),
    [path, inputValues, formValues, target],
  )

  const { completed, toggle } = useBlockCompletion(id)

  if (isLoading) return <LoadingDisplay message="Loading template configuration..." />
  if (error) return <ErrorDisplay error={error} />

  return (
    <div
      data-testid={`instruction-${id}`}
      data-instruction-mode="true"
      data-completed={completed || undefined}
      className={`runbook-block relative rounded-sm border mb-5 p-4 ${
        completed ? 'border-success/40 bg-success-muted' : 'border-border bg-muted/40'
      }`}
    >
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      <div className="flex">
        <div className="border-r border-border pr-2 mr-4 flex flex-col items-center">
          <FileCode className={`size-6 ${completed ? 'text-success' : 'text-muted-foreground'}`} />
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex justify-end mr-8 -mb-1">
            <CompletionCheckbox completed={completed} onToggle={toggle} />
          </div>
          <div className="text-md font-bold text-foreground">Generate files with boilerplate:</div>
          <div className="text-md text-muted-foreground">
            Fill in the variables, then run this command in your terminal:
          </div>

          <BoilerplateInputsForm
            id={id}
            boilerplateConfig={config}
            initialData={initialData}
            onFormChange={handleFormChange}
            showSubmitButton={false}
            enableAutoRender={false}
            variant="standard"
          />

          <CodeBlock>
            <code className="language-bash whitespace-pre-wrap">{invocation}</code>
          </CodeBlock>
        </div>
      </div>
    </div>
  )
}
