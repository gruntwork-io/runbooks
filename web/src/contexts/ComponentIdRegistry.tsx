import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type { ReactNode } from 'react'

/**
 * Normalize a block ID for collision detection.
 * Go templates don't support hyphens in dot notation (e.g., ._blocks.create-account fails),
 * so we normalize hyphens to underscores. This means "create-account" and "create_account"
 * would collide when used in templates.
 */
function normalizeBlockId(id: string): string {
  return id.replace(/-/g, '_')
}

interface ComponentRegistration {
  id: string
  normalizedId: string // ID with hyphens converted to underscores
  componentType: 'Command' | 'Check' | 'Inputs' | 'Template' | 'AwsAuth'
  instanceId: string // Unique per-render instance to track unmounts
}

export interface DuplicateInfo {
  /** Whether this is a duplicate (exact same ID or normalized collision) */
  isDuplicate: boolean
  /** Whether this is a normalized collision (different raw IDs but same normalized ID) */
  isNormalizedCollision: boolean
  /** The other component(s) this collides with */
  collidingComponents: ComponentRegistration[]
  /** The colliding ID (for normalized collisions, this is different from the current ID) */
  collidingId?: string
}

interface ComponentIdRegistryContextValue {
  registerComponent: (id: string, componentType: ComponentRegistration['componentType']) => string // Returns instanceId
  unregisterComponent: (instanceId: string) => void
  getDuplicateInfo: (id: string, instanceId: string) => DuplicateInfo
}

const ComponentIdRegistryContext = createContext<ComponentIdRegistryContextValue | undefined>(undefined)

/**
 * Provider that tracks all component IDs to detect duplicates.
 * Components register on mount and unregister on unmount.
 * 
 * Detects both exact duplicates and normalized collisions:
 * - Exact: two components with id="foo"
 * - Normalized: one with id="create-account", another with id="create_account"
 *   (both normalize to "create_account" for Go template access)
 */
export function ComponentIdRegistryProvider({ children }: { children: ReactNode }) {
  const [registrations, setRegistrations] = useState<ComponentRegistration[]>([])
  const instanceCounter = useRef(0)
  // Use a ref to access current registrations in callbacks without causing re-renders
  const registrationsRef = useRef<ComponentRegistration[]>([])
  registrationsRef.current = registrations

  const registerComponent = useCallback((id: string, componentType: ComponentRegistration['componentType']): string => {
    const instanceId = `${componentType}-${id}-${++instanceCounter.current}`
    const normalizedId = normalizeBlockId(id)
    
    setRegistrations(prev => [...prev, { id, normalizedId, componentType, instanceId }])
    
    return instanceId
  }, [])

  const unregisterComponent = useCallback((instanceId: string) => {
    setRegistrations(prev => prev.filter(r => r.instanceId !== instanceId))
  }, [])

  // Get detailed duplicate/collision info for a component
  const getDuplicateInfo = useCallback((id: string, instanceId: string): DuplicateInfo => {
    const normalizedId = normalizeBlockId(id)
    
    // Find all components with the same normalized ID (excludes self)
    const collisions = registrationsRef.current.filter(
      r => r.normalizedId === normalizedId && r.instanceId !== instanceId
    )
    
    if (collisions.length === 0) {
      return {
        isDuplicate: false,
        isNormalizedCollision: false,
        collidingComponents: []
      }
    }
    
    // Check if it's an exact duplicate or a normalized collision
    const exactDuplicates = collisions.filter(r => r.id === id)
    const normalizedCollisions = collisions.filter(r => r.id !== id)
    
    return {
      isDuplicate: true,
      isNormalizedCollision: normalizedCollisions.length > 0 && exactDuplicates.length === 0,
      collidingComponents: collisions,
      collidingId: normalizedCollisions.length > 0 ? normalizedCollisions[0].id : undefined
    }
  }, [])

  // Memoize context value to prevent unnecessary re-renders
  const value = useMemo(() => ({
    registerComponent,
    unregisterComponent,
    getDuplicateInfo
  }), [registerComponent, unregisterComponent, getDuplicateInfo])

  return (
    <ComponentIdRegistryContext.Provider value={value}>
      {children}
    </ComponentIdRegistryContext.Provider>
  )
}

/**
 * Hook to register a component and check for duplicate IDs.
 * Returns duplicate info including whether it's an exact duplicate or normalized collision.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useComponentIdRegistry(id: string, componentType: ComponentRegistration['componentType']) {
  const context = useContext(ComponentIdRegistryContext)
  const instanceIdRef = useRef<string | null>(null)
  const [duplicateInfo, setDuplicateInfo] = useState<DuplicateInfo>({
    isDuplicate: false,
    isNormalizedCollision: false,
    collidingComponents: []
  })
  
  // Extract functions to avoid depending on context object reference
  const registerComponent = context?.registerComponent
  const unregisterComponent = context?.unregisterComponent
  const getDuplicateInfoFn = context?.getDuplicateInfo

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
    if (!getDuplicateInfoFn || !instanceIdRef.current) return

    // Small timeout to let other components register first
    const timeoutId = setTimeout(() => {
      if (!instanceIdRef.current) return
      const info = getDuplicateInfoFn(id, instanceIdRef.current)
      setDuplicateInfo(info)
    }, 0)

    return () => clearTimeout(timeoutId)
  }, [getDuplicateInfoFn, id])

  // If no provider, don't enforce uniqueness
  if (!context) {
    return { 
      isDuplicate: false, 
      isNormalizedCollision: false,
      collidingId: undefined,
      duplicateInfo: [] 
    }
  }

  return { 
    isDuplicate: duplicateInfo.isDuplicate,
    isNormalizedCollision: duplicateInfo.isNormalizedCollision,
    collidingId: duplicateInfo.collidingId,
    duplicateInfo: duplicateInfo.collidingComponents 
  }
}


