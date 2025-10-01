import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { LoadingDisplay } from '@/components/mdx/BoilerplateInputs/components/LoadingDisplay'
import { ErrorDisplay } from '@/components/mdx/BoilerplateInputs/components/ErrorDisplay'
import { useBoilerplateVariables } from '@/contexts/useBoilerplateVariables'
import type { AppError } from '@/types/error'

interface BoilerplateTemplateProps {
  boilerplateInputsId: string
  outputPath?: string
  variables?: Record<string, unknown> // Manually initialized variables
  children?: ReactNode // For inline template content  
}

function BoilerplateTemplate({
  boilerplateInputsId,
  outputPath,
  variables: initialVariables,
  //children
}: BoilerplateTemplateProps) {
  const [isLoading, setIsLoading] = useState(!initialVariables); // Start as not loading if we have initial variables
  const [error] = useState<AppError | null>(null);
  const [currentVariables, setCurrentVariables] = useState<Record<string, unknown> | undefined>(initialVariables);
  
  // Get variables from context (shared between BoilerplateInputs and BoilerplateTemplate)
  const { variablesByInputsId } = useBoilerplateVariables();
  
  // Subscribe to variable updates from the connected BoilerplateInputs component
  useEffect(() => {
    const contextVariables = variablesByInputsId[boilerplateInputsId];
    if (contextVariables) {
      // Context variables take precedence over initial variables
      setCurrentVariables(contextVariables);
      setIsLoading(false);
    }
    // If no context variables but we have initial variables, they're already set in useState
  }, [variablesByInputsId, boilerplateInputsId]);

  // Main render
  return (
    isLoading ? (
      <LoadingDisplay message="Fill in the variables above and click the Generate button to render this code snippet." />
    ) : error ? (
      <ErrorDisplay error={error} />
    ) : (
      <>
        <h1>My code</h1>
        <ul>
          <li>Inputs ID: {boilerplateInputsId}</li>
          <li>Output Path: {outputPath}</li>
          <li>Variables: {JSON.stringify(currentVariables, null, 2)}</li>
        </ul>
      </>
    )
  )
}


export default BoilerplateTemplate;