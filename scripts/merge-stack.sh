#!/usr/bin/env bash
# Merge a stack of PRs whose bases chain: #1 -> main, #2 -> #1's branch, ... #N -> #(N-1)'s branch.
#
# Modes:
#   --single-release (default)  Merge top-down: #N into #(N-1), ..., #2 into #1, then #1 into main.
#                               main receives everything in one merge, so semantic-release cuts one release.
#   --bottom-up                 Merge #1 into main, retarget #2 to main, merge it, and so on.
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
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) prs+=("$arg") ;;
  esac
done
[ "${#prs[@]}" -ge 1 ] || { echo "usage: $0 [--single-release|--bottom-up] [--dry-run] PR..." >&2; exit 2; }

run() { if [ "$dry" = 1 ]; then echo "+ $*"; else "$@"; fi; }
field() { gh pr view "$1" --json "$2" --jq ".$2"; }

# Verify the chain before touching anything.
prev_head=""
for i in "${!prs[@]}"; do
  pr=${prs[$i]}
  [ "$(field "$pr" state)" = "OPEN" ] || { echo "PR #$pr is not open" >&2; exit 1; }
  base=$(field "$pr" baseRefName)
  if [ "$i" -eq 0 ]; then
    [ "$base" = "main" ] || { echo "PR #$pr must target main (targets $base)" >&2; exit 1; }
  else
    [ "$base" = "$prev_head" ] || { echo "PR #$pr targets $base, expected $prev_head" >&2; exit 1; }
  fi
  prev_head=$(field "$pr" headRefName)
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
  for i in "${!prs[@]}"; do
    pr=${prs[$i]}
    [ "$i" -eq 0 ] || run gh pr edit "$pr" --base main
    wait_green "$pr"
    run gh pr merge "$pr" --merge --delete-branch
  done
fi
echo "Done ($mode)."
