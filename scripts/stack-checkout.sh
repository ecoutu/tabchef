#!/usr/bin/env bash
# Build a checkout of a stack of open PRs to test by hand before landing it: a detached worktree with the PRs applied
# in the order given on top of origin/main, then `npm run build`. Load the printed folder with Chrome's Load unpacked
# (or press Reload on the extension already loaded from it).
#
# When the PRs already chain (#1 -> main, #2 -> #1's branch, ..., each head containing the one below), the worktree
# checks out the top PR's head. Otherwise it cherry-picks, for each PR in order, the commits of its head that aren't
# already applied, and stops on a conflict, naming the PR and the files.
# With no PR numbers it uses the open PRs assigned to you, ordered bottom-up by their base chain (main first).
#
# The worktree (default ../tabchef-stack next to this checkout) is reused: it is reset to the new stack. It must be a
# detached worktree of this repository; one with local changes, or one stopped mid cherry-pick, rebase or merge, is
# refused. `npm ci` runs when package-lock.json differs from the one last installed there.
#
# Usage: scripts/stack-checkout.sh [--dir DIR] [--no-build] [PR...]
#
# Requires: gh (authenticated), git, npm.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
dir="$root/../tabchef-stack"
build=1
prs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) [ $# -ge 2 ] || { echo "--dir needs a folder" >&2; exit 2; }; dir=$2; shift ;;
    --no-build) build=0 ;;
    -h|--help) sed -n '2,/^set -euo/{/^set -euo/d;p}' "$0"; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *)
      [[ "$1" =~ ^[0-9]+$ ]] || { echo "not a PR number: $1" >&2; exit 2; }
      for p in "${prs[@]}"; do [ "$p" != "$1" ] || { echo "PR #$1 given twice" >&2; exit 2; }; done
      prs+=("$1") ;;
  esac
  shift
done
[ -n "$dir" ] || { echo "--dir needs a folder" >&2; exit 2; }
dir=$(realpath -m -- "$dir")
case "$dir/" in "$root"/*) echo "--dir is this checkout or inside it; pick a folder outside it" >&2; exit 2 ;; esac

# One gh call for every open PR: number, base, head branch, head sha, assignees.
listing=$(gh pr list --state open --limit 200 --json number,baseRefName,headRefName,headRefOid,assignees \
  --jq '.[] | [.number, .baseRefName, .headRefName, .headRefOid, ([.assignees[].login] | join(","))] | @tsv')

if [ "${#prs[@]}" -eq 0 ]; then
  me=$(gh api user --jq .login)
  mine=$(awk -F'\t' -v me="$me" '("," $5 ",") ~ ("," me ",")' <<<"$listing")
  [ -n "$mine" ] || { echo "no open PRs assigned to $me" >&2; exit 1; }
  total=$(wc -l <<<"$mine")
  # Walk the chain up from main: the PR based on main, then the one based on its branch, and so on.
  base=main
  while row=$(awk -F'\t' -v b="$base" '$2 == b' <<<"$mine"); [ -n "$row" ]; do
    [ "$(wc -l <<<"$row")" -eq 1 ] || {
      echo "more than one open PR targets $base ($(cut -f1 <<<"$row" | tr '\n' ' ')): pass the PRs in order" >&2
      exit 1
    }
    IFS=$'\t' read -r n _ head _ _ <<<"$row"
    for p in "${prs[@]}"; do [ "$p" != "$n" ] || { echo "the PR chain loops at #$n: pass the PRs in order" >&2; exit 1; }; done
    prs+=("$n"); base=$head
    [ "${#prs[@]}" -le "$total" ] || { echo "the PR chain loops: pass the PRs in order" >&2; exit 1; }
  done
  [ "${#prs[@]}" -gt 0 ] || { echo "none of your open PRs targets main: pass the PRs in order" >&2; exit 1; }
  [ "$total" -eq "${#prs[@]}" ] || echo "note: $((total - ${#prs[@]})) of your open PRs are not in the chain from main and are left out" >&2
fi

bases=(); heads=(); oids=()
for pr in "${prs[@]}"; do
  row=$(awk -F'\t' -v n="$pr" '$1 == n' <<<"$listing")
  [ -n "$row" ] || { echo "PR #$pr is not open" >&2; exit 1; }
  IFS=$'\t' read -r _ base head oid _ <<<"$row"
  bases+=("$base"); heads+=("$head"); oids+=("$oid")
done

# One fetch for origin/main and every PR head (by its pull ref, so a fork's PR works too), into temporary refs that
# are deleted on exit.
drop_refs() { git -C "$root" for-each-ref --format='delete %(refname)' refs/stack-checkout | git -C "$root" update-ref --stdin; }
drop_refs
trap drop_refs EXIT
refspecs=()
for pr in "${prs[@]}"; do refspecs+=("+refs/pull/$pr/head:refs/stack-checkout/$pr"); done
git -C "$root" fetch --quiet origin "+refs/heads/main:refs/remotes/origin/main" "${refspecs[@]}"
for i in "${!prs[@]}"; do
  got=$(git -C "$root" rev-parse "refs/stack-checkout/${prs[$i]}")
  [ "$got" = "${oids[$i]}" ] || { echo "PR #${prs[$i]} changed while fetching; run again" >&2; exit 1; }
done

# Chained: each base is the PR below's branch, each head contains the one below (not a stale stack), the top contains
# origin/main.
chained=1
last=$((${#prs[@]}-1))
for i in "${!prs[@]}"; do
  if [ "$i" -eq 0 ]; then
    [ "${bases[0]}" = main ] || chained=0
  else
    [ "${bases[$i]}" = "${heads[$((i-1))]}" ] || chained=0
    git -C "$root" merge-base --is-ancestor "${oids[$((i-1))]}" "${oids[$i]}" || chained=0
  fi
done
git -C "$root" merge-base --is-ancestor origin/main "${oids[$last]}" || chained=0

git -C "$root" worktree prune
if [ -e "$dir" ]; then
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)
  [ "$top" = "$dir" ] || { echo "$dir is not a git worktree" >&2; exit 1; }
  [ "$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir)" \
    = "$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)" ] \
    || { echo "$dir is a worktree of another repository" >&2; exit 1; }
  git -C "$dir" symbolic-ref -q HEAD >/dev/null \
    && { echo "$dir has a branch checked out; use a detached worktree (or another --dir)" >&2; exit 1; }
  for op in CHERRY_PICK_HEAD:cherry-pick REVERT_HEAD:revert MERGE_HEAD:merge BISECT_LOG:bisect rebase-merge:rebase \
    rebase-apply:rebase; do
    [ -e "$(git -C "$dir" rev-parse --path-format=absolute --git-path "${op%%:*}")" ] \
      && { echo "$dir is in the middle of a ${op#*:}; finish or abort it there first" >&2; exit 1; }
  done
  [ -z "$(git -C "$dir" status --porcelain --untracked-files=no)" ] \
    || { echo "$dir has local changes; commit or discard them first" >&2; exit 1; }
else
  git -C "$root" worktree add --quiet --detach "$dir" origin/main
fi

if [ "$chained" = 1 ]; then
  echo "PRs ${prs[*]/#/#} chain on origin/main: checking out #${prs[$last]} (${oids[$last]:0:7})."
  git -C "$dir" checkout --quiet --detach "${oids[$last]}"
else
  echo "PRs ${prs[*]/#/#} don't chain on origin/main: cherry-picking each PR's new commits onto origin/main."
  git -C "$dir" checkout --quiet --detach origin/main
  for i in "${!prs[@]}"; do
    # The PR head's commits whose patches aren't on HEAD yet: skips what main or a PR below already brought in,
    # even when that PR was rebased since.
    mapfile -t picks < <(git -C "$dir" rev-list --reverse --no-merges --cherry-pick --right-only "HEAD...${oids[$i]}")
    echo "  #${prs[$i]}: ${#picks[@]} commit(s)"
    [ "${#picks[@]}" -gt 0 ] || continue
    if ! out=$(git -C "$dir" -c commit.gpgsign=false cherry-pick --empty=drop "${picks[@]}" 2>&1); then
      files=$(git -C "$dir" diff --name-only --diff-filter=U)
      git -C "$dir" cherry-pick --abort 2>/dev/null || true
      echo "#${prs[$i]} doesn't apply on top of the PRs before it; restack the PRs (or pass a different order)." >&2
      if [ -n "$files" ]; then echo "Conflicts in:"$'\n'"$files" >&2; else echo "$out" >&2; fi
      exit 1
    fi
  done
fi
git -C "$dir" log --oneline origin/main..HEAD

[ "$build" = 1 ] || { echo "Checkout ready (not built): $dir"; exit 0; }
# Reinstall when the lockfile differs from the one last installed here successfully.
stamp="$dir/node_modules/.stack-checkout-lock"
lock=$(git -C "$dir" hash-object package-lock.json)
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$lock" ]; then
  (cd "$dir" && npm ci --no-audit --no-fund)
  echo "$lock" > "$stamp"
fi
(cd "$dir" && npm run build)
echo
echo "Load unpacked (or Reload): $dir/.output/chrome-mv3"
