import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import { LoadingDisplay } from '@/components/mdx/BoilerplateInputs/components/LoadingDisplay'
import { ErrorDisplay } from '@/components/mdx/BoilerplateInputs/components/ErrorDisplay'
import { useBoilerplateVariables } from '@/contexts/useBoilerplateVariables'
import type { AppError } from '@/types/error'
import { extractTemplateVariables } from './lib/extractTemplateVariables'
import { extractTemplateFiles } from './lib/extractTemplateFiles'
import { useApiBoilerplateRenderInline } from '@/hooks/useApiBoilerplateRenderInline'

interface BoilerplateTemplateProps {
  boilerplateInputsId: string
  outputPath?: string
  initialVariables?: Record<string, unknown> // Initial variables (fallback if BoilerplateInputs doesn't provide them)
  children?: ReactNode // For inline template content  
}

function BoilerplateTemplate({
  boilerplateInputsId,
  outputPath,
  initialVariables,
  children
}: BoilerplateTemplateProps) {
  // Helper function to check if variables object has any properties
  const hasVariables = useCallback((vars: Record<string, unknown> | undefined): boolean => {
    return vars !== undefined && Object.keys(vars).length > 0;
  }, []);
  
  // Extract required variables from template content
  const requiredVariables = useMemo(() => {
    const vars = extractTemplateVariables(children);
    console.log(`[${boilerplateInputsId}][${outputPath}] 🔍 Required variables extracted:`, vars);
    return vars;
  }, [children, boilerplateInputsId, outputPath]);
  
  // Check if provided variables satisfy all required variables
  const hasAllRequiredVariables = useCallback((vars: Record<string, unknown> | undefined): boolean => {
    const result = (() => {
      if (!vars) {
        return false;
      }
      
      if (requiredVariables.length === 0) {
        return true; // No required variables = all satisfied
      }
      
      // Check if all required variables are present and have truthy values
      return requiredVariables.every(varName => {
        const value = vars[varName];
        return value !== undefined && value !== null && value !== '';
      });
    })();
    
    console.log(`[${boilerplateInputsId}][${outputPath}] hasAllRequiredVariables check:`, {
      vars,
      requiredVariables,
      result
    });
    
    return result;
  }, [requiredVariables, boilerplateInputsId, outputPath]);
  
  // Get variables, config, and raw YAML from context (shared between BoilerplateInputs and BoilerplateTemplate)
  const { variablesByInputsId, yamlContentByInputsId } = useBoilerplateVariables();
  
  // Get the raw boilerplate YAML from context (stored by BoilerplateInputs)
  const boilerplateYaml = yamlContentByInputsId[boilerplateInputsId];
  
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  
  // Track the last rendered variables to prevent re-rendering with the same variables
  const lastRenderedVariablesRef = useRef<string | null>(null);
  
  // Get context variables
  const contextVariables = variablesByInputsId[boilerplateInputsId];
  
  // Log context changes
  useEffect(() => {
    console.log(`[${boilerplateInputsId}][${outputPath}] 📦 Context variables changed:`, contextVariables);
    console.log(`[${boilerplateInputsId}][${outputPath}] 📦 Full context:`, variablesByInputsId);
  }, [contextVariables, boilerplateInputsId, outputPath, variablesByInputsId]);
  
  // Compute which variables to use: context variables ALWAYS take precedence
  const currentVariables = useMemo(() => {
    // Priority 1: Context variables from BoilerplateInputs (if they exist)
    if (hasVariables(contextVariables)) {
      console.log(`[${boilerplateInputsId}][${outputPath}] ✅ Using context variables:`, contextVariables);
      return contextVariables;
    }
    
    // Priority 2: Fall back to initialVariables
    if (initialVariables) {
      console.log(`[${boilerplateInputsId}][${outputPath}] ⚠️  Using initialVariables (no context):`, initialVariables);
      return initialVariables;
    }
    
    console.log(`[${boilerplateInputsId}][${outputPath}] ❌ No variables available`);
    return undefined;
  }, [contextVariables, initialVariables, hasVariables, boilerplateInputsId, outputPath]);
  
  // Extract template files from children
  const templateFiles = useMemo(() => {
    const files = extractTemplateFiles(children, outputPath);
    
    // If we have raw YAML from context, include it
    if (boilerplateYaml) {
      files['boilerplate.yml'] = boilerplateYaml;
    }
    
    return files;
  }, [children, outputPath, boilerplateYaml]);
  
  // Use the inline render API hook - only renders via manual autoRender calls
  const { 
    data: renderData, 
    error: renderError,
    autoRender
  } = useApiBoilerplateRenderInline();
  
  // Update loading state and validate variables
  useEffect(() => {
    console.log(`[${boilerplateInputsId}][${outputPath}] Current variables:`, currentVariables);
    
    // Check if we have valid variables to work with
    if (hasAllRequiredVariables(currentVariables) && boilerplateYaml) {
      setIsLoading(false);
      setError(null);
    } else if (hasVariables(currentVariables) && !hasAllRequiredVariables(currentVariables)) {
      // Has some variables but not all - show error
      const missing = requiredVariables.filter(varName => {
        const value = currentVariables![varName];
        return value === undefined || value === null || value === '';
      });
      
      setIsLoading(false);
      setError({
        message: 'Insufficient variables specified',
        details: `This template requires the following missing variables: ${missing.join(', ')}.`
      });
    }
  }, [currentVariables, boilerplateYaml, hasAllRequiredVariables, hasVariables, requiredVariables, boilerplateInputsId, outputPath]);
  
  // Trigger render when variables change and we have all required variables
  useEffect(() => {
    console.log(`[${boilerplateInputsId}][${outputPath}] Render effect triggered. hasAll=${hasAllRequiredVariables(currentVariables)}, hasYaml=${!!boilerplateYaml}, hasFiles=${Object.keys(templateFiles).length > 0}`);
    
    if (hasAllRequiredVariables(currentVariables) && boilerplateYaml && Object.keys(templateFiles).length > 0) {
      // Create a stable string representation of the current variables to check if they've changed
      const variablesKey = JSON.stringify(currentVariables);
      
      console.log(`[${boilerplateInputsId}][${outputPath}] Checking if should render. Current key:`, variablesKey.substring(0, 100));
      console.log(`[${boilerplateInputsId}][${outputPath}] Last rendered key:`, lastRenderedVariablesRef.current?.substring(0, 100));
      
      // Only render if the variables have actually changed
      if (variablesKey !== lastRenderedVariablesRef.current) {
        console.log(`[${boilerplateInputsId}][${outputPath}] 🚀 Rendering with variables:`, currentVariables);
        lastRenderedVariablesRef.current = variablesKey;
        autoRender(templateFiles, currentVariables!);
      } else {
        console.log(`[${boilerplateInputsId}][${outputPath}] ⏭️  Skipping render - variables unchanged`);
      }
    } else {
      console.log(`[${boilerplateInputsId}][${outputPath}] ❌ Cannot render - conditions not met`);
    }
  }, [currentVariables, templateFiles, hasAllRequiredVariables, autoRender, boilerplateYaml, boilerplateInputsId, outputPath]);
  
  return (
    isLoading ? (
      <LoadingDisplay message="Fill in the variables above and click the Generate button to render this code snippet." />
    ) : error ? (
      <ErrorDisplay error={error} />
    ) : renderError ? (
      <ErrorDisplay error={{ 
        message: 'Failed to render template', 
        details: renderError.message || 'An error occurred while rendering the template' 
      }} />
    ) : renderData?.renderedFiles ? (
      <>
        {Object.entries(renderData.renderedFiles).map(([filename, content]) => (
          <div key={filename}>
            <h4>{filename}</h4>
            <pre><code>{content}</code></pre>
          </div>
        ))}
      </>
    ) : (
      <LoadingDisplay message="Waiting for template to render..." />
    )
  )
}


export default BoilerplateTemplate;