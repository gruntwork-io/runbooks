import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { BoilerplateInputsForm } from '../_shared/components/BoilerplateInputsForm'
import { ErrorDisplay } from '../_shared/components/ErrorDisplay'
import { LoadingDisplay } from '../_shared/components/LoadingDisplay'
import type { AppError } from '@/types/error'
import { useApiGetBoilerplateConfig } from '@/hooks/useApiGetBoilerplateConfig'
import { useApiBoilerplateRender } from '@/hooks/useApiBoilerplateRender'
import { useFileTree } from '@/hooks/useFileTree'
import { parseFileTreeNodeArray } from '@/components/artifacts/code/FileTree.types'
import { useBlockVariables, useImportedVarValues } from '@/contexts/useBlockVariables'
import { useComponentIdRegistry } from '@/contexts/ComponentIdRegistry'
import { useErrorReporting } from '@/contexts/useErrorReporting'
import { useTelemetry } from '@/contexts/useTelemetry'
import { XCircle } from 'lucide-react'

/**
 * Template component - generates files from a boilerplate template directory.
 * 
 * This component loads a boilerplate configuration, renders a form for any
 * variables defined in the template, and generates files to the workspace.
 * 
 * ## Variable Categories
 * 
 * When a Template references external inputs via `inputsId`, variables fall into three categories:
 * 
 * 1. **Local-only Variables** - exist only in the template's boilerplate.yml.
 *    These are editable in the form.
 * 
 * 2. **Imported-only Variables** - exist only in imported sources (not in template's boilerplate.yml).
 *    These are not shown in the form but are passed through to the template engine.
 *  
 * 3. **Shared Variables** - exist in BOTH the template's boilerplate.yml AND imported sources.
 *    These are read-only in the form and stay live-synced to imported values.
 * 
 * @param props.id - Unique identifier for this component (required)
 * @param props.path - Path to the boilerplate template directory (required)
 * @param props.inputsId - Optional ID(s) of Inputs components to import variable values from
 * 
 * @example
 * // Standalone template with its own form
 * <Template id="vpc-setup" path="templates/vpc" />
 * 
 * @example
 * // Template importing variables from an Inputs block
 * <Inputs id="config">...</Inputs>
 * <Template id="vpc-setup" path="templates/vpc" inputsId="config" />
 */
interface TemplateProps {
  id: string
  path: string
  /** Reference to one or more Inputs by ID. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones). */
  inputsId?: string | string[]
}

function Template({
  id,
  path,
  inputsId
}: TemplateProps) {
  // Register with ID registry to detect duplicates
  const { isDuplicate } = useComponentIdRegistry(id, 'Template')
  
  // Error reporting context
  const { reportError, clearError } = useErrorReporting()
  
  // Telemetry context
  const { trackBlockRender } = useTelemetry()
  
  // Track block render on mount
  useEffect(() => {
    trackBlockRender('Template')
  }, [trackBlockRender])
  
  const [shouldRender, setShouldRender] = useState(false);
  const [renderFormData, setRenderFormData] = useState<Record<string, unknown>>({});
  
  // Get the global file tree context
  const { setFileTree } = useFileTree();
  
  // Get the block variables context to register our config
  const { registerInputs } = useBlockVariables();
  
  // Get variable values imported from referenced Inputs components (if any)
  const importedVarValues = useImportedVarValues(inputsId);

  // Validate props
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <Template> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance."
      }
    }

    if (!path) {
      return {
        message: "The <Template> component requires a 'path' prop.",
        details: "Please specify the path to the boilerplate template directory."
      }
    }

    return null
  }, [id, path])

  // Load boilerplate config from the template path
  const { data: boilerplateConfig, isLoading, error: apiError } = useApiGetBoilerplateConfig(
    path, 
    '', // No inline YAML for Template
    !validationError
  );

  // Report errors to the error reporting context
  useEffect(() => {
    // Determine if there's an error to report
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: 'Template',
        severity: 'error',
        message: `Duplicate component ID: ${id}`
      })
    } else if (validationError) {
      reportError({
        componentId: id,
        componentType: 'Template',
        severity: 'error',
        message: validationError.message
      })
    } else if (apiError) {
      reportError({
        componentId: id,
        componentType: 'Template',
        severity: 'error',
        message: apiError.message
      })
    } else {
      // No error, clear any previously reported error
      clearError(id)
    }
  }, [id, isDuplicate, validationError, apiError, reportError, clearError])

  // Compute "shared" variables - those that exist in BOTH imported sources AND this template's boilerplate.yml
  // These variables are read-only in the form and stay live-synced to imported values
  const sharedVarNames = useMemo(() => {
    if (!boilerplateConfig) return new Set<string>();
    
    const localVarNames = new Set(boilerplateConfig.variables.map(v => v.name));
    const importedVarNames = new Set(Object.keys(importedVarValues));
    
    // Intersection: variables that exist in both
    const shared = new Set<string>();
    for (const name of localVarNames) {
      if (importedVarNames.has(name)) {
        shared.add(name);
      }
    }
    return shared;
  }, [boilerplateConfig, importedVarValues]);

  // Compute initial data for the form
  // - Local-only vars: use template defaults (stable, set once)
  // - Shared vars: use imported values (live-synced)
  // 
  // IMPORTANT: This must NOT depend on any state that changes when the user types,
  // otherwise useFormState will reset the form and cause an infinite loop.
  const initialData = useMemo(() => {
    if (!boilerplateConfig) return {};
    
    const data: Record<string, unknown> = {};
    for (const variable of boilerplateConfig.variables) {
      if (sharedVarNames.has(variable.name)) {
        // Shared: use imported value (live-synced)
        data[variable.name] = importedVarValues[variable.name];
      } else {
        // Local-only: use template default (stable)
        data[variable.name] = variable.default;
      }
    }
    return data;
  }, [boilerplateConfig, sharedVarNames, importedVarValues]);

  // Compute live values for shared variables (for real-time sync to form)
  // This must be before early returns to maintain hook order
  const liveVarValues = useMemo(() => {
    const values: Record<string, unknown> = {}
    for (const varName of sharedVarNames) {
      if (importedVarValues[varName] !== undefined) {
        values[varName] = importedVarValues[varName]
      }
    }
    return values
  }, [sharedVarNames, importedVarValues]);

  // Track the latest local form data for registration (without causing re-renders)
  const localVarValuesRef = useRef<Record<string, unknown>>({});

  // Register merged values when imported values or config changes
  useEffect(() => {
    if (boilerplateConfig && id) {
      // Merge imported values with local form data (local wins for shared vars after user edits... 
      // but shared vars are read-only, so imported always wins in practice)
      const mergedData = { ...importedVarValues, ...localVarValuesRef.current };
      registerInputs(id, mergedData, boilerplateConfig);
    }
  }, [id, boilerplateConfig, importedVarValues, registerInputs]);

  // Render API call - only triggered when shouldRender is true
  // Pass the component id as templateId to enable smart file cleanup when outputs change
  const { data: renderResult, isLoading: isGenerating, error: renderError, isAutoRendering, autoRender } = useApiBoilerplateRender(
    path,
    id,
    renderFormData,
    shouldRender
  )

  // Update global file tree when render result is available
  // The backend returns the complete output directory tree, so we simply replace
  useEffect(() => {
    if (renderResult) {
      // Validate the structure before using it to ensure type safety
      const validatedTree = parseFileTreeNodeArray(renderResult.fileTree)
      if (validatedTree) {
        setFileTree(validatedTree);
      }
    }
  }, [renderResult, setFileTree]);

  // Debounce timer ref for auto-render
  const autoRenderTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Check if form data has all required values filled
  const hasAllRequiredValues = useCallback((localVarValues: Record<string, unknown>): boolean => {
    if (!boilerplateConfig) return false;
    return boilerplateConfig.variables.every(variable => {
      const isRequired = variable.validations?.some(v => v.type === 'required');
      if (!isRequired) return true;
      
      const value = localVarValues[variable.name];
      return value !== undefined && value !== null && value !== '';
    });
  }, [boilerplateConfig]);

  // Handle form changes - store in ref (no state update to avoid loops)
  const handleAutoRender = useCallback((localVarValues: Record<string, unknown>) => {
    // Store latest local form data in ref for registration
    localVarValuesRef.current = localVarValues;
    
    // Update registration with new form data
    if (boilerplateConfig && id) {
      const mergedData = { ...importedVarValues, ...localVarValues };
      registerInputs(id, mergedData, boilerplateConfig);
    }
    
    if (!shouldRender) return; // Only auto-render after initial generation
    
    // Clear existing timer
    if (autoRenderTimerRef.current) {
      clearTimeout(autoRenderTimerRef.current);
    }
    
    // Debounce: wait 200ms after last change before rendering
    autoRenderTimerRef.current = setTimeout(() => {
      // Merge imported values with local form data
      const mergedData = { ...importedVarValues, ...localVarValues };
      
      // Only trigger render when all required values are present
      if (hasAllRequiredValues(localVarValues)) {
        autoRender(path, mergedData);
      }
    }, 200);
  }, [id, boilerplateConfig, shouldRender, autoRender, hasAllRequiredValues, importedVarValues, path, registerInputs]);
  
  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (autoRenderTimerRef.current) {
        clearTimeout(autoRenderTimerRef.current);
      }
    };
  }, []);

  // Track previous imported values to detect changes
  const prevImportedVarValuesRef = useRef<Record<string, unknown>>({});
  
  // Trigger auto-render when imported values change (for pass-through variables)
  // This handles variables from inputsId that aren't in this template's boilerplate.yml
  useEffect(() => {
    if (!shouldRender) return; // Only after initial generation
    if (!boilerplateConfig) return;
    
    // Check if imported values actually changed
    const prev = prevImportedVarValuesRef.current;
    const prevKeys = Object.keys(prev);
    const newKeys = Object.keys(importedVarValues);
    const unchanged = prevKeys.length === newKeys.length &&
      prevKeys.every(key => prev[key] === importedVarValues[key]);
    
    prevImportedVarValuesRef.current = importedVarValues;
    
    if (unchanged) return;
    
    // Imported values changed - trigger auto-render with current form data
    const mergedData = { ...importedVarValues, ...localVarValuesRef.current };
    
    if (hasAllRequiredValues(localVarValuesRef.current)) {
      autoRender(path, mergedData);
    }
  }, [shouldRender, boilerplateConfig, importedVarValues, hasAllRequiredValues, autoRender, path]);

  // Handle form submission / generation
  const handleGenerate = useCallback((localVarValues: Record<string, unknown>) => {
    // Store latest form data
    localVarValuesRef.current = localVarValues;
    
    // Merge imported values with local form data
    const mergedData = { ...importedVarValues, ...localVarValues };
    
    // Register our variables in the block context
    if (boilerplateConfig) {
      registerInputs(id, mergedData, boilerplateConfig);
    }
    
    // Trigger the render with merged data
    setRenderFormData(mergedData);
    setShouldRender(true);
  }, [id, boilerplateConfig, registerInputs, importedVarValues])

  // Early return for duplicate ID error
  if (isDuplicate) {
    return (
      <div className="relative rounded-sm border bg-red-50 border-red-200 mb-5 p-4">
        <div className="flex items-center text-red-600">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>Duplicate ID Error:</strong> Another Template component already uses id="{id}".
            Each Template must have a unique id.
          </div>
        </div>
      </div>
    )
  }

  // Early return for loading state
  if (isLoading) {
    return <LoadingDisplay message="Loading template configuration..." />
  }
  
  // Early return for validation errors
  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }

  // Early return for API errors
  if (apiError) {
    return <ErrorDisplay error={apiError} />
  }

  // Early return for render errors
  if (renderError) {
    return <ErrorDisplay error={renderError} />
  }

  // Render the form
  return (
    <BoilerplateInputsForm
      id={id}
      boilerplateConfig={boilerplateConfig}
      initialData={initialData}
      onAutoRender={handleAutoRender}
      onGenerate={handleGenerate}
      isGenerating={isGenerating}
      isAutoRendering={isAutoRendering}
      enableAutoRender={true}
      hasGeneratedSuccessfully={Boolean(renderResult)}
      variant="standard"
      isInlineMode={false}
      sharedVarNames={sharedVarNames}
      liveVarValues={liveVarValues}
    />
  )
}

Template.displayName = 'Template';

export default Template;
