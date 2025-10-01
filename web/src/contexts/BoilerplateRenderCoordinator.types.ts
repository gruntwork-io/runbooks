import { createContext } from 'react'
import type { FileTreeNode } from '@/components/artifacts/code/FileTree'

/**
 * A template registration that the coordinator manages.
 * Each BoilerplateTemplate component registers itself with a unique ID and render function.
 */
export interface TemplateRegistration {
  templateId: string  // Unique identifier for this template (e.g., "test-/a/b.hcl")
  inputsId: string    // The BoilerplateInputs ID this template belongs to
  renderFn: (variables: Record<string, unknown>) => Promise<FileTreeNode[]>  // Function to render this template
}

export interface BoilerplateRenderCoordinatorContextValue {
  // Register a template with the coordinator. Returns an unregister function.
  registerTemplate: (registration: TemplateRegistration) => () => void
  
  // Render all templates associated with a specific inputsId
  renderAllForInputsId: (inputsId: string, variables: Record<string, unknown>) => Promise<void>
}

export const BoilerplateRenderCoordinatorContext = createContext<BoilerplateRenderCoordinatorContextValue | null>(null)

