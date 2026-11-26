#!/usr/bin/env bash
# The rebuild's PRs are GitHub stack #614 on gruntwork-io/runbooks, based on
# rebuild/main. Each PR's base is the head of the PR below it, and each head
# contains its base's tip.
#
#   .more9s/stack.sh check
#       List each open PR, bottom up. Exit 1 if one's base is not the head
#       below it, or its head lacks commits its base has.
#   .more9s/stack.sh restack [--dry-run]
#       Rebase each branch onto the one below, bottom up, and force-push each
#       with a lease on the tip it had. Run it in a linked worktree after any
#       commit to rebuild/main (an index update) or to a lower branch. It
#       leaves HEAD detached at the top of the stack.
#   .more9s/stack.sh add <branch> <title> <body-file>
#       Open a draft PR from <branch> on the top of the stack, and link it.
set -euo pipefail
REPO=gruntwork-io/runbooks
STACK=628

# Sets trunk, and numbers/heads/bases of the stack's open PRs, bottom up.
read_stack() {
  local json
  json=$(gh api "repos/$REPO/stacks/$STACK")
  trunk=$(jq -r '.base.ref' <<<"$json")
  mapfile -t numbers < <(jq -r '.pull_requests[] | select(.state == "open") | .number' <<<"$json")
  mapfile -t heads < <(jq -r '.pull_requests[] | select(.state == "open") | .head.ref' <<<"$json")
  mapfile -t bases < <(jq -r '.pull_requests[] | select(.state == "open") | .base.ref' <<<"$json")
}

check() {
  read_stack
  git fetch -q origin
  local below=$trunk bad=0 i head note behind
  for i in "${!numbers[@]}"; do
    head=${heads[$i]}
    note=""
    if [ "${bases[$i]}" != "$below" ]; then
      note+=" base is ${bases[$i]}, not $below;"
      bad=1
    fi
    behind=$(git rev-list --count "origin/$head..origin/$below")
    if [ "$behind" != 0 ]; then
      note+=" lacks $behind commits of $below;"
      bad=1
    fi
    printf '#%s %-36s %s\n' "${numbers[$i]}" "$head" "${note:-ok}"
    below=$head
  done
  return $bad
}

restack() {
  local dry=${1:-}
  if [ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ]; then
    echo "restack moves HEAD: run it in a linked worktree, not the main checkout" >&2
    exit 2
  fi
  if [ -n "$(git status --porcelain)" ]; then
    echo "the worktree has uncommitted changes: commit them first" >&2
    exit 2
  fi
  read_stack
  git fetch -q origin
  declare -A old new
  old[$trunk]=$(git rev-parse "origin/$trunk")
  new[$trunk]=${old[$trunk]}
  local below=$trunk head
  for head in "${heads[@]}"; do
    old[$head]=$(git rev-parse "origin/$head")
    if git merge-base --is-ancestor "${new[$below]}" "${old[$head]}"; then
      new[$head]=${old[$head]}
    else
      git checkout -q --detach "${old[$head]}"
      if ! git rebase -q --onto "${new[$below]}" "${old[$below]}"; then
        git rebase --abort
        echo "$head does not rebase cleanly onto $below: nothing was pushed" >&2
        exit 1
      fi
      new[$head]=$(git rev-parse HEAD)
    fi
    printf '%-40s %s -> %s\n' "$head" "${old[$head]:0:8}" "${new[$head]:0:8}"
    below=$head
  done
  if [ "$dry" = "--dry-run" ]; then
    return 0
  fi
  for head in "${heads[@]}"; do
    if [ "${old[$head]}" = "${new[$head]}" ]; then
      continue
    fi
    git push -q --force-with-lease="refs/heads/$head:${old[$head]}" origin "${new[$head]}:refs/heads/$head"
    git branch -f "$head" "${new[$head]}" 2>/dev/null ||
      echo "  local $head not moved: another worktree has it checked out"
  done
  git checkout -q --detach "${new[$below]}"
  check
}

add() {
  local branch=$1 title=$2 body=$3 url
  read_stack
  local top=$trunk
  if [ "${#heads[@]}" -gt 0 ]; then
    top=${heads[-1]}
  fi
  url=$(gh pr create --repo "$REPO" --draft --base "$top" --head "$branch" --title "$title" --body-file "$body")
  echo "$url"
  gh stack link "$STACK" "${url##*/}"
  # GitHub lists a linked PR in the stack a little later. Wait for it, so
  # the next add bases its PR on this one, not on the one below.
  for _ in $(seq 1 20); do
    read_stack
    if [ "${#heads[@]}" -gt 0 ] && [ "${heads[-1]}" = "$branch" ]; then
      return 0
    fi
    sleep 3
  done
  echo "stack #$STACK does not list $branch on top after linking; check it before the next add" >&2
  return 1
}

case ${1:-} in
  check) check ;;
  restack) restack "${2:-}" ;;
  add) add "$2" "$3" "$4" ;;
  *)
    sed -n '2,15p' "$0" >&2
    exit 2
    ;;
esac
