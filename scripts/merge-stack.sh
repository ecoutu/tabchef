#!/usr/bin/env bash
# Merge a stack of PRs whose bases chain: #1 -> main, #2 -> #1's branch, ... #N -> #(N-1)'s branch.
#
# Modes:
#   --single-release (default)  Merge top-down: #N into #(N-1), ..., #2 into #1, then #1 into main.
#                               main receives everything in one merge, so semantic-release cuts one release.
#   --bottom-up                 Retarget #2 to main, then merge #1 into main (deleting #1's branch is safe once
#                               nothing bases on it); retarget #3, merge #2, and so on.
#                               Every merge to main cuts its own release.
#
# Usage: scripts/merge-stack.sh [--single-release|--bottom-up] [--dry-run] PR1 PR2 ... PRN
# Requires: gh (authenticated), every PR open, CI green on the PR that lands on main.
set -euo pipefail

mode=single-release
dry=0
prs=()
for arg in "$@"; do
  case "$arg" in
    --single-release) mode=single-release ;;
    --bottom-up) mode=bottom-up ;;
    --dry-run) dry=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) prs+=("$arg") ;;
  esac
done
[ "${#prs[@]}" -ge 1 ] || { echo "usage: $0 [--single-release|--bottom-up] [--dry-run] PR..." >&2; exit 2; }

run() { if [ "$dry" = 1 ]; then echo "+ $*"; else "$@"; fi; }

# Verify the chain before touching anything (one gh call per PR).
prev_head=""
for i in "${!prs[@]}"; do
  pr=${prs[$i]}
  IFS=$'\t' read -r state base head < <(gh pr view "$pr" --json state,baseRefName,headRefName \
    --jq '[.state, .baseRefName, .headRefName] | @tsv')
  [ "$state" = "OPEN" ] || { echo "PR #$pr is not open" >&2; exit 1; }
  if [ "$i" -eq 0 ]; then
    [ "$base" = "main" ] || { echo "PR #$pr must target main (targets $base)" >&2; exit 1; }
  else
    [ "$base" = "$prev_head" ] || { echo "PR #$pr targets $base, expected $prev_head" >&2; exit 1; }
  fi
  prev_head=$head
done

wait_green() {
  echo "Waiting for checks on #$1 ..."
  [ "$dry" = 1 ] || gh pr checks "$1" --watch --fail-fast
}

if [ "$mode" = single-release ]; then
  for ((i=${#prs[@]}-1; i>=1; i--)); do
    run gh pr merge "${prs[$i]}" --merge --delete-branch
  done
  wait_green "${prs[0]}"
  run gh pr merge "${prs[0]}" --merge --delete-branch
else
  # Retarget the next PR BEFORE merging this one: --delete-branch removes this PR's branch, and GitHub closes
  # (not retargets) a PR whose base branch is deleted.
  for i in "${!prs[@]}"; do
    pr=${prs[$i]}
    next=${prs[$((i+1))]:-}
    [ -z "$next" ] || run gh pr edit "$next" --base main
    wait_green "$pr"
    run gh pr merge "$pr" --merge --delete-branch
  done
fi
echo "Done ($mode)."
