import { Search, Loader2, GitBranch, Shield } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { GitHubBranch } from "../types"

interface BranchSelectorProps {
  branches: GitHubBranch[]
  loading: boolean
  selectedBranch: string
  searchValue: string
  setSearchValue: (value: string) => void
  onBranchSelect: (branch: string) => void
  disabled?: boolean
}

export function BranchSelector({
  branches,
  loading,
  selectedBranch,
  searchValue,
  setSearchValue,
  onBranchSelect,
  disabled,
}: BranchSelectorProps) {
  const filteredBranches = (branches || []).filter(branch =>
    branch.name?.toLowerCase().includes(searchValue.toLowerCase())
  )

  return (
    <div className="space-y-2">
      <Label>Branch</Label>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-gray-400" />
        <Input
          placeholder="Search branches..."
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          className="pl-9"
          disabled={loading || disabled}
        />
      </div>

      <div className="max-h-36 overflow-y-auto border rounded-md">
        {loading ? (
          <div className="flex items-center justify-center py-6 text-gray-500">
            <Loader2 className="size-4 mr-2 animate-spin" />
            Loading branches...
          </div>
        ) : filteredBranches.length === 0 ? (
          <div className="py-6 text-center text-gray-500 text-sm">
            {searchValue ? 'No matching branches' : 'Select a repository first'}
          </div>
        ) : (
          <ul className="divide-y">
            {filteredBranches.map((branch) => (
              <li key={branch.name}>
                <button
                  type="button"
                  onClick={() => onBranchSelect(branch.name)}
                  disabled={disabled}
                  className={`w-full px-3 py-2 text-left hover:bg-gray-50 transition-colors flex items-center gap-2 ${
                    selectedBranch === branch.name ? 'bg-blue-50 border-l-2 border-blue-500' : ''
                  } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <GitBranch className="size-3 text-gray-400" />
                  <span className="font-medium text-sm">{branch.name}</span>
                  {branch.protected && (
                    <Shield className="size-3 text-amber-500 ml-auto" title="Protected branch" />
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
