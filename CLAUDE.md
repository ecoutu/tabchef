# Tabchef: instructions for Claude

## Commits: Conventional Commits only
- Every commit message follows [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<optional scope>): <summary>`.
  - Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `style`, `revert`.
  - Keep the summary imperative, lower case, and without a trailing period.
- The `commit-msg` hook runs commitlint (`@commitlint/config-conventional`, see `commitlint.config.*`). Never bypass it with `--no-verify`.
- Breaking changes: add `!` after the type/scope (`feat(config)!: ...`) or a `BREAKING CHANGE:` footer.
- Keep each commit to one logical change, so its type describes all of it.

## Releases: semantic-release
- Merging to `main` triggers semantic-release (config in `.releaserc*`). It reads the commits on `main` since the last tag:
  - `feat` → minor
  - `fix` / `perf` → patch
  - `!` / `BREAKING CHANGE` → major
  - anything else → no release
- semantic-release alone decides the version. Never bump `package.json` versions, create tags, or edit release notes by hand.
- Pick commit types carefully, because they *are* the changelog. Don't label a user-visible fix `chore`, or a refactor `feat`.
- `main` is protected by the `protect-main` ruleset. Changes reach it only through PRs.

## History: never use merge commits
- **Never create merge commits.** No `git merge` without `--ff-only`, no `git pull` without `--rebase`, and no `gh pr merge --merge`.
- To update a branch from `main`, rebase: `git fetch && git rebase origin/main`.
- Repo settings squash PRs with the commit title = PR title, and `main` requires linear history.
- To land a PR, use one of these:
  - `gh pr merge --squash`: the squash commit's title (the PR title) must be a Conventional Commit. semantic-release reads it. The `pr-title` CI check enforces this, so keep PR titles conventional.
  - `gh pr merge --rebase`: every commit on the branch must be a Conventional Commit.
- Stacked PRs: land them with `scripts/merge-stack.sh [--single-release|--bottom-up] [--dry-run] PR1 ... PRN`. Both modes squash. `--single-release` folds the stack into one squash commit titled like the bottom PR; `--bottom-up` squashes one PR at a time, rebasing the next branch with `git rebase --onto origin/main <old-base> <branch>`, `--force-with-lease`, and retargeting to `main`.
- Use `--force-with-lease` for force pushes, never plain `--force`. Never force-push `main`.

## Never commit
`docs/superpowers/**`, `MEMORY.md`, `NEXT.md`, `spikes/`, `fixtures/*.real.json`. These are local only, and most are listed in `.git/info/exclude`.

## Before committing
Run the scripts from `package.json`: `npm run lint`, `npm run check`, `npm test`. Never guess other commands.
