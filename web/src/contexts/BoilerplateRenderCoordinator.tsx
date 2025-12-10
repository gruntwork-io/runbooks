import { useState, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { FileTreeNode } from '@/components/artifacts/code/FileTree'
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
 *   <Inputs id="test">...</Inputs>
 *   <BoilerplateTemplate inputsId="test" outputPath="file1.hcl">...</BoilerplateTemplate>
 *   <BoilerplateTemplate inputsId="test" outputPath="file2.hcl">...</BoilerplateTemplate>
 * </BoilerplateRenderCoordinatorProvider>
 */
export function BoilerplateRenderCoordinatorProvider({ children }: { children: ReactNode }) {
  const [registrations, setRegistrations] = useState<TemplateRegistration[]>([])
  const { setFileTree } = useFileTree()

  // Register a template - returns unregister function
  const registerTemplate = useCallback((registration: TemplateRegistration) => {
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
      setRegistrations(prev => prev.filter(r => r.templateId !== registration.templateId))
    }
  }, [])

  // Render all templates for a specific inputsId atomically
  const renderAllForInputsId = useCallback(async (inputsId: string, variables: Record<string, unknown>) => {
    // Find all templates registered for this inputsId
    const templatesForInputsId = registrations.filter(r => r.inputsId === inputsId)
    
    if (templatesForInputsId.length === 0) {
      // No templates registered - this is fine, just exit early
      return
    }

    try {
      // Render all templates in parallel
      const fileTreePromises = templatesForInputsId.map(async (template) => {
        try {
          const fileTreeResult = await template.renderFn(variables)
          return fileTreeResult
        } catch (error) {
          console.error(`[RenderCoordinator] Error rendering template ${template.templateId}:`, error)
          return [] // Return empty array on error so other templates can still succeed
        }
      })

      const fileTrees = await Promise.all(fileTreePromises)

      // Merge all file trees atomically using functional update to avoid stale closure
      setFileTree(currentFileTree => {
        const mergedTree = fileTrees.reduce<FileTreeNode[] | null>(
          (acc, tree) => mergeFileTrees(acc, tree),
          currentFileTree
        )
        
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


