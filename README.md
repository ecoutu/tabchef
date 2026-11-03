# Tabchef

Recipes for your tabs: a Chrome extension that groups, de-duplicates and closes tabs with rules you can read and change.

## What it does

- **Group** tabs into Chrome tab groups by URL, title or GitHub repo, with the names, colors and order you choose.
- **De-duplicate:** opening a page you already have open switches you to the existing tab. A pull request's Files,
  Commits and Checks pages count as the pull request itself.
- **Close finished tabs** (the Finished recipe): OAuth callback pages, redirect pages you list, and Google Meet tabs
  after the call ends. Pinned and locked tabs are never closed, and a tab with unsaved form edits is never closed
  without asking.
- **Recipes** bundle rules you turn on with one switch: Duplicates, Finished, GitHub pull requests, Merged PRs and the
  Jira ticket projects. Recipe rules are read-only; Customize copies one into your own rules.
- **Your own rules** are edited in a form or as YAML, ordered by priority, and can be kept in named sections that
  collapse and move as one block.
- **Connections** to GitHub (device flow or a personal access token) and Jira (scoped or classic API token, or the
  browser's Jira session) let recipes read pull request and ticket status:
  - **Merged PRs** lists tabs of pull requests that have merged, and can close them.
  - **Jira ticket projects** group a ticket's tab with the pull requests that name its key in their title or branch.
    The popup's Projects tab and the side panel show each ticket with its status.
- **See what changes and why:** a preview before a change moves or closes tabs, a History of what happened and which
  rule did it, and "Why is this tab here?" for any open tab.

## Privacy

Rules and tab data stay in your browser; settings sync through your Chrome account. Tabchef has no servers and no
analytics. With GitHub or Jira connected, Tabchef asks those services directly from your browser for the state of the
pull requests and tickets in your open tabs. Tokens are stored only in this browser and never synced or exported.

## Development

Requires Node.js 24 and Chrome or Chromium 116 or newer.

```sh
npm ci
npm run dev        # Chromium with the extension loaded and hot reload
npm run build      # production build in .output/chrome-mv3 (load it unpacked from chrome://extensions)
npm run zip        # the store zip
```

Checks (CI runs all of them):

```sh
npm run lint
npm run check            # svelte-check and tsc
npm test                 # Vitest unit and component tests
npm run e2e              # Playwright end-to-end tests against the built extension
npm run e2e:m3           # end-to-end tests of the GitHub and Jira flows against local mock services
npm run check:secrets    # the build holds no tokens and no test-only localhost access
npm run check:csp        # no eval or new Function in the build
npm run check:cycles     # no import cycles across the source layers
npm run check:terms      # the store listing and the UI use the same words
npm run validate:recipes # the built-in recipes match the recipe schema
```

After changing `src/core/config/config.schema.json` or `src/core/lang/*.schema.json`, regenerate the validators with
`npm run gen:validator`.

## Release

Merging to `main` releases. semantic-release picks the version from the commits, updates `CHANGELOG.md`, tags the
release and attaches `tabchef-<version>-chrome.zip` to a GitHub release. Then `scripts/submit-stores.sh` uploads the
zip to the Chrome Web Store and submits it for review.

The store step needs four repository secrets for the Chrome Web Store API v2: `CHROME_EXTENSION_ID`,
`CHROME_PUBLISHER_ID`, `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL` and `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY`. Without them it
skips, and the release is on GitHub only. To set them up:

1. Submit the first version by hand. The item ID is in the item's dashboard URL, and the publisher ID is in the
   dashboard URL after `devconsole/`.
2. Create a service account for the Chrome Web Store API
   ([guide](https://developer.chrome.com/docs/webstore/service-accounts)) and download its JSON key. The key's
   `client_email` and `private_key` fields are the last two secrets. `npx wxt submit init` (choose API v2) walks through
   the same steps.
3. Add the four secrets under Settings → Secrets and variables → Actions.
4. Run the **Validate store credentials** workflow (Actions tab). It builds the zip and checks the secrets against the
   store with `--dry-run`, without uploading anything.

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/); a commit hook runs commitlint, and
semantic-release builds the version and `CHANGELOG.md` from the commits on `main`. History stays linear: rebase, never
merge. Comments cite design decisions by short ids (for example `R19`, `M3-R57`); the surrounding text says what each
one decided.

## License

[MIT](LICENSE)
