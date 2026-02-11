import { useState, useEffect, useRef, useCallback, useMemo } from "react"
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
import type { GitHubOrg, GitHubRepo, GitHubRef } from "../types"

interface GitHubBrowserProps {
  /** Callback when a repo is selected (sets the URL field) */
  onRepoSelected: (url: string) => void
  /** Callback when a ref (branch/tag) is selected */
  onRefSelected: (ref: string) => void
  /** Function to fetch orgs */
  fetchOrgs: () => Promise<GitHubOrg[]>
  /** Function to fetch repos for an owner */
  fetchRepos: (owner: string, query?: string) => Promise<GitHubRepo[]>
  /** Function to fetch refs (branches + tags) for a repo */
  fetchRefs: (owner: string, repo: string, query?: string) => Promise<{ refs: GitHubRef[]; totalCount: number; hasMore: boolean }>
  /** Whether the browser is disabled */
  disabled?: boolean
  /** Initial org to pre-select (parsed from URL) */
  initialOrg?: string
  /** Initial repo to pre-select (parsed from URL) */
  initialRepo?: string
  /** Whether to start expanded */
  defaultOpen?: boolean
}

export function GitHubBrowser({
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
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [refs, setRefs] = useState<GitHubRef[]>([])
  const [refTotalCount, setRefTotalCount] = useState(0)
  const [refHasMore, setRefHasMore] = useState(false)
  const [selectedOrg, setSelectedOrg] = useState(initialOrg || "")
  const [selectedRepo, setSelectedRepo] = useState(initialRepo || "")
  const [selectedRef, setSelectedRef] = useState("")
  const [orgOpen, setOrgOpen] = useState(false)
  const [repoOpen, setRepoOpen] = useState(false)
  const [refOpen, setRefOpen] = useState(false)
  const [loadingOrgs, setLoadingOrgs] = useState(false)
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [loadingRefs, setLoadingRefs] = useState(false)
  const [orgsError, setOrgsError] = useState<string | null>(null)
  const [reposError, setReposError] = useState<string | null>(null)
  const [refsError, setRefsError] = useState<string | null>(null)
  const [orgSearch, setOrgSearch] = useState("")
  const [repoSearch, setRepoSearch] = useState("")
  const [refSearch, setRefSearch] = useState("")
  const orgListRef = useRef<HTMLDivElement>(null)
  const repoListRef = useRef<HTMLDivElement>(null)
  const refListRef = useRef<HTMLDivElement>(null)
  const hasLoadedOrgs = useRef(false)

  // Split refs into branches and tags for grouped display
  const branchRefs = useMemo(() => refs.filter(r => r.type === 'branch'), [refs])
  const tagRefs = useMemo(() => refs.filter(r => r.type === 'tag'), [refs])

  // Load orgs when browser opens
  useEffect(() => {
    if (isOpen && !hasLoadedOrgs.current) {
      setLoadingOrgs(true)
      setOrgsError(null)
      fetchOrgs().then(result => {
        hasLoadedOrgs.current = true
        setOrgs(result)
      }).catch(err => {
        setOrgsError(err instanceof Error ? err.message : "Failed to load organizations")
      }).finally(() => {
        setLoadingOrgs(false)
      })
    }
  }, [isOpen, fetchOrgs])

  // Load repos when org changes
  const loadRepos = useCallback(async (org: string) => {
    if (!org) return
    setLoadingRepos(true)
    setRepos([])
    setReposError(null)
    try {
      const result = await fetchRepos(org)
      setRepos(result)
    } catch (err) {
      setReposError(err instanceof Error ? err.message : "Failed to load repositories")
    } finally {
      setLoadingRepos(false)
    }
  }, [fetchRepos])

  useEffect(() => {
    if (selectedOrg) {
      loadRepos(selectedOrg)
    }
  }, [selectedOrg, loadRepos])

  // Load refs when repo changes
  const loadRefs = useCallback(async (org: string, repo: string) => {
    if (!org || !repo) return
    setLoadingRefs(true)
    setRefs([])
    setRefTotalCount(0)
    setRefHasMore(false)
    setRefsError(null)
    try {
      const result = await fetchRefs(org, repo)
      setRefs(result.refs)
      setRefTotalCount(result.totalCount)
      setRefHasMore(result.hasMore)

      // Auto-select the default branch
      const defaultBranch = result.refs.find(r => r.isDefaultBranch)
      if (defaultBranch) {
        setSelectedRef(defaultBranch.name)
        onRefSelected(defaultBranch.name)
      }
    } catch (err) {
      setRefsError(err instanceof Error ? err.message : "Failed to load refs")
    } finally {
      setLoadingRefs(false)
    }
  }, [fetchRefs, onRefSelected])

  useEffect(() => {
    if (selectedOrg && selectedRepo) {
      loadRefs(selectedOrg, selectedRepo)
    }
  }, [selectedOrg, selectedRepo, loadRefs])

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
    setSelectedRef("")
    setRefs([])
    setOrgOpen(false)
    setOrgSearch("")
  }

  const handleRepoSelect = (repo: string) => {
    setSelectedRepo(repo)
    setSelectedRef("")
    setRepoOpen(false)
    setRepoSearch("")
    // Auto-fill the URL
    onRepoSelected(`https://github.com/${selectedOrg}/${repo}`)
  }

  const handleRefSelect = (ref: string) => {
    setSelectedRef(ref)
    setRefOpen(false)
    setRefSearch("")
    onRefSelected(ref)
  }

  // Determine the icon for the currently selected ref
  const selectedRefObj = useMemo(() => refs.find(r => r.name === selectedRef), [refs, selectedRef])

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className={cn(
          "flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 transition-colors cursor-pointer",
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
        <div className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded-md space-y-3">
          {/* Organization selector */}
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">
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
                  className="w-full justify-between font-normal bg-white border-gray-300 hover:bg-gray-50"
                  disabled={disabled || loadingOrgs}
                >
                  {loadingOrgs ? (
                    <span className="text-gray-400">Loading organizations...</span>
                  ) : selectedOrg ? (
                    <span className="flex items-center gap-2 truncate">
                      {(() => {
                        const avatarUrl = orgs.find(o => o.login === selectedOrg)?.avatarUrl
                        return avatarUrl ? <img src={avatarUrl} alt="" className="size-4 rounded-full" /> : null
                      })()}
                      <span className="text-gray-700">{selectedOrg}</span>
                    </span>
                  ) : (
                    <span className="text-gray-400">Select organization...</span>
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
                          key={org.login}
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
                          {org.avatarUrl && (
                            <img src={org.avatarUrl} alt="" className="size-4 rounded-full" />
                          )}
                          <span className="text-gray-700">{org.login}</span>
                          <span className="text-xs text-gray-400 ml-auto">
                            {org.type === 'User' ? 'Personal' : 'Org'}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {orgsError && (
              <p className="mt-1 text-xs text-red-600">{orgsError}</p>
            )}
          </div>

          {/* Repository selector */}
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">
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
                  className="w-full justify-between font-normal bg-white border-gray-300 hover:bg-gray-50"
                  disabled={disabled || !selectedOrg || loadingRepos}
                >
                  {loadingRepos ? (
                    <span className="text-gray-400">Loading repositories...</span>
                  ) : selectedRepo ? (
                    <span className="flex items-center gap-2 truncate">
                      {repos.find(r => r.name === selectedRepo)?.private && (
                        <Lock className="size-3 text-gray-400" />
                      )}
                      <span className="text-gray-700">{selectedRepo}</span>
                    </span>
                  ) : (
                    <span className="text-gray-400">
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
                          key={repo.name}
                          value={`${repo.name} ${repo.description || ''}`}
                          onSelect={() => handleRepoSelect(repo.name)}
                          className="flex items-center gap-2"
                        >
                          <Check
                            className={cn(
                              "h-4 w-4 shrink-0",
                              selectedRepo === repo.name ? "opacity-100" : "opacity-0"
                            )}
                          />
                          {repo.private && (
                            <Lock className="size-3 text-gray-400 shrink-0" />
                          )}
                          <div className="flex flex-col min-w-0">
                            <span className="text-gray-700 truncate">{repo.name}</span>
                            {repo.description && (
                              <span className="text-xs text-gray-400 truncate">{repo.description}</span>
                            )}
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {reposError && (
              <p className="mt-1 text-xs text-red-600">{reposError}</p>
            )}
          </div>

          {/* Ref (branch/tag) selector — only shown after a repo is selected */}
          {selectedRepo && (
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">
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
                    className="w-full justify-between font-normal bg-white border-gray-300 hover:bg-gray-50"
                    disabled={disabled || loadingRefs}
                  >
                    {loadingRefs ? (
                      <span className="text-gray-400">Loading refs...</span>
                    ) : selectedRef ? (
                      <span className="flex items-center gap-2 truncate">
                        {selectedRefObj?.type === 'tag' ? (
                          <Tag className="size-3 text-gray-400" />
                        ) : (
                          <GitBranch className="size-3 text-gray-400" />
                        )}
                        <span className="text-gray-700">{selectedRef}</span>
                        {selectedRefObj?.isDefaultBranch && (
                          <span className="text-[10px] font-medium bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full leading-none">default</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-gray-400">Select ref...</span>
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
                              <GitBranch className="size-3 text-gray-400 shrink-0" />
                              <span className="text-gray-700 truncate">{ref.name}</span>
                              {ref.isDefaultBranch && (
                                <span className="text-[10px] font-medium bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full leading-none ml-auto shrink-0">default</span>
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
                              <Tag className="size-3 text-gray-400 shrink-0" />
                              <span className="text-gray-700 truncate">{ref.name}</span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}

                      {refHasMore && (
                        <div className="px-3 py-2 text-xs text-gray-500 border-t border-gray-100">
                          Showing {refs.length} of {refTotalCount} refs — type to filter
                        </div>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {refsError && (
                <p className="mt-1 text-xs text-red-600">{refsError}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
