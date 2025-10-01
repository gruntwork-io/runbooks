import { useState, useEffect, useMemo, useCallback } from 'react'
import type { ReactNode } from 'react'
import { LoadingDisplay } from '@/components/mdx/BoilerplateInputs/components/LoadingDisplay'
import { ErrorDisplay } from '@/components/mdx/BoilerplateInputs/components/ErrorDisplay'
import { useBoilerplateVariables } from '@/contexts/useBoilerplateVariables'
import type { AppError } from '@/types/error'
import { extractTemplateVariables } from './lib/extractTemplateVariables'

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
  children
}: BoilerplateTemplateProps) {
  // Helper function to check if variables object has any properties
  const hasVariables = (vars: Record<string, unknown> | undefined): boolean => {
    return vars !== undefined && Object.keys(vars).length > 0;
  };
  
  // Extract required variables from template content
  const requiredVariables = useMemo(() => {
    const vars = extractTemplateVariables(children);
    return vars;
  }, [children]);
  
  // Check if provided variables satisfy all required variables
  const hasAllRequiredVariables = useCallback((vars: Record<string, unknown> | undefined): boolean => {
    if (!vars || requiredVariables.length === 0) {
      return false;
    }
    
    // Check if all required variables are present and have truthy values
    return requiredVariables.every(varName => {
      const value = vars[varName];
      return value !== undefined && value !== null && value !== '';
    });
  }, [requiredVariables]);
  
  const [isLoading, setIsLoading] = useState(!hasAllRequiredVariables(initialVariables)); // Start as not loading if we have all required variables
  const [error, setError] = useState<AppError | null>(null);
  const [currentVariables, setCurrentVariables] = useState<Record<string, unknown> | undefined>(initialVariables);
  
  // Get variables from context (shared between BoilerplateInputs and BoilerplateTemplate)
  const { variablesByInputsId } = useBoilerplateVariables();
  
  // Update loading state and variables when initialVariables prop changes (MDX async compilation)
  useEffect(() => {
    if (hasAllRequiredVariables(initialVariables)) {
      setCurrentVariables(initialVariables);
      setIsLoading(false);
      setError(null);
    } else if (hasVariables(initialVariables)) {
      // Has some variables but not all required ones - show error with missing variables
      setCurrentVariables(initialVariables);
      
      const missing = requiredVariables.filter(varName => {
        const value = initialVariables![varName];
        return value === undefined || value === null || value === '';
      });
      
      if (missing.length > 0) {
        console.log(`[${boilerplateInputsId}] Missing variables:`, missing);
        setIsLoading(false); // Don't show loading screen, show error instead
        setError({
          message: 'Insufficient inline variables specified',
          details: `This boilerplate template requires the following missing variables: ${missing.join(', ')}. Either add the missing variables to your inline declaration, or remove the inline variables entirely.`
        });
      }
    }
  }, [initialVariables, hasAllRequiredVariables, requiredVariables, boilerplateInputsId]);
  
  // Subscribe to variable updates from the connected BoilerplateInputs component
  useEffect(() => {
    const contextVariables = variablesByInputsId[boilerplateInputsId];
    if (hasAllRequiredVariables(contextVariables)) {
      // Context variables take precedence over initial variables
      setCurrentVariables(contextVariables);
      setIsLoading(false);
    }
  }, [variablesByInputsId, boilerplateInputsId, hasAllRequiredVariables]);
  
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