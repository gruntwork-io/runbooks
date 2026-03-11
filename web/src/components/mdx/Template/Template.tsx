import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { BoilerplateInputsForm } from '../_shared/components/BoilerplateInputsForm'
import { ErrorDisplay } from '../_shared/components/ErrorDisplay'
import { LoadingDisplay } from '../_shared/components/LoadingDisplay'
import type { AppError } from '@/types/error'
import { useApiGetBoilerplateConfig } from '@/hooks/useApiGetBoilerplateConfig'
import { useApiBoilerplateRender } from '@/hooks/useApiBoilerplateRender'
import { useRunbookContext, useInputs, useAllOutputs, flattenInputs } from '@/contexts/useRunbook'
import { useComponentIdRegistry } from '@/contexts/ComponentIdRegistry'
import { useErrorReporting } from '@/contexts/useErrorReporting'
import { useTelemetry } from '@/contexts/useTelemetry'
import { buildRenderVariables, computeUnmetOutputDependencies, flattenBlockOutputs } from '@/lib/templateUtils'
import { computeChangeKey } from '@/lib/changeDetection'
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
  /** Where template output is written. "generated" (default) writes to $GENERATED_FILES. "worktree" writes to the active git worktree ($REPO_FILES). */
  target?: 'generated' | 'worktree'
}

function Template({
  id,
  path,
  inputsId,
  target
}: TemplateProps) {
  // Register with ID registry to detect duplicates (including normalized collisions like "a-b" vs "a_b")
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'Template')
  
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
  const [formChangeTrigger, setFormChangeTrigger] = useState(0);
  
  // Track if we've ever successfully generated (stays true even if subsequent renders fail)
  const hasEverGeneratedRef = useRef(false);
  
  // (Worktree/file tree updates are handled by useApiBoilerplateRender via useFileTreeUpdater)
  
  // Get the runbook context to register our config
  const { registerInputs } = useRunbookContext();
  
  // Get inputs from referenced Inputs components (if any) and convert to values map
  const inputs = useInputs(inputsId);
  const inputValues = useMemo(() => flattenInputs(inputs), [inputs]);
  
  // Get all block outputs to check dependencies and pass to template rendering
  const allOutputs = useAllOutputs();

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
    const importedVarNames = new Set(Object.keys(inputValues));
    
    // Intersection: variables that exist in both
    const shared = new Set<string>();
    for (const name of localVarNames) {
      if (importedVarNames.has(name)) {
        shared.add(name);
      }
    }
    return shared;
  }, [boilerplateConfig, inputValues]);
  
  // Compute unmet output dependencies - outputs from other blocks that this template needs
  // but which haven't been produced yet
  const unmetOutputDependencies = useMemo(
    () => computeUnmetOutputDependencies(boilerplateConfig?.outputDependencies ?? [], allOutputs),
    [boilerplateConfig?.outputDependencies, allOutputs]
  );
  
  // Check if all output dependencies are satisfied
  const hasAllOutputDependencies = unmetOutputDependencies.length === 0;

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
        data[variable.name] = inputValues[variable.name];
      } else {
        // Local-only: use template default (stable)
        data[variable.name] = variable.default;
      }
    }
    return data;
  }, [boilerplateConfig, sharedVarNames, inputValues]);

  // Compute live values for shared variables (for real-time sync to form)
  // This must be before early returns to maintain hook order
  const liveVarValues = useMemo(() => {
    const values: Record<string, unknown> = {}
    for (const varName of sharedVarNames) {
      if (inputValues[varName] !== undefined) {
        values[varName] = inputValues[varName]
      }
    }
    return values
  }, [sharedVarNames, inputValues]);

  // Track the latest local form data for registration (without causing re-renders)
  const localVarValuesRef = useRef<Record<string, unknown>>({});

  // Register merged values when imported values or config changes
  useEffect(() => {
    if (boilerplateConfig && id) {
      // Merge imported values with local form data (local wins for shared vars after user edits... 
      // but shared vars are read-only, so imported always wins in practice)
      const mergedData = { ...inputValues, ...localVarValuesRef.current };
      registerInputs(id, mergedData, boilerplateConfig);
    }
  }, [id, boilerplateConfig, inputValues, registerInputs]);

  // Render API call - only triggered when shouldRender is true
  // Pass the component id as templateId to enable smart file cleanup when outputs change
  const { data: renderResult, isLoading: isGenerating, error: renderError, isAutoRendering, autoRender } = useApiBoilerplateRender(
    path,
    id,
    renderFormData,
    shouldRender,
    target
  )

  // Track successful generation (file tree updates are handled by useApiBoilerplateRender)
  useEffect(() => {
    if (!renderResult) return;
    hasEverGeneratedRef.current = true;
  }, [renderResult]);

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

  // Flatten block outputs for template rendering (used in the outputs namespace)
  const flattenedOutputs = useMemo(() => flattenBlockOutputs(allOutputs), [allOutputs]);

  // Handle form changes - store in ref and bump trigger counter
  const handleAutoRender = useCallback((localVarValues: Record<string, unknown>) => {
    // Store latest local form data in ref for registration
    localVarValuesRef.current = localVarValues;

    // Update registration with new form data
    if (boilerplateConfig && id) {
      const mergedData = { ...inputValues, ...localVarValues };
      registerInputs(id, mergedData, boilerplateConfig);
    }

    // Bump trigger to cause the unified auto-render effect to re-evaluate
    setFormChangeTrigger(c => c + 1);
  }, [id, boilerplateConfig, inputValues, registerInputs]);

  // Unified auto-render effect — watches form changes (via formChangeTrigger),
  // imported value changes (via inputValues), and output changes (via flattenedOutputs).
  // The autoRender function from useApiBoilerplateRender already debounces at 200ms.
  const lastRenderedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!shouldRender || !boilerplateConfig || !hasAllOutputDependencies) return;

    const key = computeChangeKey(inputValues, localVarValuesRef.current, flattenedOutputs);
    if (key === lastRenderedKeyRef.current) return;
    lastRenderedKeyRef.current = key;

    const mergedData = buildRenderVariables(
      { ...inputValues, ...localVarValuesRef.current },
      flattenedOutputs,
    );

    if (hasAllRequiredValues(localVarValuesRef.current)) {
      autoRender(path, mergedData);
    }
  }, [formChangeTrigger, shouldRender, boilerplateConfig, hasAllOutputDependencies, inputValues, flattenedOutputs, hasAllRequiredValues, autoRender, path]);

  // Handle form submission / generation
  const handleGenerate = useCallback((localVarValues: Record<string, unknown>) => {
    // Store latest form data
    localVarValuesRef.current = localVarValues;

    const mergedData = buildRenderVariables(
      { ...inputValues, ...localVarValues },
      flattenedOutputs,
    );

    console.log('[Template.handleGenerate] Called with:', {
      localVarValues,
      inputValues,
      mergedData,
    });

    // Register our variables in the block context
    if (boilerplateConfig) {
      const registrationData = { ...inputValues, ...localVarValues };
      registerInputs(id, registrationData, boilerplateConfig);
    }

    // Trigger the render with merged data
    setRenderFormData(mergedData);
    setShouldRender(true);
  }, [id, boilerplateConfig, registerInputs, inputValues, flattenedOutputs])

  // Early return for duplicate ID error
  if (isDuplicate) {
    return (
      <div className="relative rounded-sm border bg-red-50 border-red-200 mb-5 p-4">
        <div className="flex items-center text-red-600">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            {isNormalizedCollision ? (
              <>
                <strong>ID Collision:</strong><br />
                The ID <code className="bg-red-100 px-1 rounded">{`"${id}"`}</code> collides with <code className="bg-red-100 px-1 rounded">{`"${collidingId}"`}</code> because 
                hyphens are converted to underscores for template access.
                Use different IDs to avoid this collision.
              </>
            ) : (
              <>
                <strong>Duplicate ID Error:</strong> Another Template component already uses id="{id}".
                Each Template must have a unique id.
              </>
            )}
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

  // Early return for API errors (config loading errors)
  if (apiError) {
    return <ErrorDisplay error={apiError} />
  }

  // Render the form with output dependency warning and inline render errors
  return (
    <div data-testid={id}>
      {/* Show render errors inline (don't unmount the form) */}
      {renderError && (
        <ErrorDisplay error={renderError} />
      )}
      
      <BoilerplateInputsForm
        id={id}
        boilerplateConfig={boilerplateConfig}
        initialData={initialData}
        onAutoRender={handleAutoRender}
        onGenerate={handleGenerate}
        isGenerating={isGenerating}
        isAutoRendering={isAutoRendering}
        enableAutoRender={true}
        hasGeneratedSuccessfully={hasEverGeneratedRef.current || Boolean(renderResult)}
        variant="standard"
        isInlineMode={false}
        sharedVarNames={sharedVarNames}
        liveVarValues={liveVarValues}
        unmetOutputDependencies={unmetOutputDependencies}
      />
    </div>
  )
}

Template.displayName = 'Template';

export default Template;
