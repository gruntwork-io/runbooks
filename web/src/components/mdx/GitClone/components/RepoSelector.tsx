import { Search, Loader2, Lock, Globe, RefreshCw } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import type { GitHubRepo } from "../types"

interface RepoSelectorProps {
  repos: GitHubRepo[]
  loading: boolean
  selectedRepo: string
  searchValue: string
  setSearchValue: (value: string) => void
  onRepoSelect: (repo: string) => void
  onRefresh: () => void
  disabled?: boolean
}

export function RepoSelector({
  repos,
  loading,
  selectedRepo,
  searchValue,
  setSearchValue,
  onRepoSelect,
  onRefresh,
  disabled,
}: RepoSelectorProps) {
  const filteredRepos = (repos || []).filter(repo =>
    repo.fullName?.toLowerCase().includes(searchValue.toLowerCase()) ||
    (repo.description?.toLowerCase().includes(searchValue.toLowerCase()))
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Repository</Label>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={loading || disabled}
          className="h-6 px-2"
        >
          <RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-gray-400" />
        <Input
          placeholder="Search repositories..."
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          className="pl-9"
          disabled={loading || disabled}
        />
      </div>

      <div className="max-h-48 overflow-y-auto border rounded-md">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-gray-500">
            <Loader2 className="size-4 mr-2 animate-spin" />
            Loading repositories...
          </div>
        ) : filteredRepos.length === 0 ? (
          <div className="py-8 text-center text-gray-500 text-sm">
            {searchValue ? 'No matching repositories' : 'No repositories found'}
          </div>
        ) : (
          <ul className="divide-y">
            {filteredRepos.map((repo) => (
              <li key={repo.id}>
                <button
                  type="button"
                  onClick={() => onRepoSelect(repo.fullName)}
                  disabled={disabled}
                  className={`w-full px-3 py-2 text-left hover:bg-gray-50 transition-colors ${
                    selectedRepo === repo.fullName ? 'bg-blue-50 border-l-2 border-blue-500' : ''
                  } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    {repo.private ? (
                      <Lock className="size-3 text-gray-400" />
                    ) : (
                      <Globe className="size-3 text-gray-400" />
                    )}
                    <span className="font-medium text-sm">{repo.fullName}</span>
                  </div>
                  {repo.description && (
                    <p className="text-xs text-gray-500 mt-0.5 truncate">{repo.description}</p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
