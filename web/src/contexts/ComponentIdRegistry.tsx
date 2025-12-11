import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

interface ComponentRegistration {
  id: string
  componentType: 'Command' | 'Check' | 'Inputs' | 'Template'
  instanceId: string // Unique per-render instance to track unmounts
}

interface ComponentIdRegistryContextValue {
  registerComponent: (id: string, componentType: ComponentRegistration['componentType']) => string // Returns instanceId
  unregisterComponent: (instanceId: string) => void
  getDuplicates: (id: string) => ComponentRegistration[]
  isDuplicate: (id: string, instanceId: string) => boolean
}

const ComponentIdRegistryContext = createContext<ComponentIdRegistryContextValue | undefined>(undefined)

/**
 * Provider that tracks all component IDs to detect duplicates.
 * Components register on mount and unregister on unmount.
 */
export function ComponentIdRegistryProvider({ children }: { children: ReactNode }) {
  const [registrations, setRegistrations] = useState<ComponentRegistration[]>([])
  const instanceCounter = useRef(0)

  const registerComponent = useCallback((id: string, componentType: ComponentRegistration['componentType']): string => {
    const instanceId = `${componentType}-${id}-${++instanceCounter.current}`
    
    setRegistrations(prev => [...prev, { id, componentType, instanceId }])
    
    return instanceId
  }, [])

  const unregisterComponent = useCallback((instanceId: string) => {
    setRegistrations(prev => prev.filter(r => r.instanceId !== instanceId))
  }, [])

  const getDuplicates = useCallback((id: string): ComponentRegistration[] => {
    return registrations.filter(r => r.id === id)
  }, [registrations])

  const isDuplicate = useCallback((id: string, instanceId: string): boolean => {
    const matches = registrations.filter(r => r.id === id)
    // It's a duplicate if there are multiple registrations with this ID
    // and this instance is not the first one
    if (matches.length <= 1) return false
    const firstMatch = matches[0]
    return firstMatch.instanceId !== instanceId
  }, [registrations])

  return (
    <ComponentIdRegistryContext.Provider value={{ registerComponent, unregisterComponent, getDuplicates, isDuplicate }}>
      {children}
    </ComponentIdRegistryContext.Provider>
  )
}

/**
 * Hook to register a component and check for duplicate IDs.
 * Returns whether this component is a duplicate.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useComponentIdRegistry(id: string, componentType: ComponentRegistration['componentType']) {
  const context = useContext(ComponentIdRegistryContext)
  const instanceIdRef = useRef<string | null>(null)
  const [isDuplicate, setIsDuplicate] = useState(false)
  const [duplicateInfo, setDuplicateInfo] = useState<ComponentRegistration[]>([])

  // Register on mount, unregister on unmount
  useEffect(() => {
    if (!context) return

    // Register this component
    instanceIdRef.current = context.registerComponent(id, componentType)

    return () => {
      if (instanceIdRef.current) {
        context.unregisterComponent(instanceIdRef.current)
      }
    }
  }, [context, id, componentType])

  // Check for duplicates after registration
  useEffect(() => {
    if (!context || !instanceIdRef.current) return

    const duplicates = context.getDuplicates(id)
    const isThisDuplicate = context.isDuplicate(id, instanceIdRef.current)
    
    setIsDuplicate(isThisDuplicate)
    setDuplicateInfo(duplicates)
  }, [context, id])

  // If no provider, don't enforce uniqueness
  if (!context) {
    return { isDuplicate: false, duplicateInfo: [] }
  }

  return { isDuplicate, duplicateInfo }
}


