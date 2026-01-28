#!/usr/bin/env bash
#
# This script creates a pull request with all the files from the generated folder.
# It handles the complete workflow of cloning the repo, adding files, committing,
# pushing, and creating a PR.
#
# This script is designed to be called from the runbook Command block, which
# automatically passes values from the boilerplate input block with id
# "lambda-config" as template variables:
#   - GithubOrgName -> GitHub organization name
#   - GithubRepoName -> GitHub repository name
#   - Environment -> Target environment (non-prod, prod)
#   - AwsRegion -> AWS region for deployment
#   - FunctionName -> Lambda function name
#
# Environment variables:
#   - RUNBOOK_DRY_RUN: Set to "true" to print commands instead of executing them

set -e

# Dry-run support: when enabled, prints what would happen instead of executing
DRY_RUN="${RUNBOOK_DRY_RUN:-false}"

# Save the original directory before any cd commands
ORIGINAL_DIR=$(pwd)

# Parse arguments (automatically passed from boilerplate inputs in the runbook)
GITHUB_ORG="{{ .GithubOrgName }}"
REPO_NAME="{{ .GithubRepoName }}"
ENVIRONMENT="{{ .Environment }}"
AWS_REGION="{{ .AwsRegion }}"
FUNCTION_NAME="{{ .FunctionName }}"

if [ -z "$GITHUB_ORG" ] || [ -z "$REPO_NAME" ]; then
    echo "Error: Missing required arguments"
    echo "Usage: GitHub org and repo name must be provided"
    exit 1
fi

if [ -z "$ENVIRONMENT" ] || [ -z "$AWS_REGION" ]; then
    echo "Error: Missing environment or region"
    echo "Environment: $ENVIRONMENT, Region: $AWS_REGION"
    exit 1
fi

# Configuration
BRANCH_NAME="add-lambda-${FUNCTION_NAME}-${ENVIRONMENT}"
GENERATED_DIR="generated"
TARGET_PATH="${ENVIRONMENT}/${AWS_REGION}/${FUNCTION_NAME}"
TEMP_DIR=$(mktemp -d)

echo "🚀 Starting pull request creation process..."
echo "   Repository: ${GITHUB_ORG}/${REPO_NAME}"
echo "   Branch: ${BRANCH_NAME}"
echo "   Target Path: ${TARGET_PATH}"
echo ""

# Check if generated directory exists
if [ ! -d "${ORIGINAL_DIR}/${GENERATED_DIR}" ]; then
    echo "❌ Error: Generated directory not found at ${ORIGINAL_DIR}/${GENERATED_DIR}"
    echo "   Please make sure you've generated the files first."
    exit 1
fi

# Check if there are any files in the generated directory
if [ -z "$(ls -A ${ORIGINAL_DIR}/${GENERATED_DIR})" ]; then
    echo "❌ Error: Generated directory is empty"
    echo "   Please generate files before running this script."
    exit 1
fi

# Dry-run mode: show what would happen and exit
if [[ "$DRY_RUN" == "true" ]]; then
    echo "📝 Dry-run mode: Simulating repository operations..."
    echo ""
    echo "[DRY-RUN] gh repo clone ${GITHUB_ORG}/${REPO_NAME} repo"
    echo "[DRY-RUN] git checkout -b $BRANCH_NAME"
    echo "[DRY-RUN] cp -r ${GENERATED_DIR}/* ${TARGET_PATH}/"
    echo "[DRY-RUN] git add ."
    echo "[DRY-RUN] git commit -m 'Add Lambda function: ${FUNCTION_NAME} (${ENVIRONMENT}/${AWS_REGION})'"
    echo "[DRY-RUN] git push origin $BRANCH_NAME"
    echo "[DRY-RUN] gh pr create --title 'Add Lambda function: ${FUNCTION_NAME} (${ENVIRONMENT}/${AWS_REGION})'"
    echo ""
    echo "✅ Dry-run completed successfully!"
    echo "   In real execution, this would create a PR at:"
    echo "   https://github.com/${GITHUB_ORG}/${REPO_NAME}/pulls"
    rm -rf "$TEMP_DIR"
    exit 0
fi

echo "📦 Cloning repository..."
cd "$TEMP_DIR"
gh repo clone "${GITHUB_ORG}/${REPO_NAME}" repo
cd repo

# Check if the repository is empty (no commits on main)
REPO_IS_EMPTY=false
if ! git rev-parse --verify main >/dev/null 2>&1; then
    REPO_IS_EMPTY=true
    echo "📝 Repository is empty (no main branch yet)"
    echo "   Creating initial commit on main to establish base branch..."
    
    # Ensure we're on main branch (in case default branch isn't main)
    git checkout -b main 2>/dev/null || git checkout main
    
    # Create a minimal README for the initial commit
    echo "# ${REPO_NAME}" > README.md
    echo "" >> README.md
    echo "Infrastructure repository managed with Terragrunt." >> README.md
    
    git add README.md
    git commit -m "Initial commit"
    
    echo "⬆️  Pushing initial commit to main..."
    git push -u origin main
    
    echo "✅ Base branch established"
fi

# Check if the branch already exists remotely
if git ls-remote --heads origin "$BRANCH_NAME" | grep -q "$BRANCH_NAME"; then
    echo "🌿 Branch '$BRANCH_NAME' already exists, checking it out..."
    git fetch origin "$BRANCH_NAME"
    git checkout "$BRANCH_NAME"
    git pull origin "$BRANCH_NAME"
else
    echo "🌿 Creating new branch '$BRANCH_NAME'..."
    git checkout -b "$BRANCH_NAME"
fi

echo "📁 Creating target directory: ${TARGET_PATH}..."
mkdir -p "${TARGET_PATH}"

echo "📁 Copying generated files to ${TARGET_PATH}..."
cp -r "${ORIGINAL_DIR}/${GENERATED_DIR}"/* "${TARGET_PATH}/"

echo "➕ Adding files to git..."
git add .

# Check if there are any changes to commit
if git diff --staged --quiet; then
    echo "⚠️  Warning: No changes detected. The generated files may already exist in the repo."
    echo "   Cleaning up and exiting..."
    cd "$ORIGINAL_DIR"
    rm -rf "$TEMP_DIR"
    exit 0
fi

echo "💾 Committing changes..."
git commit -m "Add Lambda function: ${FUNCTION_NAME} (${ENVIRONMENT}/${AWS_REGION})

This commit adds a new Lambda function configuration:
- Function name: ${FUNCTION_NAME}
- Environment: ${ENVIRONMENT}
- Region: ${AWS_REGION}
- Path: ${TARGET_PATH}

Files included:
- terragrunt.hcl - Terragrunt unit configuration
- src/app.py - Lambda handler source code"

echo "⬆️  Pushing to GitHub..."
git push origin "$BRANCH_NAME"

# Check if PR already exists
PR_EXISTS=$(gh pr list --head "$BRANCH_NAME" --json number --jq 'length')

if [ "$PR_EXISTS" -gt 0 ]; then
    PR_NUMBER=$(gh pr list --head "$BRANCH_NAME" --json number --jq '.[0].number')
    echo "🔀 Pull request #${PR_NUMBER} already exists, updated with new commits!"
    echo "   View it at: https://github.com/${GITHUB_ORG}/${REPO_NAME}/pull/${PR_NUMBER}"
else
    echo "🔀 Creating pull request..."
    gh pr create \
        --base main \
        --head "$BRANCH_NAME" \
        --title "Add Lambda function: ${FUNCTION_NAME} (${ENVIRONMENT}/${AWS_REGION})" \
        --body "This PR adds a new Lambda function deployment.

## Lambda Configuration
| Setting | Value |
|---------|-------|
| Function Name | \`${FUNCTION_NAME}\` |
| Environment | \`${ENVIRONMENT}\` |
| Region | \`${AWS_REGION}\` |
| Path | \`${TARGET_PATH}\` |

## Files Added
- \`${TARGET_PATH}/terragrunt.hcl\` - Terragrunt unit configuration
- \`${TARGET_PATH}/src/app.py\` - Lambda handler source code

## Next Steps
1. Review the configuration changes
2. Merge this PR
3. Run \`terragrunt apply\` in the \`${TARGET_PATH}\` directory to deploy"
    
    echo ""
    echo "✅ Pull request created successfully!"
    echo "   View it at: https://github.com/${GITHUB_ORG}/${REPO_NAME}/pulls"
fi

# Cleanup
cd "$ORIGINAL_DIR"
rm -rf "$TEMP_DIR"

echo ""
echo "🎉 Done! Your pull request is ready for review."

