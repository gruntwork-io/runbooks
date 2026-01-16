import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type { ReactNode } from 'react'

interface ComponentRegistration {
  id: string
  componentType: 'Command' | 'Check' | 'Inputs' | 'Template' | 'AwsAuth'
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
  // Use a ref to access current registrations in callbacks without causing re-renders
  const registrationsRef = useRef<ComponentRegistration[]>([])
  registrationsRef.current = registrations

  const registerComponent = useCallback((id: string, componentType: ComponentRegistration['componentType']): string => {
    const instanceId = `${componentType}-${id}-${++instanceCounter.current}`
    
    setRegistrations(prev => [...prev, { id, componentType, instanceId }])
    
    return instanceId
  }, [])

  const unregisterComponent = useCallback((instanceId: string) => {
    setRegistrations(prev => prev.filter(r => r.instanceId !== instanceId))
  }, [])

  // Use ref-based access to avoid dependency on registrations state
  const getDuplicates = useCallback((id: string): ComponentRegistration[] => {
    return registrationsRef.current.filter(r => r.id === id)
  }, [])

  const isDuplicate = useCallback((id: string, instanceId: string): boolean => {
    const matches = registrationsRef.current.filter(r => r.id === id)
    // It's a duplicate if there are multiple registrations with this ID
    // and this instance is not the first one
    if (matches.length <= 1) return false
    const firstMatch = matches[0]
    return firstMatch.instanceId !== instanceId
  }, [])

  // Memoize context value to prevent unnecessary re-renders
  const value = useMemo(() => ({
    registerComponent,
    unregisterComponent,
    getDuplicates,
    isDuplicate
  }), [registerComponent, unregisterComponent, getDuplicates, isDuplicate])

  return (
    <ComponentIdRegistryContext.Provider value={value}>
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
  
  // Extract functions to avoid depending on context object reference
  const registerComponent = context?.registerComponent
  const unregisterComponent = context?.unregisterComponent
  const getDuplicates = context?.getDuplicates
  const isDuplicateFn = context?.isDuplicate

  // Register on mount, unregister on unmount
  useEffect(() => {
    if (!registerComponent || !unregisterComponent) return

    // Register this component
    instanceIdRef.current = registerComponent(id, componentType)

    return () => {
      if (instanceIdRef.current) {
        unregisterComponent(instanceIdRef.current)
      }
    }
  }, [registerComponent, unregisterComponent, id, componentType])

  // Check for duplicates after registration - use a small delay to allow all components to register
  useEffect(() => {
    if (!getDuplicates || !isDuplicateFn || !instanceIdRef.current) return

    // Small timeout to let other components register first
    const timeoutId = setTimeout(() => {
      if (!instanceIdRef.current) return
      const duplicates = getDuplicates(id)
      const isThisDuplicate = isDuplicateFn(id, instanceIdRef.current)
      
      setIsDuplicate(isThisDuplicate)
      setDuplicateInfo(duplicates)
    }, 0)

    return () => clearTimeout(timeoutId)
  }, [getDuplicates, isDuplicateFn, id])

  // If no provider, don't enforce uniqueness
  if (!context) {
    return { isDuplicate: false, duplicateInfo: [] }
  }

  return { isDuplicate, duplicateInfo }
}


