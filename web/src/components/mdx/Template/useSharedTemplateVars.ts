import { useMemo } from 'react'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'

/**
 * Shared-variable bookkeeping for a Template that imports values via `inputsId`.
 * Used by both the interactive Template and its instruction-mode rendering so
 * the two paths treat imported values identically.
 *
 * @param boilerplateConfig - The template's boilerplate config (null while loading)
 * @param inputValues - Flattened values imported from the referenced Inputs block(s)
 * @returns
 *   - `sharedVarNames`: variables that exist in BOTH the template's boilerplate.yml
 *     and the imported values. These are read-only in the form and stay
 *     live-synced to the imported values.
 *   - `liveVarValues`: the current imported value of each shared variable. Spread
 *     this last when merging form values so a not-yet-synced local copy never
 *     overrides the imported value.
 *   - `initialData`: initial form values (imported values for shared vars,
 *     template defaults for local-only vars).
 */
export function useSharedTemplateVars(
  boilerplateConfig: BoilerplateConfig | null | undefined,
  inputValues: Record<string, unknown>,
) {
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
  const liveVarValues = useMemo(() => {
    const values: Record<string, unknown> = {}
    for (const varName of sharedVarNames) {
      if (inputValues[varName] !== undefined) {
        values[varName] = inputValues[varName]
      }
    }
    return values
  }, [sharedVarNames, inputValues]);

  return { sharedVarNames, liveVarValues, initialData }
}
