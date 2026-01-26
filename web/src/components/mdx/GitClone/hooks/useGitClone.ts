import { useState, useCallback, useEffect } from "react"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useSession } from "@/contexts/useSession"
import { useGitWorkspace } from "@/contexts/useGitWorkspace"
import { normalizeBlockId } from "@/lib/utils"
import type {
  GitCloneStatus,
  GitHubRepo,
  GitHubBranch,
  CloneResult,
} from "../types"

interface UseGitCloneOptions {
  id: string
  githubAuthId?: string
  repo?: string
  branch?: string
  allowRepoSelection?: boolean
  allowBranchSelection?: boolean
  workspacePath?: string
}

export function useGitClone({
  id,
  githubAuthId,
  repo: defaultRepo,
  branch: defaultBranch,
  allowRepoSelection = !defaultRepo,
  allowBranchSelection = true,
  workspacePath,
}: UseGitCloneOptions) {
  const { registerOutputs, blockOutputs } = useRunbookContext()
  const { getAuthHeader } = useSession()
  const { registerWorkspace } = useGitWorkspace()

  // Core state
  const [status, setStatus] = useState<GitCloneStatus>('pending')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [cloneResult, setCloneResult] = useState<CloneResult | null>(null)

  // Repository selection state
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [selectedRepo, setSelectedRepo] = useState<string>(defaultRepo || '')
  const [repoSearch, setRepoSearch] = useState('')

  // Branch selection state
  const [branches, setBranches] = useState<GitHubBranch[]>([])
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [selectedBranch, setSelectedBranch] = useState<string>(defaultBranch || '')
  const [branchSearch, setBranchSearch] = useState('')

  // Cloning progress
  const [cloneProgress, setCloneProgress] = useState<string>('')

  // Check if GitHub auth is complete
  const isGitHubAuthenticated = useCallback(() => {
    if (!githubAuthId) return true // No auth required
    const normalizedId = normalizeBlockId(githubAuthId)
    const outputs = blockOutputs[normalizedId]?.values
    return outputs?.GITHUB_AUTHENTICATED === 'true'
  }, [githubAuthId, blockOutputs])

  // Register clone outputs
  const registerCloneOutputs = useCallback((result: CloneResult) => {
    const outputs: Record<string, string> = {
      REPO: result.repo,
      BRANCH: result.branch,
      WORKSPACE_PATH: result.workspacePath,
      COMMIT_SHA: result.commitSha,
    }
    registerOutputs(id, outputs)
  }, [id, registerOutputs])

  // Load user's repositories
  const loadRepos = useCallback(async () => {
    setLoadingRepos(true)
    setErrorMessage(null)

    try {
      const response = await fetch('/api/github/repos', {
        method: 'GET',
        headers: {
          ...getAuthHeader(),
        },
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to load repositories')
      }

      const data = await response.json()
      setRepos(data.repos || [])
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load repositories')
      setRepos([])
    } finally {
      setLoadingRepos(false)
    }
  }, [getAuthHeader])

  // Load branches for selected repo
  const loadBranches = useCallback(async (repoFullName: string) => {
    if (!repoFullName) return

    setLoadingBranches(true)
    setBranches([])
    setErrorMessage(null)

    try {
      const [owner, repo] = repoFullName.split('/')
      const response = await fetch(`/api/github/repos/${owner}/${repo}/branches`, {
        method: 'GET',
        headers: {
          ...getAuthHeader(),
        },
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to load branches')
      }

      const data = await response.json()
      setBranches(data.branches || [])

      // Auto-select default branch if not already set
      if (!selectedBranch && data.defaultBranch) {
        setSelectedBranch(data.defaultBranch)
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load branches')
      setBranches([])
    } finally {
      setLoadingBranches(false)
    }
  }, [getAuthHeader, selectedBranch])

  // Load repos when GitHub auth is complete
  useEffect(() => {
    if (allowRepoSelection && isGitHubAuthenticated() && repos.length === 0 && !loadingRepos) {
      loadRepos()
    }
  }, [allowRepoSelection, isGitHubAuthenticated, repos.length, loadingRepos, loadRepos])

  // Load branches when repo is selected
  useEffect(() => {
    if (selectedRepo && allowBranchSelection) {
      loadBranches(selectedRepo)
    }
  }, [selectedRepo, allowBranchSelection, loadBranches])

  // Clone the repository
  const handleClone = useCallback(async () => {
    if (!selectedRepo) {
      setErrorMessage('Please select a repository')
      return
    }

    if (!selectedBranch) {
      setErrorMessage('Please select a branch')
      return
    }

    setStatus('cloning')
    setErrorMessage(null)
    setCloneProgress('Starting clone...')

    try {
      const response = await fetch('/api/git/clone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
        },
        body: JSON.stringify({
          repo: selectedRepo,
          branch: selectedBranch,
          workspacePath: workspacePath,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to clone repository')
      }

      const data = await response.json()

      const result: CloneResult = {
        workspacePath: data.workspacePath,
        repo: selectedRepo,
        branch: selectedBranch,
        commitSha: data.commitSha,
      }

      setCloneResult(result)
      setStatus('cloned')
      registerCloneOutputs(result)
      
      // Register workspace with GitWorkspaceContext so the tab appears
      registerWorkspace({
        id,
        repo: selectedRepo,
        branch: selectedBranch,
        workspacePath: data.workspacePath,
        commitSha: data.commitSha,
      })
      
      setCloneProgress('')
    } catch (error) {
      setStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to clone repository')
      setCloneProgress('')
    }
  }, [selectedRepo, selectedBranch, workspacePath, getAuthHeader, registerCloneOutputs, id, registerWorkspace])

  // Handle repo selection change
  const handleRepoChange = useCallback((repo: string) => {
    setSelectedRepo(repo)
    setSelectedBranch('')
    setBranches([])
  }, [])

  return {
    // Core state
    status,
    errorMessage,
    cloneResult,
    cloneProgress,

    // Auth check
    isGitHubAuthenticated: isGitHubAuthenticated(),
    githubAuthId,

    // Repo selection
    repos,
    loadingRepos,
    selectedRepo,
    repoSearch,
    setRepoSearch,
    handleRepoChange,
    allowRepoSelection,

    // Branch selection
    branches,
    loadingBranches,
    selectedBranch,
    setSelectedBranch,
    branchSearch,
    setBranchSearch,
    allowBranchSelection,

    // Actions
    handleClone,
    loadRepos,
  }
}
