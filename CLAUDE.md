# Tabchef: instructions for Claude

## Commits: Conventional Commits only
- Every commit message follows [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<optional scope>): <summary>`.
  - Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `style`, `revert`.
  - Keep the summary imperative, lower case, and without a trailing period.
- The `commit-msg` hook runs commitlint (`@commitlint/config-conventional`, see `commitlint.config.*`). Never bypass it with `--no-verify`.
- Breaking changes: add `!` after the type/scope (`feat(config)!: ...`) or a `BREAKING CHANGE:` footer.
- Keep each commit to one logical change, so its type describes all of it.

## Commits: write them for the changelog
- Write each summary as the change a user sees, not the code that moved: `fix(popup): refresh tab counts after closing a project group`, not `fix: update state handling`.
- Every commit that reaches `main` must read well as a changelog line. No `wip`, `address review`, `fix lint`, `fix typo` or `fix tests` commits.
- Clean up a branch's history before opening or updating a PR, and again before landing. Rebase as needed:
  - fold follow-up fixes into the commit they fix (`git commit --fixup=<sha>`, then `git rebase -i --autosquash origin/main`);
  - split a commit that does two things, and reorder commits so each one builds and passes on its own;
  - reword a summary that is vague or has the wrong type.
- A fix of code that was never released is folded into that code's commit, never a separate `fix`.
- Add a body when the why isn't obvious from the summary.
- After rebasing a branch that is already pushed, update it with `--force-with-lease`. Ask first if another PR uses it as its base.

## Releases: semantic-release
- Merging to `main` triggers semantic-release (config in `.releaserc*`). It reads the commits on `main` since the last tag:
  - `feat` → minor
  - `fix` / `perf` → patch
  - `!` / `BREAKING CHANGE` → major
  - anything else → no release
- semantic-release alone decides the version. Never bump `package.json` versions, create tags, or edit release notes by hand.
- Pick commit types carefully, because they *are* the changelog. Don't label a user-visible fix `chore`, or a refactor `feat`.
- `main` is protected by the `protect-main` ruleset. Changes reach it through PRs. The admin bypass exists for the release job's changelog commit and for landing a prepared stack with `--fast-forward`; don't use it to push work that skipped review.

## History: never use merge commits
- **Never create merge commits.** No `git merge` without `--ff-only`, no `git pull` without `--rebase`, and no `gh pr merge --merge`.
- To update a branch from `main`, rebase: `git fetch && git rebase origin/main`.
- Repo settings squash PRs with the commit title = PR title, and `main` requires linear history.
- To land a PR, use one of these:
  - `gh pr merge --squash`: the squash commit's title (the PR title) must be a Conventional Commit. semantic-release reads it. The `pr-title` CI check enforces this, so keep PR titles conventional.
  - `gh pr merge --rebase`: every commit on the branch must be a Conventional Commit.
- Stacked PRs: keep every commit, because the commits are the changelog. Before landing:
  - restack the PRs into one line on top of `origin/main` (each PR based on the previous one);
  - fold fixes of code that was never released into the commit they fix (`git commit --fixup=<sha>`, then `git rebase -i --autosquash --update-refs origin/main`), so the changelog lists only real fixes;
  - re-sign after the rewrite (`git rebase --force-rebase --committer-date-is-author-date`).
- Then land with `scripts/merge-stack.sh --fast-forward [--dry-run] PR1 ... PRN`. It fast-forwards `main` to the top PR in one push, so semantic-release cuts one release, and GitHub marks every PR merged. `--single-release` (one squash commit for the whole stack) and `--bottom-up` (one squash per PR) remain for stacks whose history doesn't matter.
- Use `--force-with-lease` for force pushes, never plain `--force`. Never force-push `main`.

## Never commit
`docs/superpowers/**`, `MEMORY.md`, `NEXT.md`, `spikes/`, `fixtures/*.real.json`. These are local only, and most are listed in `.git/info/exclude`.

## Before committing
Run the scripts from `package.json`: `npm run lint`, `npm run check`, `npm test`. Never guess other commands.
