import { useState, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { CodeFileData } from '@/components/artifacts/code/FileTree'
import { mergeFileTrees } from '@/lib/mergeFileTrees'
import { useFileTree } from '@/hooks/useFileTree'
import { BoilerplateRenderCoordinatorContext } from './BoilerplateRenderCoordinator.types'
import type { TemplateRegistration } from './BoilerplateRenderCoordinator.types'

/**
 * Provider component that coordinates rendering across multiple BoilerplateTemplate components.
 * 
 * This coordinator enables:
 * 1. Templates to register themselves on mount
 * 2. Atomic rendering of all templates when user clicks Generate
 * 3. Race-free file tree merging
 * 
 * @example
 * <BoilerplateRenderCoordinatorProvider>
 *   <BoilerplateInputs id="test">...</BoilerplateInputs>
 *   <BoilerplateTemplate boilerplateInputsId="test" outputPath="file1.hcl">...</BoilerplateTemplate>
 *   <BoilerplateTemplate boilerplateInputsId="test" outputPath="file2.hcl">...</BoilerplateTemplate>
 * </BoilerplateRenderCoordinatorProvider>
 */
export function BoilerplateRenderCoordinatorProvider({ children }: { children: ReactNode }) {
  const [registrations, setRegistrations] = useState<TemplateRegistration[]>([])
  const { fileTree, setFileTree } = useFileTree()

  // Register a template - returns unregister function
  const registerTemplate = useCallback((registration: TemplateRegistration) => {
    console.log(`[RenderCoordinator] Registering template:`, registration.templateId, 'for inputsId:', registration.inputsId)
    
    setRegistrations(prev => {
      // Prevent duplicate registrations
      if (prev.some(r => r.templateId === registration.templateId)) {
        console.warn(`[RenderCoordinator] Template ${registration.templateId} already registered, skipping`)
        return prev
      }
      return [...prev, registration]
    })

    // Return unregister function
    return () => {
      console.log(`[RenderCoordinator] Unregistering template:`, registration.templateId)
      setRegistrations(prev => prev.filter(r => r.templateId !== registration.templateId))
    }
  }, [])

  // Render all templates for a specific inputsId atomically
  const renderAllForInputsId = useCallback(async (inputsId: string, variables: Record<string, unknown>) => {
    console.log(`[RenderCoordinator] Rendering all templates for inputsId:`, inputsId, 'with variables:', variables)
    
    // Find all templates registered for this inputsId
    const templatesForInputsId = registrations.filter(r => r.inputsId === inputsId)
    
    if (templatesForInputsId.length === 0) {
      console.warn(`[RenderCoordinator] No templates registered for inputsId: ${inputsId}`)
      return
    }

    console.log(`[RenderCoordinator] Found ${templatesForInputsId.length} template(s) to render:`, 
      templatesForInputsId.map(t => t.templateId))

    try {
      // Render all templates in parallel
      const fileTreePromises = templatesForInputsId.map(async (template) => {
        console.log(`[RenderCoordinator] Rendering template: ${template.templateId}`)
        try {
          const fileTreeResult = await template.renderFn(variables)
          console.log(`[RenderCoordinator] Successfully rendered template: ${template.templateId}`)
          return fileTreeResult
        } catch (error) {
          console.error(`[RenderCoordinator] Error rendering template ${template.templateId}:`, error)
          return [] // Return empty array on error so other templates can still succeed
        }
      })

      const fileTrees = await Promise.all(fileTreePromises)

      // Merge all file trees atomically using functional update to avoid stale closure
      console.log(`[RenderCoordinator] Merging ${fileTrees.length} file tree(s)`)
      setFileTree(currentFileTree => {
        const mergedTree = fileTrees.reduce<CodeFileData[] | null>(
          (acc, tree) => mergeFileTrees(acc, tree),
          currentFileTree
        )
        
        if (mergedTree) {
          console.log(`[RenderCoordinator] Setting merged file tree with ${mergedTree.length} top-level items`)
        }
        
        return mergedTree
      })
    } catch (error) {
      console.error(`[RenderCoordinator] Error during coordinated render:`, error)
      throw error
    }
  }, [registrations, setFileTree])

  const contextValue = useMemo(() => ({
    registerTemplate,
    renderAllForInputsId
  }), [registerTemplate, renderAllForInputsId])

  return (
    <BoilerplateRenderCoordinatorContext.Provider value={contextValue}>
      {children}
    </BoilerplateRenderCoordinatorContext.Provider>
  )
}


