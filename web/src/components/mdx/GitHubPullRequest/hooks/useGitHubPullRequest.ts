import { useState, useCallback, useEffect, useMemo } from "react"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useSession } from "@/contexts/useSession"
import { useGitWorkspace } from "@/contexts/useGitWorkspace"
import { normalizeBlockId } from "@/lib/utils"
import type { PRStatus, PRResult } from "../types"
import type { GitFileStatus } from "@/contexts/GitWorkspaceContext.types"

interface UseGitHubPullRequestOptions {
  id: string
  githubAuthId?: string
  gitCloneId: string
  defaultBranchName?: string
  defaultCommitMessage?: string
  defaultPrTitle?: string
  defaultPrBody?: string
  targetBranch?: string
  draft?: boolean
}

export function useGitHubPullRequest({
  id,
  githubAuthId,
  gitCloneId,
  defaultBranchName = '',
  defaultCommitMessage = '',
  defaultPrTitle = '',
  defaultPrBody = '',
  targetBranch,
  draft = false,
}: UseGitHubPullRequestOptions) {
  const { registerOutputs, blockOutputs, getTemplateVariables } = useRunbookContext()
  const { getAuthHeader } = useSession()
  const { workspaces, refreshWorkspaceStatus } = useGitWorkspace()

  // Core state
  const [status, setStatus] = useState<PRStatus>('pending')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [prResult, setPrResult] = useState<PRResult | null>(null)
  const [progressMessage, setProgressMessage] = useState<string>('')

  // Form state
  const [branchName, setBranchName] = useState(defaultBranchName)
  const [commitMessage, setCommitMessage] = useState(defaultCommitMessage)
  const [prTitle, setPrTitle] = useState(defaultPrTitle)
  const [prBody, setPrBody] = useState(defaultPrBody)
  const [isDraft, setIsDraft] = useState(draft)

  // Changed files from workspace
  const [changedFiles, setChangedFiles] = useState<GitFileStatus[]>([])

  // Get workspace info from GitClone block
  const workspaceInfo = useMemo(() => {
    const normalizedId = normalizeBlockId(gitCloneId)
    const outputs = blockOutputs[normalizedId]?.values
    if (!outputs) return null
    return {
      repo: outputs.REPO || '',
      branch: outputs.BRANCH || '',
      workspacePath: outputs.WORKSPACE_PATH || '',
      commitSha: outputs.COMMIT_SHA || '',
    }
  }, [gitCloneId, blockOutputs])

  // Check if GitHub auth is complete
  const isGitHubAuthenticated = useMemo(() => {
    if (!githubAuthId) return true
    const normalizedId = normalizeBlockId(githubAuthId)
    const outputs = blockOutputs[normalizedId]?.values
    return outputs?.GITHUB_AUTHENTICATED === 'true'
  }, [githubAuthId, blockOutputs])

  // Check if GitClone is complete
  const isCloneComplete = useMemo(() => {
    return !!workspaceInfo?.workspacePath
  }, [workspaceInfo])

  // Render template variables in default values
  useEffect(() => {
    // Get template variables for rendering defaults
    const templateVars = getTemplateVariables()
    
    // Simple template rendering (replace {{ .varName }} patterns)
    const renderTemplate = (template: string): string => {
      return template.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_, varName) => {
        return templateVars[varName] || ''
      }).replace(/\{\{\s*\._blocks\.(\w+)\.outputs\.(\w+)\s*\}\}/g, (_, blockId, outputName) => {
        const normalizedId = normalizeBlockId(blockId)
        return blockOutputs[normalizedId]?.values?.[outputName] || ''
      })
    }

    if (defaultBranchName && !branchName) {
      setBranchName(renderTemplate(defaultBranchName))
    }
    if (defaultCommitMessage && !commitMessage) {
      setCommitMessage(renderTemplate(defaultCommitMessage))
    }
    if (defaultPrTitle && !prTitle) {
      setPrTitle(renderTemplate(defaultPrTitle))
    }
    if (defaultPrBody && !prBody) {
      setPrBody(renderTemplate(defaultPrBody))
    }
  }, [defaultBranchName, defaultCommitMessage, defaultPrTitle, defaultPrBody, getTemplateVariables, blockOutputs, branchName, commitMessage, prTitle, prBody])

  // Fetch changed files when workspace is ready
  useEffect(() => {
    if (!workspaceInfo?.workspacePath) return

    const fetchStatus = async () => {
      try {
        const response = await fetch(`/api/git/status?path=${encodeURIComponent(workspaceInfo.workspacePath)}`, {
          headers: getAuthHeader(),
        })
        if (response.ok) {
          const data = await response.json()
          setChangedFiles(data.files || [])
        }
      } catch (error) {
        console.error('Failed to fetch git status:', error)
      }
    }

    fetchStatus()
  }, [workspaceInfo?.workspacePath, getAuthHeader])

  // Register PR outputs
  const registerPROutputs = useCallback((result: PRResult) => {
    const outputs: Record<string, string> = {
      PR_URL: result.prUrl,
      PR_NUMBER: String(result.prNumber),
      BRANCH_NAME: result.branchName,
      COMMIT_SHA: result.commitSha,
    }
    registerOutputs(id, outputs)
  }, [id, registerOutputs])

  // Create pull request
  const handleCreatePR = useCallback(async () => {
    if (!workspaceInfo) {
      setErrorMessage('GitClone block has not completed')
      return
    }

    if (!branchName.trim()) {
      setErrorMessage('Branch name is required')
      return
    }

    if (!commitMessage.trim()) {
      setErrorMessage('Commit message is required')
      return
    }

    if (!prTitle.trim()) {
      setErrorMessage('PR title is required')
      return
    }

    if (changedFiles.length === 0) {
      setErrorMessage('No changes to commit')
      return
    }

    setStatus('creating')
    setErrorMessage(null)

    try {
      // Step 1: Create branch
      setProgressMessage('Creating branch...')
      const branchResponse = await fetch('/api/git/branch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
        },
        body: JSON.stringify({
          workspacePath: workspaceInfo.workspacePath,
          branchName: branchName.trim(),
        }),
      })

      if (!branchResponse.ok) {
        const data = await branchResponse.json()
        throw new Error(data.error || 'Failed to create branch')
      }

      // Step 2: Stage and commit changes
      setProgressMessage('Committing changes...')
      const commitResponse = await fetch('/api/git/commit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
        },
        body: JSON.stringify({
          workspacePath: workspaceInfo.workspacePath,
          message: commitMessage.trim(),
        }),
      })

      if (!commitResponse.ok) {
        const data = await commitResponse.json()
        throw new Error(data.error || 'Failed to commit changes')
      }

      const commitData = await commitResponse.json()

      // Step 3: Push to remote
      setProgressMessage('Pushing to GitHub...')
      const pushResponse = await fetch('/api/git/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
        },
        body: JSON.stringify({
          workspacePath: workspaceInfo.workspacePath,
          branchName: branchName.trim(),
        }),
      })

      if (!pushResponse.ok) {
        const data = await pushResponse.json()
        throw new Error(data.error || 'Failed to push to remote')
      }

      // Step 4: Create PR via GitHub API
      setProgressMessage('Creating pull request...')
      const prResponse = await fetch('/api/github/pr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
        },
        body: JSON.stringify({
          repo: workspaceInfo.repo,
          head: branchName.trim(),
          base: targetBranch || workspaceInfo.branch,
          title: prTitle.trim(),
          body: prBody.trim(),
          draft: isDraft,
        }),
      })

      if (!prResponse.ok) {
        const data = await prResponse.json()
        throw new Error(data.error || 'Failed to create pull request')
      }

      const prData = await prResponse.json()

      const result: PRResult = {
        prUrl: prData.htmlUrl,
        prNumber: prData.number,
        branchName: branchName.trim(),
        commitSha: commitData.commitSha,
      }

      setPrResult(result)
      setStatus('created')
      registerPROutputs(result)
      setProgressMessage('')
    } catch (error) {
      setStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create pull request')
      setProgressMessage('')
    }
  }, [workspaceInfo, branchName, commitMessage, prTitle, prBody, isDraft, targetBranch, changedFiles.length, getAuthHeader, registerPROutputs])

  return {
    // Core state
    status,
    errorMessage,
    prResult,
    progressMessage,

    // Dependency checks
    isGitHubAuthenticated,
    isCloneComplete,
    githubAuthId,
    gitCloneId,
    workspaceInfo,

    // Changed files
    changedFiles,

    // Form state
    branchName,
    setBranchName,
    commitMessage,
    setCommitMessage,
    prTitle,
    setPrTitle,
    prBody,
    setPrBody,
    isDraft,
    setIsDraft,

    // Actions
    handleCreatePR,
  }
}
