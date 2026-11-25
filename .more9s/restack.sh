#!/usr/bin/env bash
# Rebase every open rebuild PR branch onto its base, bottom up, so each head
# contains its base's tip, then force-push each with a lease on the tip it
# had. Run it after anything moves rebuild/main (an index update) or a lower
# branch. Every branch it touches is one this session pushed.
#
# Usage: .more9s/restack.sh <worktree> [--dry-run]
# The worktree's HEAD is left detached at the top of the stack.
set -euo pipefail
cd "$1"
dry=${2:-}

git fetch -q origin

# The chain: rebuild/main, then each open PR whose base is the previous head.
chain=()
base=rebuild/main
while :; do
  head=$(gh pr list --state open --base "$base" --json headRefName \
    --jq '[.[] | select(.headRefName | startswith("rebuild/"))] | .[0].headRefName // empty')
  [ -z "$head" ] && break
  chain+=("$head")
  base=$head
done
echo "chain: rebuild/main ${chain[*]}"

declare -A old new
old[rebuild/main]=$(git rev-parse origin/rebuild/main)
new[rebuild/main]=${old[rebuild/main]}
for b in "${chain[@]}"; do old[$b]=$(git rev-parse "origin/$b"); done

parent=rebuild/main
for b in "${chain[@]}"; do
  if git merge-base --is-ancestor "${new[$parent]}" "${old[$b]}"; then
    new[$b]=${old[$b]}
  else
    git checkout -q --detach "${old[$b]}"
    git rebase -q --onto "${new[$parent]}" "${old[$parent]}"
    new[$b]=$(git rev-parse HEAD)
  fi
  printf '%-40s %s -> %s\n' "$b" "${old[$b]:0:8}" "${new[$b]:0:8}"
  parent=$b
done

[ "$dry" = "--dry-run" ] && exit 0

for b in "${chain[@]}"; do
  [ "${old[$b]}" = "${new[$b]}" ] && continue
  git push -q --force-with-lease="refs/heads/$b:${old[$b]}" origin "${new[$b]}:refs/heads/$b"
  # Move the local branch too, unless a worktree has it checked out.
  git branch -f "$b" "${new[$b]}" 2>/dev/null || echo "  local $b left as is (checked out elsewhere)"
done
git checkout -q --detach "${new[$parent]}"
