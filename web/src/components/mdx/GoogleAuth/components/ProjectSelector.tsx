import { Loader2, Check } from "lucide-react"
import { SearchInput } from "./SearchInput"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { GoogleProjectInfo } from "../types"

interface ProjectSelectorProps {
  projects: GoogleProjectInfo[]
  selectedProject: GoogleProjectInfo | null
  loadingProjects: boolean
  searchValue: string
  setSearchValue: (value: string) => void
  /** hook: `handleProjectSelect` */
  onProjectSelect: (project: GoogleProjectInfo) => void
  /** hook: `handleManualAuth` — abandons the sub-flow and starts over. */
  onCancel: () => void
}

/**
 * Project picker — AwsAuth's SsoAccountSelector and SsoRoleSelector collapsed
 * into one step, because GCP has no account -> role two-step. Reached from any
 * tab whose credential resolves to more than one project (in practice: Google
 * Sign-In, which has no implicit project at all).
 */
export function ProjectSelector({
  projects,
  selectedProject,
  loadingProjects,
  searchValue,
  setSearchValue,
  onProjectSelect,
  onCancel,
}: ProjectSelectorProps) {
  const query = searchValue.toLowerCase()
  const filteredProjects = projects.filter((project) =>
    project.projectId.toLowerCase().includes(query)
    || project.displayName.toLowerCase().includes(query)
    || (project.projectNumber?.includes(searchValue) ?? false)
  )

  return (
    <div className="space-y-4">
      <div className="text-info font-semibold text-sm mb-2">
        ✓ Signed in to Google Cloud
      </div>
      <div className="bg-info-muted/50 rounded p-3 text-sm text-foreground">
        <p>Select a Google Cloud project to continue:</p>
      </div>

      <div className="space-y-2">
        {/* Search input */}
        <SearchInput
          value={searchValue}
          onChange={setSearchValue}
          placeholder="Search projects..."
          disabled={loadingProjects}
        />

        {/* Project list */}
        <div className="max-h-[300px] overflow-y-auto space-y-2 p-1">
          {filteredProjects.map((project) => {
            const isSelected = selectedProject?.projectId === project.projectId
            return (
              <button
                key={project.projectId}
                type="button"
                onClick={() => onProjectSelect(project)}
                disabled={loadingProjects}
                className={cn(
                  "w-full text-left px-4 py-3 rounded-md border transition-colors",
                  isSelected
                    ? "bg-info-muted border-info/40 ring-2 ring-info/40"
                    : "bg-info-muted/50 border-border hover:bg-info-muted hover:border-info/40 cursor-pointer"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Check
                      className={cn(
                        "h-4 w-4 shrink-0",
                        isSelected ? "opacity-100 text-info" : "opacity-0"
                      )}
                    />
                    <div className="min-w-0">
                      <div className="font-medium text-foreground truncate">{project.displayName}</div>
                      <div className="text-sm text-muted-foreground truncate">
                        <span className="font-mono">{project.projectId}</span>
                        {project.projectNumber && ` • ${project.projectNumber}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {project.state && project.state !== 'ACTIVE' && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-warning-muted text-warning-foreground">
                        {project.state}
                      </span>
                    )}
                    {loadingProjects && isSelected && (
                      <Loader2 className="size-4 animate-spin text-info" />
                    )}
                  </div>
                </div>
              </button>
            )
          })}
          {filteredProjects.length === 0 && searchValue && (
            <div className="text-muted-foreground text-sm py-4 text-center">
              No projects match "{searchValue}"
            </div>
          )}
          {projects.length === 0 && !loadingProjects && (
            <div className="text-muted-foreground text-sm py-4 text-center">
              No projects are visible to these credentials.
            </div>
          )}
        </div>
      </div>

      <Button
        onClick={onCancel}
        variant="outline"
        className="border-input text-foreground hover:bg-accent"
      >
        Cancel
      </Button>
    </div>
  )
}
