# Contributing to Tabchef

Bug reports, recipe ideas and pull requests are welcome. Use the issue forms
([bug report](https://github.com/ecoutu/tabchef/issues/new?template=bug_report.yml),
[recipe idea](https://github.com/ecoutu/tabchef/issues/new?template=recipe_idea.yml)). For a security problem, don't
open a public issue: see [Security](#security).

## Set up

Requires Node.js 24 and Chrome or Chromium 116 or newer.

```sh
npm ci
npm run dev        # Chromium with the extension loaded and hot reload
```

The README's [Development](README.md#development) section lists every script.

## Before you open a pull request

Run the checks CI runs:

```sh
npm run lint
npm run check
npm test
npm run check:terms
npm run check:cycles
npm run validate:recipes   # if you changed a recipe
npm run e2e                # if you changed behaviour in the browser
```

Add or update tests with the change. Unit and component tests are Vitest (`tests/`); end-to-end tests are Playwright
against the built extension (`tests/e2e/`). Changes to the GitHub or Jira flows have mocked-service tests in
`npm run e2e:m3`; never record real accounts or tokens into fixtures.

## Commits and pull requests

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `fix(rules): keep the order after a
  restart`. A commit hook runs commitlint. Use `feat` for something users see that is new, `fix` for a user-visible
  fix, and `refactor`, `test`, `docs`, `build`, `ci` or `chore` for the rest. The types decide the version and the
  changelog, so pick them with care.
- The pull request title is a Conventional Commit too (the `pr-title` check enforces it): a squash merge uses it as the
  commit title.
- History stays linear. Rebase on `main` (`git fetch && git rebase origin/main`); never merge `main` into your branch.
- Keep a pull request to one change, so its type describes all of it.

## Recipes and rules

Recipes are declarative YAML in `src/recipes/builtin/`: data, never code, which is what the Chrome Web Store's
remote-code policy requires. A new recipe needs:

- the YAML file, passing `npm run validate:recipes`;
- tests for what it groups or closes (see `tests/recipes/`);
- its help text, using the words the extension already uses (`npm run check:terms` checks the store copy and the UI).

[docs/recipes.md](docs/recipes.md) explains the rule language. Its examples are tested against the built-in recipes,
so update them if you change one.

## Words

The extension, the store listing and the docs use the same words: a bundle of rules is a *recipe*, and the page about
duplicate tabs is *Duplicates*. `npm run check:terms` fails on the alternatives it knows about and on names of pages
that don't exist. `docs/store/terms.json` lists them.

## Security

Report a vulnerability privately with GitHub's
[security advisory form](https://github.com/ecoutu/tabchef/security/advisories/new), not in a public issue.

Never commit a token, a key or a recorded API response with real account data. CI scans every branch with gitleaks
(`.gitleaks.toml`), and GitHub push protection blocks known token formats.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
