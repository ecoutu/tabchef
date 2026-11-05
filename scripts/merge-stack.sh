#!/usr/bin/env bash
# Land a stack of PRs whose bases chain: #1 -> main, #2 -> #1's branch, ... #N -> #(N-1)'s branch.
# Never creates a merge commit (main keeps linear history).
#
# Modes:
#   --fast-forward              Keeps every commit: fast-forwards main to the top PR's head in ONE push, so
#                               semantic-release cuts one release whose changelog lists every commit. The stack must
#                               already sit on origin/main in one line, and every commit must be a Conventional Commit.
#                               Retargets each PR to main first (GitHub marks a PR merged once its head is in its base),
#                               pushes, waits until every PR shows as merged, then deletes the branches. Needs a token
#                               that may bypass protect-main (the admin bypass).
#   --single-release (default)  ONE squash commit on main, titled with the bottom PR's title.
#                               Fold top-down: squash #N into #(N-1)'s branch, ..., #2 into #1's branch, then wait
#                               for #1's checks and squash #1 into main. The commit body lists the folded PR titles.
#                               semantic-release cuts one release, typed by the bottom PR's title.
#   --bottom-up                 One squash commit per PR on main (one release each where the type warrants it).
#                               Squash #1 into main; then for each next PR: fetch, rebase its branch onto main with
#                               `git rebase --onto origin/main <old base head> <branch>` (the old base SHA is recorded
#                               up front because the squash makes it unreachable from main), push with
#                               --force-with-lease, retarget to main, wait for CI, squash. On a rebase conflict the
#                               rebase is aborted (repo restored, nothing pushed) and the manual steps are printed.
#
# Every PR title must be a Conventional Commit (same regex as .github/workflows/pr-title.yml); it becomes the squash
# commit title. Validation happens before anything is touched.
#
# Usage: scripts/merge-stack.sh [--fast-forward|--single-release|--bottom-up] [--dry-run] PR1 PR2 ... PRN
# A PR that GitHub closed because its base branch was force-pushed can't be reopened; the script says so and prints
# the command for a replacement PR.
#
# Requires: gh (authenticated), every PR open, CI green on the PR that lands on main. --bottom-up also needs git and
# a clean working tree. --dry-run prints every mutating command instead of running it.
set -euo pipefail

title_re='^(feat|fix|perf|refactor|test|docs|build|ci|chore|style|revert)(\([a-z0-9._/-]+\))?!?: .+'

mode=single-release
dry=0
prs=()
for arg in "$@"; do
  case "$arg" in
    --fast-forward) mode=fast-forward ;;
    --single-release) mode=single-release ;;
    --bottom-up) mode=bottom-up ;;
    --dry-run) dry=1 ;;
    -h|--help) sed -n '2,/^set -euo/{/^set -euo/d;p}' "$0"; exit 0 ;;
    *) prs+=("$arg") ;;
  esac
done
[ "${#prs[@]}" -ge 1 ] || { echo "usage: $0 [--fast-forward|--single-release|--bottom-up] [--dry-run] PR..." >&2; exit 2; }

run() { if [ "$dry" = 1 ]; then echo "+ $*"; else "$@"; fi; }

# Deletes remote branch $1. One already gone is fine: the repo's delete_branch_on_merge removes a merged PR's head.
delete_branch() {
  [ "$dry" = 1 ] && { echo "+ git push origin --delete $1"; return 0; }
  local out
  if ! out=$(git push origin --delete "$1" 2>&1); then
    grep -q 'remote ref does not exist' <<<"$out" || { echo "$out" >&2; return 1; }
    echo "Branch $1 was already deleted."
  fi
}

# Did GitHub close PR $1 itself because its base branch was force-pushed? It then logs base_ref_force_pushed
# within seconds of the close, and refuses to reopen the PR.
closed_by_base_push() {
  # shellcheck disable=SC2016 # $closed is a jq variable
  [ "$(gh api "repos/{owner}/{repo}/issues/$1/events?per_page=100" --jq '
    ([.[] | select(.event == "closed")] | last | .created_at | fromdate) as $closed
    | any(.[]; .event == "base_ref_force_pushed" and ((.created_at | fromdate) - $closed | fabs) <= 10)')" = true ]
}

# Verify the chain and titles before touching anything (one gh call for the whole stack).
listing=$(gh pr list --state all --limit 1000 --json number,state,baseRefName,headRefName,headRefOid,title \
  --jq '.[] | [.number, .state, .baseRefName, .headRefName, .headRefOid, .title] | @tsv')
titles=(); heads=(); oids=()
prev_head=""
for i in "${!prs[@]}"; do
  pr=${prs[$i]}
  row=$(awk -F'\t' -v n="$pr" '$1 == n' <<<"$listing")
  [ -n "$row" ] || { echo "PR #$pr not found" >&2; exit 1; }
  IFS=$'\t' read -r _ state base head oid title <<<"$row"
  case "$state" in
    OPEN) ;;
    MERGED) echo "PR #$pr is already merged" >&2; exit 1 ;;
    *)
      if closed_by_base_push "$pr"; then
        cat >&2 <<MSG
GitHub closed PR #$pr when its base branch $base was force-pushed, and it won't reopen it. Open a replacement and
use its number instead:
  gh pr create --base $base --head $head --title '$title'
MSG
      else
        echo "PR #$pr is closed" >&2
      fi
      exit 1 ;;
  esac
  if [ "$i" -eq 0 ]; then
    [ "$base" = "main" ] || { echo "PR #$pr must target main (targets $base)" >&2; exit 1; }
  else
    [ "$base" = "$prev_head" ] || { echo "PR #$pr targets $base, expected $prev_head" >&2; exit 1; }
  fi
  [[ "$title" =~ $title_re ]] || { echo "PR #$pr title is not a Conventional Commit: $title" >&2; exit 1; }
  titles+=("$title"); heads+=("$head"); oids+=("$oid")
  prev_head=$head
done

wait_green() {
  echo "Waiting for checks on #$1 ..."
  [ "$dry" = 1 ] && return 0
  # After a push/retarget GitHub needs a moment to register the new runs; don't fail on "no checks reported".
  for _ in $(seq 1 40); do
    [ -n "$(gh pr checks "$1" 2>/dev/null)" ] && break
    sleep 15
  done
  gh pr checks "$1" --watch --fail-fast
}

if [ "$mode" = fast-forward ]; then
  last=$((${#prs[@]}-1)); top=${oids[$last]}
  git fetch --quiet origin
  git merge-base --is-ancestor origin/main "$top" \
    || { echo "origin/main is not an ancestor of #${prs[$last]}: restack onto origin/main first" >&2; exit 1; }
  bad=$(git log --format=%s "origin/main..$top" | grep -vE "$title_re" || true)
  [ -z "$bad" ] || { echo "not Conventional Commits:"$'\n'"$bad" >&2; exit 1; }
  echo "$(git rev-list --count "origin/main..$top") commits from #${prs[0]}..#${prs[$last]} will land on main."
  wait_green "${prs[$last]}"
  for pr in "${prs[@]}"; do run gh pr edit "$pr" --base main; done
  # A plain push of a descendant is a fast-forward; it is rejected if main moved meanwhile.
  run git push origin "$top:refs/heads/main"
  if [ "$dry" = 0 ]; then
    for pr in "${prs[@]}"; do
      for _ in $(seq 1 40); do
        [ "$(gh pr view "$pr" --json state --jq .state)" = MERGED ] && break
        sleep 3
      done
      [ "$(gh pr view "$pr" --json state --jq .state)" = MERGED ] \
        || { echo "#$pr is not marked merged yet; delete its branch by hand once it is" >&2; exit 1; }
    done
  fi
  for h in "${heads[@]}"; do delete_branch "$h"; done
elif [ "$mode" = single-release ]; then
  body="Squashed stack:"
  for i in "${!prs[@]}"; do body+=$'\n'"- ${titles[$i]} (#${prs[$i]})"; done
  # Fold top-down. Each fold is a squash into the PR's base branch; those intermediate commits never reach main.
  for ((i=${#prs[@]}-1; i>=1; i--)); do
    run gh pr merge "${prs[$i]}" --squash --delete-branch \
      --subject "${titles[$i]} (#${prs[$i]})" --body "Folded into #${prs[0]}"
  done
  wait_green "${prs[0]}"
  run gh pr merge "${prs[0]}" --squash --delete-branch \
    --subject "${titles[0]} (#${prs[0]})" --body "$body"
else
  if [ "$dry" = 0 ]; then
    [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "working tree not clean" >&2; exit 1; }
  fi
  orig_ref=$(git symbolic-ref -q --short HEAD || git rev-parse HEAD)

  # Rebase PR index $1 (stacked on the already-squashed PR $1-1) onto main and retarget it.
  restack() {
    local i=$1 pr=${prs[$1]} branch=${heads[$1]} old_base=${oids[$(($1-1))]} own=${oids[$1]}
    local tmp="restack/$branch"
    run git fetch origin
    # Work on a throwaway local branch at the recorded remote head, so local branches are never touched.
    run git checkout -B "$tmp" "$own"
    if ! run git rebase --onto origin/main "$old_base" "$tmp"; then
      git rebase --abort || true
      git checkout --quiet "$orig_ref" || true
      git branch -D "$tmp" >/dev/null 2>&1 || true
      cat >&2 <<MSG
Rebase conflict restacking #$pr ($branch) onto main. Nothing was pushed; the rebase was aborted and your checkout restored.
Earlier PRs in this run are already squashed into main. To finish by hand:
  git fetch origin && git checkout -B $tmp $own
  git rebase --onto origin/main $old_base $tmp      # resolve, then: git rebase --continue
  git push --force-with-lease=$branch:$own origin $tmp:$branch
  gh pr edit $pr --base main
then re-run this script with the remaining PRs (#$pr first, now targeting main).
MSG
      exit 1
    fi
    run git push --force-with-lease="$branch:$own" origin "$tmp:$branch"
    run gh pr edit "$pr" --base main
    run git checkout --quiet "$orig_ref"
    run git branch -D "$tmp"
    # Nothing bases on the previous PR's branch any more, so it is safe to delete.
    delete_branch "${heads[$(($1-1))]}"
  }

  for i in "${!prs[@]}"; do
    [ "$i" -eq 0 ] || restack "$i"
    wait_green "${prs[$i]}"
    if [ "$i" -lt $((${#prs[@]}-1)) ]; then
      # Keep the branch for now: deleting a base branch closes the PR stacked on it (restack deletes it later).
      run gh pr merge "${prs[$i]}" --squash --subject "${titles[$i]} (#${prs[$i]})" --body ""
    else
      run gh pr merge "${prs[$i]}" --squash --delete-branch --subject "${titles[$i]} (#${prs[$i]})" --body ""
    fi
  done
fi
echo "Done ($mode)."
