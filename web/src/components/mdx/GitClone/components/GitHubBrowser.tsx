import { useState, useEffect, useRef, useMemo } from "react"
import { Check, ChevronsUpDown, ChevronDown, ChevronUp, Lock, GitBranch, Tag } from "lucide-react"
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { GitHubIcon } from "@/components/icons/GitHubIcon"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import type { GitHubOrg, GitHubRepo, GitHubRef } from "../types"
import { DEFAULT_GITHUB_HOST, githubWebBase } from "@/components/mdx/_shared/lib/githubHost"

interface GitHubBrowserProps {
  /** GitHub host the repos live on (github.com, *.ghe.com, or GHES); builds clone URLs. */
  host?: string
  /** Callback when a repo is selected (sets the URL field) */
  onRepoSelected: (url: string) => void
  /** Callback when a ref (branch/tag) is selected */
  onRefSelected: (ref: string) => void
  /** Function to fetch orgs */
  fetchOrgs: () => Promise<GitHubOrg[]>
  /** Function to fetch repos for an owner */
  fetchRepos: (owner: string) => Promise<GitHubRepo[]>
  /** Function to fetch refs (branches + tags) for a repo */
  fetchRefs: (owner: string, repo: string) => Promise<GitHubRef[]>
  /** Whether the browser is disabled */
  disabled?: boolean
  /** Initial org to pre-select (parsed from URL) */
  initialOrg?: string
  /** Initial repo to pre-select (parsed from URL) */
  initialRepo?: string
  /** Whether to start expanded */
  defaultOpen?: boolean
}

/** A list response tagged with the selection it was fetched for. */
interface FetchResult<T> {
  key: string
  items: T[]
  error: string | null
}

const NO_REPOS: GitHubRepo[] = []
const NO_REFS: GitHubRef[] = []

export function GitHubBrowser({
  host = DEFAULT_GITHUB_HOST,
  onRepoSelected,
  onRefSelected,
  fetchOrgs,
  fetchRepos,
  fetchRefs,
  disabled = false,
  initialOrg,
  initialRepo,
  defaultOpen = false,
}: GitHubBrowserProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const [orgs, setOrgs] = useState<GitHubOrg[]>([])
  const [selectedOrg, setSelectedOrg] = useState(initialOrg || "")
  const [selectedRepo, setSelectedRepo] = useState(initialRepo || "")
  // Default branch of the repo the user picked in the browser, selected once
  // that repo's refs load. The repo seeded from the block's URL has none, so
  // loading its refs leaves the block's prefilled ref alone.
  const [pickedDefaultBranch, setPickedDefaultBranch] = useState("")
  const [selectedRef, setSelectedRef] = useState("")
  const [orgOpen, setOrgOpen] = useState(false)
  const [repoOpen, setRepoOpen] = useState(false)
  const [refOpen, setRefOpen] = useState(false)
  const [loadingOrgs, setLoadingOrgs] = useState(false)
  const [orgsError, setOrgsError] = useState<string | null>(null)
  // Latest repos and refs responses, each tagged with the selection it
  // answers. Until a response for the current selection arrives, the list
  // reads as loading, so switching org or repo needs no reset.
  const [reposResult, setReposResult] = useState<FetchResult<GitHubRepo> | null>(null)
  const [refsResult, setRefsResult] = useState<FetchResult<GitHubRef> | null>(null)
  const [orgSearch, setOrgSearch] = useState("")
  const [repoSearch, setRepoSearch] = useState("")
  const [refSearch, setRefSearch] = useState("")
  const orgListRef = useRef<HTMLDivElement>(null)
  const repoListRef = useRef<HTMLDivElement>(null)
  const refListRef = useRef<HTMLDivElement>(null)
  const hasLoadedOrgs = useRef(false)

  const refsKey = selectedOrg && selectedRepo ? `${selectedOrg}/${selectedRepo}` : ""
  const currentRepos = selectedOrg && reposResult?.key === selectedOrg ? reposResult : null
  const currentRefs = refsKey && refsResult?.key === refsKey ? refsResult : null
  const repos = currentRepos?.items ?? NO_REPOS
  const refs = currentRefs?.items ?? NO_REFS
  const reposError = currentRepos?.error ?? null
  const refsError = currentRefs?.error ?? null
  const loadingRepos = !!selectedOrg && !currentRepos
  const loadingRefs = !!refsKey && !currentRefs

  // Split refs into branches and tags for grouped display
  const branchRefs = useMemo(() => refs.filter(r => r.type === 'branch'), [refs])
  const tagRefs = useMemo(() => refs.filter(r => r.type === 'tag'), [refs])
  const defaultBranch = useMemo(() => repos.find(r => r.name === selectedRepo)?.defaultBranch, [repos, selectedRepo])

  // Load orgs when browser opens
  useEffect(() => {
    if (isOpen && !hasLoadedOrgs.current) {
      setLoadingOrgs(true)
      setOrgsError(null)
      fetchOrgs().then(result => {
        hasLoadedOrgs.current = true
        setOrgs(result)
      }).catch(err => {
        setOrgsError(err instanceof Error ? cleanIpcErrorMessage(err.message) : "Failed to load organizations")
      }).finally(() => {
        setLoadingOrgs(false)
      })
    }
  }, [isOpen, fetchOrgs])

  // Load repos when org changes. `current` turns false once the selection
  // moves on, so a slow response for an earlier org is dropped instead of
  // overwriting a newer response.
  useEffect(() => {
    if (!selectedOrg) return
    let current = true
    fetchRepos(selectedOrg).then(result => {
      if (current) setReposResult({ key: selectedOrg, items: result, error: null })
    }).catch(err => {
      if (current) setReposResult({ key: selectedOrg, items: [], error: err instanceof Error ? cleanIpcErrorMessage(err.message) : "Failed to load repositories" })
    })
    return () => { current = false }
  }, [selectedOrg, fetchRepos])

  // Load refs when repo changes, guarded like the repos load. Depends on the
  // org too: switching org clears the repo, and this cleanup is what drops
  // the old repo's in-flight refs.
  useEffect(() => {
    if (!selectedOrg || !selectedRepo) return
    const key = `${selectedOrg}/${selectedRepo}`
    let current = true
    fetchRefs(selectedOrg, selectedRepo).then(result => {
      if (!current) return
      setRefsResult({ key, items: result, error: null })

      // Auto-select the default branch, if the repo has it (an empty repo
      // has no branches yet)
      if (pickedDefaultBranch && result.some(r => r.type === 'branch' && r.name === pickedDefaultBranch)) {
        setSelectedRef(pickedDefaultBranch)
        onRefSelected(pickedDefaultBranch)
      }
    }).catch(err => {
      if (current) setRefsResult({ key, items: [], error: err instanceof Error ? cleanIpcErrorMessage(err.message) : "Failed to load refs" })
    })
    return () => { current = false }
  }, [selectedOrg, selectedRepo, pickedDefaultBranch, fetchRefs, onRefSelected])

  // Scroll to top on search change
  useEffect(() => {
    if (orgOpen && orgListRef.current) {
      orgListRef.current.scrollTo({ top: 0 })
    }
  }, [orgOpen, orgSearch])

  useEffect(() => {
    if (repoOpen && repoListRef.current) {
      repoListRef.current.scrollTo({ top: 0 })
    }
  }, [repoOpen, repoSearch])

  useEffect(() => {
    if (refOpen && refListRef.current) {
      refListRef.current.scrollTo({ top: 0 })
    }
  }, [refOpen, refSearch])

  const handleOrgSelect = (org: string) => {
    setSelectedOrg(org)
    setSelectedRepo("")
    setPickedDefaultBranch("")
    setSelectedRef("")
    setOrgOpen(false)
    setOrgSearch("")
  }

  const handleRepoSelect = (repo: GitHubRepo) => {
    setRepoOpen(false)
    setRepoSearch("")
    // Auto-fill the URL
    onRepoSelected(`${githubWebBase(host)}/${selectedOrg}/${repo.name}`)
    // Re-picking the current repo keeps its ref
    if (repo.name === selectedRepo) return
    setSelectedRepo(repo.name)
    setPickedDefaultBranch(repo.defaultBranch)
    setSelectedRef("")
    // Drop the previous repo's ref: it names a branch or tag of that repo,
    // not this one
    onRefSelected("")
  }

  const handleRefSelect = (ref: string) => {
    setSelectedRef(ref)
    setRefOpen(false)
    setRefSearch("")
    onRefSelected(ref)
  }

  // Determine the icon for the currently selected ref
  const selectedRefObj = useMemo(() => refs.find(r => r.name === selectedRef), [refs, selectedRef])
  const isDefaultBranch = (ref: GitHubRef | undefined) => ref?.type === 'branch' && ref.name === defaultBranch

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className={cn(
          "flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        <GitHubIcon className="size-4" />
        <span>Browse GitHub repositories</span>
        {isOpen ? (
          <ChevronUp className="size-3.5" />
        ) : (
          <ChevronDown className="size-3.5" />
        )}
      </button>

      {isOpen && (
        <div className="mt-2 p-3 bg-muted border border-border rounded-md space-y-3">
          {/* Organization selector */}
          <div>
            <label className="text-sm font-medium text-foreground mb-1 block">
              Organization
            </label>
            <Popover open={orgOpen} onOpenChange={(open) => {
              setOrgOpen(open)
              if (!open) setOrgSearch("")
            }}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={orgOpen}
                  className="w-full justify-between font-normal bg-card border-input hover:bg-accent"
                  disabled={disabled || loadingOrgs}
                >
                  {loadingOrgs ? (
                    <span className="text-muted-foreground">Loading organizations...</span>
                  ) : selectedOrg ? (
                    <span className="text-foreground truncate">{selectedOrg}</span>
                  ) : (
                    <span className="text-muted-foreground">Select organization...</span>
                  )}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[350px] p-0" align="start" side="bottom" avoidCollisions={false}>
                <Command>
                  <CommandInput
                    placeholder="Search organizations..."
                    value={orgSearch}
                    onValueChange={setOrgSearch}
                  />
                  <CommandList ref={orgListRef} className="max-h-[300px]">
                    <CommandEmpty>No organizations found.</CommandEmpty>
                    <CommandGroup>
                      {orgs.map((org) => (
                        <CommandItem
                          key={org.id}
                          value={org.login}
                          onSelect={() => handleOrgSelect(org.login)}
                          className="flex items-center gap-2"
                        >
                          <Check
                            className={cn(
                              "h-4 w-4 shrink-0",
                              selectedOrg === org.login ? "opacity-100" : "opacity-0"
                            )}
                          />
                          <span className="text-foreground">{org.login}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {orgsError && (
              <p className="mt-1 text-xs text-destructive">{orgsError}</p>
            )}
          </div>

          {/* Repository selector */}
          <div>
            <label className="text-sm font-medium text-foreground mb-1 block">
              Repository
            </label>
            <Popover open={repoOpen} onOpenChange={(open) => {
              setRepoOpen(open)
              if (!open) setRepoSearch("")
            }}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={repoOpen}
                  className="w-full justify-between font-normal bg-card border-input hover:bg-accent"
                  disabled={disabled || !selectedOrg || loadingRepos}
                >
                  {loadingRepos ? (
                    <span className="text-muted-foreground">Loading repositories...</span>
                  ) : selectedRepo ? (
                    <span className="flex items-center gap-2 truncate">
                      {repos.find(r => r.name === selectedRepo)?.private && (
                        <Lock className="size-3 text-muted-foreground" />
                      )}
                      <span className="text-foreground">{selectedRepo}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {selectedOrg ? "Select repository..." : "Select an organization first"}
                    </span>
                  )}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[350px] p-0" align="start" side="bottom" avoidCollisions={false}>
                <Command>
                  <CommandInput
                    placeholder="Search repositories..."
                    value={repoSearch}
                    onValueChange={setRepoSearch}
                  />
                  <CommandList ref={repoListRef} className="max-h-[300px]">
                    <CommandEmpty>No repositories found.</CommandEmpty>
                    <CommandGroup>
                      {repos.map((repo) => (
                        <CommandItem
                          key={repo.id}
                          value={repo.name}
                          onSelect={() => handleRepoSelect(repo)}
                          className="flex items-center gap-2"
                        >
                          <Check
                            className={cn(
                              "h-4 w-4 shrink-0",
                              selectedRepo === repo.name ? "opacity-100" : "opacity-0"
                            )}
                          />
                          {repo.private && (
                            <Lock className="size-3 text-muted-foreground shrink-0" />
                          )}
                          <span className="text-foreground truncate">{repo.name}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {reposError && (
              <p className="mt-1 text-xs text-destructive">{reposError}</p>
            )}
          </div>

          {/* Ref (branch/tag) selector — only shown after a repo is selected */}
          {selectedRepo && (
            <div>
              <label className="text-sm font-medium text-foreground mb-1 block">
                Ref
              </label>
              <Popover open={refOpen} onOpenChange={(open) => {
                setRefOpen(open)
                if (!open) setRefSearch("")
              }}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={refOpen}
                      className="w-full justify-between font-normal bg-card border-input hover:bg-accent"
                    disabled={disabled || loadingRefs}
                  >
                    {loadingRefs ? (
                      <span className="text-muted-foreground">Loading refs...</span>
                    ) : selectedRef ? (
                      <span className="flex items-center gap-2 truncate">
                        {selectedRefObj?.type === 'tag' ? (
                          <Tag className="size-3 text-muted-foreground" />
                        ) : (
                          <GitBranch className="size-3 text-muted-foreground" />
                        )}
                        <span className="text-foreground">{selectedRef}</span>
                        {isDefaultBranch(selectedRefObj) && (
                          <span className="text-[10px] font-medium bg-info-muted text-info px-1.5 py-0.5 rounded-full leading-none">default</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Select ref...</span>
                    )}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[350px] p-0" align="start" side="bottom" avoidCollisions={false}>
                  <Command>
                    <CommandInput
                      placeholder="Search branches and tags..."
                      value={refSearch}
                      onValueChange={setRefSearch}
                    />
                    <CommandList ref={refListRef} className="max-h-[300px]">
                      <CommandEmpty>No branches or tags found.</CommandEmpty>

                      {/* Branches group */}
                      {branchRefs.length > 0 && (
                        <CommandGroup heading="Branches">
                          {branchRefs.map((ref) => (
                            <CommandItem
                              key={`branch-${ref.name}`}
                              value={ref.name}
                              onSelect={() => handleRefSelect(ref.name)}
                              className="flex items-center gap-2"
                            >
                              <Check
                                className={cn(
                                  "h-4 w-4 shrink-0",
                                  selectedRef === ref.name ? "opacity-100" : "opacity-0"
                                )}
                              />
                              <GitBranch className="size-3 text-muted-foreground shrink-0" />
                              <span className="text-foreground truncate">{ref.name}</span>
                              {isDefaultBranch(ref) && (
                                <span className="text-[10px] font-medium bg-info-muted text-info px-1.5 py-0.5 rounded-full leading-none ml-auto shrink-0">default</span>
                              )}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}

                      {/* Tags group */}
                      {tagRefs.length > 0 && (
                        <CommandGroup heading="Tags">
                          {tagRefs.map((ref) => (
                            <CommandItem
                              key={`tag-${ref.name}`}
                              value={ref.name}
                              onSelect={() => handleRefSelect(ref.name)}
                              className="flex items-center gap-2"
                            >
                              <Check
                                className={cn(
                                  "h-4 w-4 shrink-0",
                                  selectedRef === ref.name ? "opacity-100" : "opacity-0"
                                )}
                              />
                              <Tag className="size-3 text-muted-foreground shrink-0" />
                              <span className="text-foreground truncate">{ref.name}</span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {refsError && (
                <p className="mt-1 text-xs text-destructive">{refsError}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
