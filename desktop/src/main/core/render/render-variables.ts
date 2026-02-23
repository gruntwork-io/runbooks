// ============================================================================
// Multi-trial variable rendering algorithm
// Ported from render/render_template.go:RenderVariables (lines 95-142)
// ============================================================================

import { tryRenderTemplate } from '../../template-renderer'

const MAX_RENDER_ATTEMPTS = 15

/**
 * Render variables that may reference each other using Go template syntax.
 *
 * This is a multi-trial algorithm: we continuously attempt to render each
 * unrendered variable against the currently rendered set. Variables that
 * succeed are moved to the rendered set; those that fail (due to missing
 * references) stay in the unrendered set. We keep iterating until all are
 * rendered or no progress is made.
 *
 * Ported from render.RenderVariables in render/render_template.go
 */
export function renderVariables(
  variablesToRender: Record<string, unknown>,
  alreadyRenderedVariables: Record<string, unknown>
): Record<string, unknown> {
  let unrenderedNames = Object.keys(variablesToRender)
  const renderedVariables = { ...alreadyRenderedVariables }
  let madeProgress = true

  for (let iteration = 0; unrenderedNames.length > 0 && madeProgress; iteration++) {
    if (iteration > MAX_RENDER_ATTEMPTS) {
      throw new Error(
        `Reached maximum supported iterations (${MAX_RENDER_ATTEMPTS}) for rendering variables. ` +
          `This can happen if you have cyclic variable references or deeper than supported variable references.`
      )
    }

    const result = attemptRenderVariables(unrenderedNames, renderedVariables, variablesToRender)
    unrenderedNames = result.unrenderedNames
    madeProgress = result.madeProgress

    // Merge newly rendered variables
    for (const [name, value] of Object.entries(result.newlyRendered)) {
      renderedVariables[name] = value
    }
  }

  if (unrenderedNames.length > 0) {
    throw new Error(
      `Failed to render variables: ${unrenderedNames.join(', ')}. ` +
        `These may have unresolvable references.`
    )
  }

  return renderedVariables
}

interface AttemptResult {
  unrenderedNames: string[]
  newlyRendered: Record<string, unknown>
  madeProgress: boolean
}

/**
 * Single trial: attempt to render each unrendered variable.
 * Ported from render.attemptRenderVariables
 */
function attemptRenderVariables(
  unrenderedNames: string[],
  renderedVariables: Record<string, unknown>,
  allVariables: Record<string, unknown>
): AttemptResult {
  const newUnrendered: string[] = []
  const newlyRendered: Record<string, unknown> = {}
  let madeProgress = false

  for (const name of unrenderedNames) {
    const result = attemptRenderVariable(allVariables[name], renderedVariables)
    if (result.error) {
      newUnrendered.push(name)
    } else {
      newlyRendered[name] = result.value
      // Also add to rendered so subsequent variables in this iteration can see it
      renderedVariables[name] = result.value
      madeProgress = true
    }
  }

  return { unrenderedNames: newUnrendered, newlyRendered, madeProgress }
}

/**
 * Attempt to render a single variable value against the rendered variables.
 * Handles recursive types (maps, lists) by walking the structure.
 * Ported from render.attemptRenderVariable
 */
function attemptRenderVariable(
  value: unknown,
  renderedVariables: Record<string, unknown>
): { value?: unknown; error?: string } {
  if (value === null || value === undefined) {
    return { value }
  }

  if (typeof value === 'string') {
    // Only try to render if the string contains template syntax
    if (!value.includes('{{')) {
      return { value }
    }
    const result = tryRenderTemplate(value, renderedVariables)
    if (result.error) {
      return { error: result.error }
    }
    return { value: result.result }
  }

  if (Array.isArray(value)) {
    const rendered: unknown[] = []
    for (const item of value) {
      const result = attemptRenderVariable(item, renderedVariables)
      if (result.error) {
        return { error: result.error }
      }
      rendered.push(result.value)
    }
    return { value: rendered }
  }

  if (typeof value === 'object') {
    const rendered: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // Render the key
      const keyResult = attemptRenderVariable(key, renderedVariables)
      if (keyResult.error) {
        return { error: keyResult.error }
      }

      // Render the value
      const valResult = attemptRenderVariable(val, renderedVariables)
      if (valResult.error) {
        return { error: valResult.error }
      }

      rendered[String(keyResult.value)] = valResult.value
    }
    return { value: rendered }
  }

  // For other types (number, boolean), return as-is
  return { value }
}
