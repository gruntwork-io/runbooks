import { useState, useEffect, useRef } from "react"
import { Check, ChevronsUpDown, ChevronDown, ChevronUp, Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { GitLabIcon } from "@/components/icons/GitLabIcon"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import type { GitLabNamespace, GitLabProject, GitLabProjectList, GitLabRef } from "../types"
import { RefSelect } from "./RefSelect"

interface GitLabBrowserProps {
  /** Callback when a project is selected, with its HTTPS clone URL */
  onRepoSelected: (url: string) => void
  /** Callback when a ref (branch/tag) is selected */
  onRefSelected: (ref: string) => void
  /** The user's personal namespace and the groups they belong to */
  fetchNamespaces: () => Promise<GitLabNamespace[]>
  /** Projects in a namespace, narrowed on the server by `search` when given */
  fetchProjects: (namespace: GitLabNamespace, search?: string) => Promise<GitLabProjectList>
  /** Branches and tags of the project at a full path */
  fetchRefs: (projectPath: string) => Promise<GitLabRef[]>
  disabled?: boolean | undefined
  /** Full path of the project to pre-select (`group/subgroup/project`), parsed from the URL */
  initialProject?: string | undefined
  defaultOpen?: boolean | undefined
}

/** A list response tagged with the selection it was fetched for. */
interface FetchResult<T> {
  key: string
  items: T[]
  error: string | null
}

interface ProjectsResult extends FetchResult<GitLabProject> {
  truncated: boolean
}

const NO_PROJECTS: GitLabProject[] = []
const NO_REFS: GitLabRef[] = []
const SEARCH_DEBOUNCE_MS = 300

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error ? cleanIpcErrorMessage(err.message) : fallback

const namespaceKey = (ns: GitLabNamespace | null) => (ns ? `${ns.kind}:${ns.id}` : "")

const isUnder = (path: string, namespace: string) =>
  path.toLowerCase().startsWith(`${namespace.toLowerCase()}/`)

/** A project's path inside the namespace it was listed under. */
const pathInNamespace = (path: string, ns: GitLabNamespace | null) =>
  ns && isUnder(path, ns.fullPath) ? path.slice(ns.fullPath.length + 1) : path

export function GitLabBrowser({
  onRepoSelected,
  onRefSelected,
  fetchNamespaces,
  fetchProjects,
  fetchRefs,
  disabled = false,
  initialProject,
  defaultOpen = false,
}: GitLabBrowserProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const [namespaces, setNamespaces] = useState<GitLabNamespace[]>([])
  const [loadingNamespaces, setLoadingNamespaces] = useState(false)
  const [namespacesError, setNamespacesError] = useState<string | null>(null)
  const [selectedNamespace, setSelectedNamespace] = useState<GitLabNamespace | null>(null)
  const [selectedProject, setSelectedProject] = useState(initialProject || "")
  // Default branch of the project the user picked in the browser, selected
  // once its refs load. The project seeded from the block's URL has none, so
  // loading its refs leaves the block's prefilled ref alone.
  const [pickedDefaultBranch, setPickedDefaultBranch] = useState("")
  const [selectedRef, setSelectedRef] = useState("")
  const [namespaceOpen, setNamespaceOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [namespaceSearch, setNamespaceSearch] = useState("")
  const [projectSearch, setProjectSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  // Project lists keyed by namespace and server-side search, so clearing a
  // search shows the namespace's own list again without refetching it.
  const [projectResults, setProjectResults] = useState<Record<string, ProjectsResult>>({})
  const [refsResult, setRefsResult] = useState<FetchResult<GitLabRef> | null>(null)
  const namespaceListRef = useRef<HTMLDivElement>(null)
  const projectListRef = useRef<HTMLDivElement>(null)
  const hasLoadedNamespaces = useRef(false)

  const nsKey = namespaceKey(selectedNamespace)
  const baseKey = nsKey && `${nsKey}|`
  const base = baseKey ? projectResults[baseKey] : undefined
  const loadingProjects = !!nsKey && !base
  const query = projectSearch.trim()
  // A namespace with more projects than one listing holds is searched on the
  // server; otherwise the loaded list is filtered as the user types.
  const searchOnServer = !!base?.truncated && query !== ""
  const searchKey = searchOnServer && debouncedSearch === query ? `${nsKey}|${query}` : ""
  const searched = searchKey ? projectResults[searchKey] : undefined
  const searching = searchOnServer && !searched
  const listed = searchOnServer ? (searched?.items ?? NO_PROJECTS) : (base?.items ?? NO_PROJECTS)
  const projectsError = (searchOnServer ? searched?.error : base?.error) ?? null

  const currentRefs = selectedProject && refsResult?.key === selectedProject ? refsResult : null
  const refs = currentRefs?.items ?? NO_REFS
  const loadingRefs = !!selectedProject && !currentRefs
  const selectedProjectInfo = [...(base?.items ?? []), ...(searched?.items ?? [])].find(
    (p) => p.pathWithNamespace.toLowerCase() === selectedProject.toLowerCase(),
  )
  const defaultBranch = pickedDefaultBranch || selectedProjectInfo?.defaultBranch

  // Load namespaces when the browser opens, and select the one holding the
  // project seeded from the URL: the deepest namespace whose path contains it.
  useEffect(() => {
    if (!isOpen || hasLoadedNamespaces.current) return
    setLoadingNamespaces(true)
    setNamespacesError(null)
    fetchNamespaces()
      .then((result) => {
        hasLoadedNamespaces.current = true
        setNamespaces(result)
        if (initialProject) {
          const holder = result
            .filter((ns) => isUnder(initialProject, ns.fullPath))
            .sort((a, b) => b.fullPath.length - a.fullPath.length)[0]
          if (holder) setSelectedNamespace((prev) => prev ?? holder)
        }
      })
      .catch((err) => setNamespacesError(errorText(err, "Failed to load groups")))
      .finally(() => setLoadingNamespaces(false))
  }, [isOpen, fetchNamespaces, initialProject])

  // Settle the search text before asking the server.
  useEffect(() => {
    if (!base?.truncated) return
    const timer = setTimeout(() => setDebouncedSearch(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, base?.truncated])

  // Load the namespace's projects, or the server's matches for a search.
  // `current` turns false once the selection or search moves on, so a slow
  // response for an earlier one is dropped.
  const fetchQuery = searchOnServer ? debouncedSearch : ""
  const fetchKey = nsKey && (fetchQuery === "" ? baseKey : searchKey)
  const fetchCached = !!fetchKey && fetchKey in projectResults
  useEffect(() => {
    if (!selectedNamespace || !fetchKey || fetchCached) return
    let current = true
    fetchProjects(selectedNamespace, fetchQuery || undefined)
      .then((result) => {
        if (!current) return
        setProjectResults((prev) => ({
          ...prev,
          [fetchKey]: {
            key: fetchKey,
            items: result.projects,
            truncated: result.truncated,
            error: null,
          },
        }))
      })
      .catch((err) => {
        if (!current) return
        setProjectResults((prev) => ({
          ...prev,
          [fetchKey]: {
            key: fetchKey,
            items: [],
            truncated: false,
            error: errorText(err, "Failed to load projects"),
          },
        }))
      })
    return () => {
      current = false
    }
  }, [selectedNamespace, fetchKey, fetchCached, fetchQuery, fetchProjects])

  // Load refs when the project changes, guarded like the projects load.
  useEffect(() => {
    if (!selectedProject) return
    const key = selectedProject
    let current = true
    fetchRefs(key)
      .then((result) => {
        if (!current) return
        setRefsResult({ key, items: result, error: null })
        // Select the default branch, if the project has it (an empty
        // repository has no branches yet)
        if (
          pickedDefaultBranch &&
          result.some((r) => r.type === "branch" && r.name === pickedDefaultBranch)
        ) {
          setSelectedRef(pickedDefaultBranch)
          onRefSelected(pickedDefaultBranch)
        }
      })
      .catch((err) => {
        if (current) setRefsResult({ key, items: [], error: errorText(err, "Failed to load refs") })
      })
    return () => {
      current = false
    }
  }, [selectedProject, pickedDefaultBranch, fetchRefs, onRefSelected])

  useEffect(() => {
    if (namespaceOpen && namespaceListRef.current) {
      namespaceListRef.current.scrollTo({ top: 0 })
    }
  }, [namespaceOpen, namespaceSearch])

  useEffect(() => {
    if (projectOpen && projectListRef.current) {
      projectListRef.current.scrollTo({ top: 0 })
    }
  }, [projectOpen, projectSearch, listed])

  const handleNamespaceSelect = (ns: GitLabNamespace) => {
    setSelectedNamespace(ns)
    setSelectedProject("")
    setPickedDefaultBranch("")
    setSelectedRef("")
    setProjectSearch("")
    setDebouncedSearch("")
    setNamespaceOpen(false)
    setNamespaceSearch("")
  }

  const handleProjectSelect = (project: GitLabProject) => {
    setProjectOpen(false)
    setProjectSearch("")
    onRepoSelected(project.httpUrlToRepo)
    // Re-picking the current project keeps its ref
    if (project.pathWithNamespace.toLowerCase() === selectedProject.toLowerCase()) return
    setSelectedProject(project.pathWithNamespace)
    setPickedDefaultBranch(project.defaultBranch ?? "")
    setSelectedRef("")
    // Drop the previous project's ref: it names a branch or tag of that
    // project, not this one
    onRefSelected("")
  }

  const handleRefSelect = (ref: string) => {
    setSelectedRef(ref)
    onRefSelected(ref)
  }

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className={cn(
          "flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer",
          disabled && "opacity-50 cursor-not-allowed",
        )}
      >
        <GitLabIcon className="size-4" />
        <span>Browse GitLab projects</span>
        {isOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
      </button>

      {isOpen && (
        <div className="mt-2 p-3 bg-muted border border-border rounded-md space-y-3">
          {/* Group or personal namespace selector */}
          <div>
            <label className="text-sm font-medium text-foreground mb-1 block">Group</label>
            <Popover
              open={namespaceOpen}
              onOpenChange={(open) => {
                setNamespaceOpen(open)
                if (!open) setNamespaceSearch("")
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={namespaceOpen}
                  className="w-full justify-between font-normal bg-card border-input hover:bg-accent"
                  disabled={disabled || loadingNamespaces}
                >
                  {loadingNamespaces ? (
                    <span className="text-muted-foreground">Loading groups...</span>
                  ) : selectedNamespace ? (
                    <span className="text-foreground truncate">{selectedNamespace.fullPath}</span>
                  ) : (
                    <span className="text-muted-foreground">Select group...</span>
                  )}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-[350px] p-0"
                align="start"
                side="bottom"
                avoidCollisions={false}
              >
                <Command>
                  <CommandInput
                    placeholder="Search groups..."
                    value={namespaceSearch}
                    onValueChange={setNamespaceSearch}
                  />
                  <CommandList ref={namespaceListRef} className="max-h-[300px]">
                    <CommandEmpty>No groups found.</CommandEmpty>
                    <CommandGroup>
                      {namespaces.map((ns) => (
                        <CommandItem
                          key={namespaceKey(ns)}
                          value={ns.fullPath}
                          onSelect={() => handleNamespaceSelect(ns)}
                          className="flex items-center gap-2"
                        >
                          <Check
                            className={cn(
                              "h-4 w-4 shrink-0",
                              nsKey === namespaceKey(ns) ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <span className="text-foreground truncate">{ns.fullPath}</span>
                          {ns.kind === "user" && (
                            <span className="text-[10px] font-medium bg-info-muted text-info px-1.5 py-0.5 rounded-full leading-none ml-auto shrink-0">
                              personal
                            </span>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {namespacesError && <p className="mt-1 text-xs text-destructive">{namespacesError}</p>}
          </div>

          {/* Project selector */}
          <div>
            <label className="text-sm font-medium text-foreground mb-1 block">Project</label>
            <Popover
              open={projectOpen}
              onOpenChange={(open) => {
                setProjectOpen(open)
                if (!open) setProjectSearch("")
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={projectOpen}
                  className="w-full justify-between font-normal bg-card border-input hover:bg-accent"
                  disabled={disabled || !selectedNamespace || loadingProjects}
                >
                  {loadingProjects ? (
                    <span className="text-muted-foreground">Loading projects...</span>
                  ) : selectedProject ? (
                    <span className="flex items-center gap-2 truncate">
                      {selectedProjectInfo && selectedProjectInfo.visibility !== "public" && (
                        <Lock className="size-3 text-muted-foreground" />
                      )}
                      <span className="text-foreground">
                        {pathInNamespace(selectedProject, selectedNamespace)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {selectedNamespace ? "Select project..." : "Select a group first"}
                    </span>
                  )}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-[350px] p-0"
                align="start"
                side="bottom"
                avoidCollisions={false}
              >
                <Command shouldFilter={!searchOnServer}>
                  <CommandInput
                    placeholder="Search projects..."
                    value={projectSearch}
                    onValueChange={setProjectSearch}
                  />
                  <CommandList ref={projectListRef} className="max-h-[300px]">
                    {searching ? (
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        Searching...
                      </div>
                    ) : (
                      <CommandEmpty>No projects found.</CommandEmpty>
                    )}
                    {base?.truncated && !searchOnServer && (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        Showing the {base.items.length} most recently active projects. Type to
                        search all of them.
                      </div>
                    )}
                    {!searching && (
                      <CommandGroup>
                        {listed.map((project) => (
                          <CommandItem
                            key={project.id}
                            value={project.pathWithNamespace}
                            keywords={[project.name]}
                            onSelect={() => handleProjectSelect(project)}
                            className="flex items-center gap-2"
                          >
                            <Check
                              className={cn(
                                "h-4 w-4 shrink-0",
                                project.pathWithNamespace.toLowerCase() ===
                                  selectedProject.toLowerCase()
                                  ? "opacity-100"
                                  : "opacity-0",
                              )}
                            />
                            {project.visibility !== "public" && (
                              <Lock className="size-3 text-muted-foreground shrink-0" />
                            )}
                            <span className="text-foreground truncate">
                              {pathInNamespace(project.pathWithNamespace, selectedNamespace)}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {projectsError && <p className="mt-1 text-xs text-destructive">{projectsError}</p>}
          </div>

          {/* Ref (branch/tag) selector — only shown after a project is selected */}
          {selectedProject && (
            <RefSelect
              refs={refs}
              selectedRef={selectedRef}
              defaultBranch={defaultBranch}
              loading={loadingRefs}
              error={currentRefs?.error ?? null}
              disabled={disabled}
              onSelect={handleRefSelect}
            />
          )}
        </div>
      )}
    </div>
  )
}
