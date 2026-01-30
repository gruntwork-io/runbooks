/**
 * @fileoverview Mock Data for Files Workspace
 * 
 * Provides realistic mock data for demonstrating the workspace UI.
 * This will be replaced with actual API data in the future.
 */

import type { WorkspaceState, WorkspaceTreeNode, FileChange } from '@/types/workspace'

/**
 * Generate mock workspace data
 */
export function getMockWorkspaceData(): WorkspaceState {
  return {
    gitInfo: {
      repoUrl: 'github.com/gruntwork-io/terraform-aws-lambda',
      repoName: 'terraform-aws-lambda',
      repoOwner: 'gruntwork-io',
      branch: 'main',
      commitSha: 'a1b2c3d4e5f6789012345678901234567890abcd',
    },
    files: getMockFileTree(),
    changes: getMockChanges(),
    stats: {
      totalFiles: 32,
      generatedFiles: 0, // Will be updated by the component
      changedFiles: 3,
      totalAdditions: 45,
      totalDeletions: 12,
    },
    isLoading: false,
  }
}

/**
 * Generate mock file tree with diverse file types to showcase icons
 */
function getMockFileTree(): WorkspaceTreeNode[] {
  return [
    {
      id: 'root-infra',
      name: 'infra',
      type: 'folder',
      children: [
        {
          id: 'infra-live',
          name: 'live',
          type: 'folder',
          children: [
            {
              id: 'live-terragrunt',
              name: 'terragrunt.hcl',
              type: 'file',
              file: { id: 'live-terragrunt', name: 'terragrunt.hcl', path: 'infra/live/terragrunt.hcl', language: 'hcl', content: '# Root terragrunt config' },
            },
            {
              id: 'live-prod',
              name: 'prod',
              type: 'folder',
              children: [
                {
                  id: 'prod-terragrunt',
                  name: 'terragrunt.hcl',
                  type: 'file',
                  file: { id: 'prod-terragrunt', name: 'terragrunt.hcl', path: 'infra/live/prod/terragrunt.hcl', language: 'hcl', content: '# Prod terragrunt' },
                },
                {
                  id: 'prod-main',
                  name: 'main.tf',
                  type: 'file',
                  file: { id: 'prod-main', name: 'main.tf', path: 'infra/live/prod/main.tf', language: 'hcl', content: '# Prod main' },
                },
                {
                  id: 'prod-vars',
                  name: 'terraform.tfvars',
                  type: 'file',
                  file: { id: 'prod-vars', name: 'terraform.tfvars', path: 'infra/live/prod/terraform.tfvars', language: 'hcl', content: '# Prod vars' },
                },
              ],
            },
          ],
        },
        {
          id: 'infra-modules',
          name: 'modules',
          type: 'folder',
          children: [
            {
              id: 'modules-lambda',
              name: 'lambda',
              type: 'folder',
              children: [
                { id: 'lambda-main', name: 'main.tf', type: 'file', file: { id: 'lambda-main', name: 'main.tf', path: 'infra/modules/lambda/main.tf', language: 'hcl', content: '# Lambda module' } },
                { id: 'lambda-vars', name: 'variables.tf', type: 'file', file: { id: 'lambda-vars', name: 'variables.tf', path: 'infra/modules/lambda/variables.tf', language: 'hcl', content: '# Variables' } },
                { id: 'lambda-outputs', name: 'outputs.tf', type: 'file', file: { id: 'lambda-outputs', name: 'outputs.tf', path: 'infra/modules/lambda/outputs.tf', language: 'hcl', content: '# Outputs' } },
                { id: 'lambda-long', name: 'this-is-a-very-long-filename-that-should-overflow-horizontally.tf', type: 'file', file: { id: 'lambda-long', name: 'this-is-a-very-long-filename-that-should-overflow-horizontally.tf', path: 'infra/modules/lambda/this-is-a-very-long-filename-that-should-overflow-horizontally.tf', language: 'hcl', content: '# Long filename test' } },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'root-src',
      name: 'src',
      type: 'folder',
      children: [
        {
          id: 'src-api',
          name: 'api',
          type: 'folder',
          children: [
            { id: 'api-main', name: 'main.go', type: 'file', file: { id: 'api-main', name: 'main.go', path: 'src/api/main.go', language: 'go', content: '// Go API' } },
            { id: 'api-handler', name: 'handler.go', type: 'file', file: { id: 'api-handler', name: 'handler.go', path: 'src/api/handler.go', language: 'go', content: '// Handler' } },
            { id: 'api-test', name: 'main_test.go', type: 'file', file: { id: 'api-test', name: 'main_test.go', path: 'src/api/main_test.go', language: 'go', content: '// Tests' } },
          ],
        },
        {
          id: 'src-web',
          name: 'web',
          type: 'folder',
          children: [
            { id: 'web-app', name: 'App.tsx', type: 'file', file: { id: 'web-app', name: 'App.tsx', path: 'src/web/App.tsx', language: 'typescript', content: '// React App' } },
            { id: 'web-index', name: 'index.ts', type: 'file', file: { id: 'web-index', name: 'index.ts', path: 'src/web/index.ts', language: 'typescript', content: '// Entry' } },
            { id: 'web-utils', name: 'utils.js', type: 'file', file: { id: 'web-utils', name: 'utils.js', path: 'src/web/utils.js', language: 'javascript', content: '// Utils' } },
            { id: 'web-styles', name: 'styles.css', type: 'file', file: { id: 'web-styles', name: 'styles.css', path: 'src/web/styles.css', language: 'css', content: '/* Styles */' } },
            { id: 'web-index-html', name: 'index.html', type: 'file', file: { id: 'web-index-html', name: 'index.html', path: 'src/web/index.html', language: 'html', content: '<!-- HTML -->' } },
          ],
        },
        {
          id: 'src-scripts',
          name: 'scripts',
          type: 'folder',
          children: [
            { id: 'scripts-deploy', name: 'deploy.sh', type: 'file', file: { id: 'scripts-deploy', name: 'deploy.sh', path: 'src/scripts/deploy.sh', language: 'shell', content: '#!/bin/bash' } },
            { id: 'scripts-setup', name: 'setup.py', type: 'file', file: { id: 'scripts-setup', name: 'setup.py', path: 'src/scripts/setup.py', language: 'python', content: '# Python' } },
            { id: 'scripts-build', name: 'build.ps1', type: 'file', file: { id: 'scripts-build', name: 'build.ps1', path: 'src/scripts/build.ps1', language: 'powershell', content: '# PowerShell' } },
          ],
        },
      ],
    },
    {
      id: 'root-config',
      name: 'config',
      type: 'folder',
      children: [
        { id: 'config-json', name: 'config.json', type: 'file', file: { id: 'config-json', name: 'config.json', path: 'config/config.json', language: 'json', content: '{}' } },
        { id: 'config-yaml', name: 'settings.yaml', type: 'file', file: { id: 'config-yaml', name: 'settings.yaml', path: 'config/settings.yaml', language: 'yaml', content: '# YAML' } },
        { id: 'config-toml', name: 'app.toml', type: 'file', file: { id: 'config-toml', name: 'app.toml', path: 'config/app.toml', language: 'toml', content: '# TOML' } },
      ],
    },
    {
      id: 'root-assets',
      name: 'assets',
      type: 'folder',
      children: [
        { id: 'assets-logo', name: 'logo.png', type: 'file', file: { id: 'assets-logo', name: 'logo.png', path: 'assets/logo.png', language: 'binary', content: '' } },
        { id: 'assets-hero', name: 'hero.jpg', type: 'file', file: { id: 'assets-hero', name: 'hero.jpg', path: 'assets/hero.jpg', language: 'binary', content: '' } },
        { id: 'assets-icon', name: 'icon.svg', type: 'file', file: { id: 'assets-icon', name: 'icon.svg', path: 'assets/icon.svg', language: 'svg', content: '<svg/>' } },
      ],
    },
    { id: 'root-readme', name: 'README.md', type: 'file', file: { id: 'root-readme', name: 'README.md', path: 'README.md', language: 'markdown', content: '# Project' } },
    { id: 'root-dockerfile', name: 'Dockerfile', type: 'file', file: { id: 'root-dockerfile', name: 'Dockerfile', path: 'Dockerfile', language: 'dockerfile', content: 'FROM node:18' } },
    { id: 'root-env', name: '.env.example', type: 'file', file: { id: 'root-env', name: '.env.example', path: '.env.example', language: 'env', content: '# Environment' } },
    { id: 'root-package', name: 'package.json', type: 'file', file: { id: 'root-package', name: 'package.json', path: 'package.json', language: 'json', content: '{}' } },
    { id: 'root-lock', name: 'package-lock.json', type: 'file', file: { id: 'root-lock', name: 'package-lock.json', path: 'package-lock.json', language: 'json', content: '{}' } },
    { id: 'root-gomod', name: 'go.mod', type: 'file', file: { id: 'root-gomod', name: 'go.mod', path: 'go.mod', language: 'go', content: 'module example' } },
    { id: 'root-license', name: 'LICENSE', type: 'file', file: { id: 'root-license', name: 'LICENSE', path: 'LICENSE', language: 'text', content: 'MIT License' } },
    { id: 'root-taskfile', name: 'Taskfile.yml', type: 'file', file: { id: 'root-taskfile', name: 'Taskfile.yml', path: 'Taskfile.yml', language: 'yaml', content: '# Taskfile' } },
  ]
}

/**
 * Generate mock file changes
 */
function getMockChanges(): FileChange[] {
  return [
    {
      id: 'change-1',
      path: 'api/aws_auth.go',
      changeType: 'modified',
      additions: 20,
      deletions: 0,
      language: 'go',
      originalContent: `package api

import (
	"context"
	"fmt"
	"os"
)

// CheckRegionResponse represents the response from a region check
type CheckRegionResponse struct {
	Valid   bool   \`json:"valid"\`
	Region  string \`json:"region"\`
	Error   string \`json:"error,omitempty"\`
}

// callerIdentity holds the result of an STS GetCallerIdentity call.
type callerIdentity struct {
	Account string
	Arn     string
	UserId  string
}`,
      newContent: `package api

import (
	"context"
	"fmt"
	"os"
)

// CheckRegionResponse represents the response from a region check
type CheckRegionResponse struct {
	Valid   bool   \`json:"valid"\`
	Region  string \`json:"region"\`
	Error   string \`json:"error,omitempty"\`
}

// EnvCredentialsRequest represents a request to read and validate AWS credentials from environment variables
type EnvCredentialsRequest struct {
	Prefix        string \`json:"prefix"\`
	AwsAuthID     string \`json:"awsAuthId"\`
	DefaultRegion string \`json:"defaultRegion"\`
}

// EnvCredentialsResponse represents the response from environment credential validation
// Note: Raw credentials are NEVER returned to the frontend for security
type EnvCredentialsResponse struct {
	Found           bool   \`json:"found"\`
	Valid           bool   \`json:"valid,omitempty"\`
	AccountID       string \`json:"accountId,omitempty"\`
	Arn             string \`json:"arn,omitempty"\`
	Region          string \`json:"region,omitempty"\`
	HasSessionToken bool   \`json:"hasSessionToken,omitempty"\`
	Warning         string \`json:"warning,omitempty"\`
	Error           string \`json:"error,omitempty"\`
}

// callerIdentity holds the result of an STS GetCallerIdentity call.
type callerIdentity struct {
	Account string
	Arn     string
	UserId  string
}`,
    },
    {
      id: 'change-2',
      path: 'web/src/hooks/useScriptExecution.ts',
      changeType: 'added',
      additions: 45,
      deletions: 0,
      language: 'typescript',
      newContent: `import { useState, useCallback } from 'react'
import { useApi } from './useApi'

interface ScriptExecutionState {
  isRunning: boolean
  output: string[]
  exitCode: number | null
  error: string | null
}

export function useScriptExecution() {
  const [state, setState] = useState<ScriptExecutionState>({
    isRunning: false,
    output: [],
    exitCode: null,
    error: null,
  })

  const { post } = useApi()

  const execute = useCallback(async (script: string) => {
    setState(prev => ({
      ...prev,
      isRunning: true,
      output: [],
      exitCode: null,
      error: null,
    }))

    try {
      const response = await post('/api/exec', { script })
      setState(prev => ({
        ...prev,
        isRunning: false,
        output: response.output,
        exitCode: response.exitCode,
      }))
    } catch (err) {
      setState(prev => ({
        ...prev,
        isRunning: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      }))
    }
  }, [post])

  return { ...state, execute }
}`,
    },
    {
      id: 'change-3',
      path: 'testdata/deprecated/old-example.tf',
      changeType: 'deleted',
      additions: 0,
      deletions: 12,
      language: 'hcl',
      originalContent: `# This example is deprecated
# Please use testdata/examples/simple instead

terraform {
  required_version = ">= 1.0"
}

module "lambda" {
  source = "../../modules/lambda"
  name   = "deprecated-example"
}`,
    },
  ]
}
