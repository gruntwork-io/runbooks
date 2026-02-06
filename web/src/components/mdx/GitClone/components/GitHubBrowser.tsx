import { useState, useEffect, useRef, useCallback } from "react"
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import type { GitHubOrg, GitHubRepo } from "../types"

interface GitHubBrowserProps {
  /** Callback when a repo is selected (sets the URL field) */
  onRepoSelected: (url: string) => void
  /** Function to fetch orgs */
  fetchOrgs: () => Promise<GitHubOrg[]>
  /** Function to fetch repos for an owner */
  fetchRepos: (owner: string, query?: string) => Promise<GitHubRepo[]>
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
  fetchOrgs,
  fetchRepos,
  disabled = false,
  initialOrg,
  initialRepo,
  defaultOpen = false,
}: GitHubBrowserProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const [orgs, setOrgs] = useState<GitHubOrg[]>([])
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [selectedOrg, setSelectedOrg] = useState(initialOrg || "")
  const [selectedRepo, setSelectedRepo] = useState(initialRepo || "")
  const [orgOpen, setOrgOpen] = useState(false)
  const [repoOpen, setRepoOpen] = useState(false)
  const [loadingOrgs, setLoadingOrgs] = useState(false)
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [orgSearch, setOrgSearch] = useState("")
  const [repoSearch, setRepoSearch] = useState("")
  const orgListRef = useRef<HTMLDivElement>(null)
  const repoListRef = useRef<HTMLDivElement>(null)
  const hasLoadedOrgs = useRef(false)

  // Load orgs when browser opens
  useEffect(() => {
    if (isOpen && !hasLoadedOrgs.current) {
      hasLoadedOrgs.current = true
      setLoadingOrgs(true)
      fetchOrgs().then(result => {
        setOrgs(result)
        setLoadingOrgs(false)
      })
    }
  }, [isOpen, fetchOrgs])

  // Load repos when org changes
  const loadRepos = useCallback(async (org: string) => {
    if (!org) return
    setLoadingRepos(true)
    setRepos([])
    const result = await fetchRepos(org)
    setRepos(result)
    setLoadingRepos(false)
  }, [fetchRepos])

  useEffect(() => {
    if (selectedOrg) {
      loadRepos(selectedOrg)
    }
  }, [selectedOrg, loadRepos])

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

  const handleOrgSelect = (org: string) => {
    setSelectedOrg(org)
    setSelectedRepo("")
    setOrgOpen(false)
    setOrgSearch("")
  }

  const handleRepoSelect = (repo: string) => {
    setSelectedRepo(repo)
    setRepoOpen(false)
    setRepoSearch("")
    // Auto-fill the URL
    onRepoSelected(`https://github.com/${selectedOrg}/${repo}`)
  }

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
        <svg className="size-4" viewBox="0 0 16 16" fill="currentColor">
          <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
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
                      {orgs.find(o => o.login === selectedOrg)?.avatarUrl && (
                        <img
                          src={orgs.find(o => o.login === selectedOrg)?.avatarUrl}
                          alt=""
                          className="size-4 rounded-full"
                        />
                      )}
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
          </div>
        </div>
      )}
    </div>
  )
}
