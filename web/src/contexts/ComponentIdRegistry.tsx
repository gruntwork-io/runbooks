import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
} from "react"
import type { ReactNode, RefObject } from "react"
import { normalizeBlockId } from "../lib/utils"
import { useShowChapterOf } from "./useRunbookChapters"

export type BlockComponentType =
  | "Command"
  | "Check"
  | "Finish"
  | "Prerequisites"
  | "Inputs"
  | "TfModule"
  | "TerragruntApply"
  | "Template"
  | "TemplateInline"
  | "AwsAuth"
  | "GoogleAuth"
  | "GitAuth"
  | "GitHubAuth"
  | "GitLabAuth"
  | "GitClone"
  | "GitPullRequest"
  | "GitHubPullRequest"
  | "GitLabMergeRequest"
  | "GitCommitPush"
  | "DirPicker"
  | "Iframe"

interface ComponentRegistration {
  id: string
  normalizedId: string // ID with hyphens converted to underscores
  componentType: BlockComponentType
  instanceId: string // Unique per-render instance to track unmounts
  /** The block's outermost element, for links that scroll to it. */
  element: RefObject<HTMLElement | null> | undefined
  /** The OAuth scopes an auth block requests, for blocks that check a binding to it. */
  scopes?: readonly string[] | undefined
  /** Where a pull request block works, for blocks that work on its pull request. */
  pullRequest?: PullRequestPlace | undefined
}

/** The clone and provider a pull request block works with. */
export interface PullRequestPlace {
  /** The <GitClone> block whose clone it opens the pull request from. */
  readonly cloneId?: string | undefined
  readonly provider: "github" | "gitlab"
}

interface DuplicateInfo {
  /** Whether this is a duplicate (exact same ID or normalized collision) */
  isDuplicate: boolean
  /** Whether this is a normalized collision (different raw IDs but same normalized ID) */
  isNormalizedCollision: boolean
  /** The other component(s) this collides with */
  collidingComponents: ComponentRegistration[]
  /** The colliding ID (for normalized collisions, this is different from the current ID) */
  collidingId?: string | undefined
}

interface ComponentIdRegistryContextValue {
  registerComponent: (
    id: string,
    componentType: ComponentRegistration["componentType"],
    element: ComponentRegistration["element"],
    scopes?: readonly string[],
  ) => string // Returns instanceId
  unregisterComponent: (instanceId: string) => void
  /** Records where a registered pull request block works, without registering it again. */
  setPullRequestPlace: (instanceId: string, place: PullRequestPlace | undefined) => void
  getDuplicateInfo: (id: string, instanceId: string) => DuplicateInfo
  /** The element of the block with this id, if one is rendered. */
  elementOf: (templateId: string) => HTMLElement | null
}

const ComponentIdRegistryContext = createContext<ComponentIdRegistryContextValue | undefined>(
  undefined,
)

/** A block on the page, as other blocks look it up. */
export interface PageBlock {
  /** Its id as the runbook writes it. */
  readonly id: string
  readonly kind: BlockComponentType
  /** The OAuth scopes it requests, for an auth block that has scopes. */
  readonly scopes?: readonly string[] | undefined
  /** Its outermost element, for where it is on the page. */
  readonly element?: RefObject<HTMLElement | null> | undefined
  /** For a pull request block, the clone and provider it works with. */
  readonly pullRequest?: PullRequestPlace | undefined
}

/** Each registered block, keyed by its normalized id. */
const BlockIdsContext = createContext<ReadonlyMap<string, PageBlock>>(new Map())

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
  useLayoutEffect(() => {
    registrationsRef.current = registrations
  }, [registrations])

  const registerComponent = useCallback(
    (
      id: string,
      componentType: ComponentRegistration["componentType"],
      element: ComponentRegistration["element"],
      scopes?: readonly string[],
    ): string => {
      const instanceId = `${componentType}-${id}-${++instanceCounter.current}`
      const normalizedId = normalizeBlockId(id)

      setRegistrations((prev) => [
        ...prev,
        { id, normalizedId, componentType, instanceId, element, scopes },
      ])

      return instanceId
    },
    [],
  )

  const unregisterComponent = useCallback((instanceId: string) => {
    setRegistrations((prev) => prev.filter((r) => r.instanceId !== instanceId))
  }, [])

  const setPullRequestPlace = useCallback(
    (instanceId: string, place: PullRequestPlace | undefined) => {
      setRegistrations((prev) =>
        prev.map((r) => (r.instanceId === instanceId ? { ...r, pullRequest: place } : r)),
      )
    },
    [],
  )

  // Get detailed duplicate/collision info for a component
  const getDuplicateInfo = useCallback((id: string, instanceId: string): DuplicateInfo => {
    const normalizedId = normalizeBlockId(id)

    // Find all components with the same normalized ID (excludes self)
    const collisions = registrationsRef.current.filter(
      (r) => r.normalizedId === normalizedId && r.instanceId !== instanceId,
    )

    if (collisions.length === 0) {
      return {
        isDuplicate: false,
        isNormalizedCollision: false,
        collidingComponents: [],
      }
    }

    // Check if it's an exact duplicate or a normalized collision
    const exactDuplicates = collisions.filter((r) => r.id === id)
    const normalizedCollisions = collisions.filter((r) => r.id !== id)

    return {
      isDuplicate: true,
      isNormalizedCollision: normalizedCollisions.length > 0 && exactDuplicates.length === 0,
      collidingComponents: collisions,
      collidingId: normalizedCollisions[0]?.id,
    }
  }, [])

  const elementOf = useCallback((templateId: string): HTMLElement | null => {
    const normalizedId = normalizeBlockId(templateId)
    for (const r of registrationsRef.current) {
      if (r.normalizedId === normalizedId && r.element?.current) return r.element.current
    }
    return null
  }, [])

  // Memoize context value to prevent unnecessary re-renders
  const value = useMemo(
    () => ({
      registerComponent,
      unregisterComponent,
      setPullRequestPlace,
      getDuplicateInfo,
      elementOf,
    }),
    [registerComponent, unregisterComponent, setPullRequestPlace, getDuplicateInfo, elementOf],
  )

  // Separate from `value`, which stays stable, so only the components that
  // name blocks re-render when one registers.
  const blockIds = useMemo(
    () =>
      new Map(
        registrations.map((r): [string, PageBlock] => [
          r.normalizedId,
          {
            id: r.id,
            kind: r.componentType,
            scopes: r.scopes,
            element: r.element,
            pullRequest: r.pullRequest,
          },
        ]),
      ),
    [registrations],
  )

  return (
    <ComponentIdRegistryContext.Provider value={value}>
      <BlockIdsContext.Provider value={blockIds}>{children}</BlockIdsContext.Provider>
    </ComponentIdRegistryContext.Provider>
  )
}

interface PageBlocks {
  /**
   * A block's id as the runbook writes it (`create-account`), for the id a
   * template refers to it by (`create_account`). An id that no block on the
   * page has is returned as is.
   */
  asWritten: (templateId: string) => string
  /**
   * Whether a block on the page has this id. Undefined while no block has
   * registered: without a registry, and in the first render, since blocks
   * register in their effects.
   */
  isOnPage: (templateId: string) => boolean | undefined
  /** The block with this id, if one is on the page. */
  blockOf: (templateId: string) => PageBlock | undefined
  /** The blocks of one kind on the page, such as every GitClone. */
  blocksOf: (kind: string) => PageBlock[]
  /**
   * The blocks of one kind that come before the block with this id on the
   * page, in page order, such as the GitClone blocks above a pull request.
   */
  blocksAbove: (kind: string, templateId: string) => PageBlock[]
  /** Whether blocks have registered yet, so a block that isn't on the page is missing. */
  registered: boolean
}

/** Looks up the blocks on the page by the id a template refers to them by. */
export function usePageBlocks(): PageBlocks {
  const blockIds = useContext(BlockIdsContext)
  return useMemo(
    () => ({
      asWritten: (templateId) => blockIds.get(normalizeBlockId(templateId))?.id ?? templateId,
      isOnPage: (templateId) =>
        blockIds.size === 0 ? undefined : blockIds.has(normalizeBlockId(templateId)),
      blockOf: (templateId) => blockIds.get(normalizeBlockId(templateId)),
      blocksOf: (kind) => [...blockIds.values()].filter((block) => block.kind === kind),
      blocksAbove: (kind, templateId) => {
        const self = blockIds.get(normalizeBlockId(templateId))?.element?.current
        if (!self) return []
        const above = [...blockIds.values()].flatMap((block) => {
          const element = block.kind === kind ? block.element?.current : null
          return element && element.compareDocumentPosition(self) & Node.DOCUMENT_POSITION_FOLLOWING
            ? [{ block, element }]
            : []
        })
        return above
          .sort((a, b) =>
            a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING
              ? -1
              : 1,
          )
          .map(({ block }) => block)
      },
      registered: blockIds.size > 0,
    }),
    [blockIds],
  )
}

/**
 * Returns a function that scrolls the block with an id to the middle of the
 * view, for a link to it from a block that waits on it. A block in a hidden
 * chapter shows that chapter first.
 */
export function useRevealBlock(): (templateId: string) => void {
  const elementOf = useContext(ComponentIdRegistryContext)?.elementOf
  const showChapterOf = useShowChapterOf()
  return (templateId) => {
    const element = elementOf?.(templateId)
    showChapterOf(element)
    element?.scrollIntoView({ behavior: "smooth", block: "center" })
  }
}

/**
 * Hook to register a component and check for duplicate IDs.
 * Returns duplicate info including whether it's an exact duplicate or normalized collision.
 * A block passes its outermost element so that other blocks can link to it.
 */
export function useComponentIdRegistry(
  id: string,
  componentType: ComponentRegistration["componentType"],
  element?: RefObject<HTMLElement | null>,
  scopes?: readonly string[],
  pullRequest?: PullRequestPlace,
) {
  const context = useContext(ComponentIdRegistryContext)
  const instanceIdRef = useRef<string | null>(null)
  const [duplicateInfo, setDuplicateInfo] = useState<DuplicateInfo>({
    isDuplicate: false,
    isNormalizedCollision: false,
    collidingComponents: [],
  })

  // Extract functions to avoid depending on context object reference
  const registerComponent = context?.registerComponent
  const unregisterComponent = context?.unregisterComponent
  const getDuplicateInfoFn = context?.getDuplicateInfo
  // Registers again when the scopes change, not when a new array holds the same ones.
  const scopesKey = scopes?.join(" ")
  const registeredScopes = useMemo(
    () => (scopesKey === undefined ? undefined : scopesKey.split(" ").filter(Boolean)),
    [scopesKey],
  )

  // Register on mount, unregister on unmount
  useEffect(() => {
    if (!registerComponent || !unregisterComponent) return

    // Register this component
    instanceIdRef.current = registerComponent(id, componentType, element, registeredScopes)

    return () => {
      if (instanceIdRef.current) {
        unregisterComponent(instanceIdRef.current)
      }
    }
  }, [registerComponent, unregisterComponent, id, componentType, element, registeredScopes])

  // The place changes once the block finds its clone. Updated in place, since
  // registering again would leave a render without the block on the page.
  const setPlace = context?.setPullRequestPlace
  const placeCloneId = pullRequest?.cloneId
  const placeProvider = pullRequest?.provider
  useEffect(() => {
    if (!setPlace || !instanceIdRef.current) return
    setPlace(
      instanceIdRef.current,
      placeProvider === undefined ? undefined : { cloneId: placeCloneId, provider: placeProvider },
    )
  }, [setPlace, placeCloneId, placeProvider, registerComponent, id, componentType, element])

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
      duplicateInfo: [],
    }
  }

  return {
    isDuplicate: duplicateInfo.isDuplicate,
    isNormalizedCollision: duplicateInfo.isNormalizedCollision,
    collidingId: duplicateInfo.collidingId,
    duplicateInfo: duplicateInfo.collidingComponents,
  }
}
