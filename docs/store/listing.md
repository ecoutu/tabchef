# Chrome Web Store listing

The copy for each field of the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), in the order the
dashboard asks for it. [submitting.md](submitting.md) walks through the submission step by step;
[launch.md](launch.md) has the launch posts and taglines.

`npm run check:terms` checks this file against `terms.json` and against the page and view names the extension shows,
so the listing never names a page the user can't find. The name is still open ([#46](https://github.com/ecoutu/tabchef/issues/46)): a rename changes `name` in
`terms.json`, and the check then flags every place still using the old one.

## Name

Tabchef

The dashboard takes the name and the summary from the manifest (`wxt.config.ts`), not from this file. Keep them the
same.

## Tagline

Recipes for your tabs.

## Summary (max 132 characters)

Group, de-duplicate and auto-close tabs with rules. Recipes for GitHub PRs, OAuth callbacks and Meet calls, or write your own.

## Description

Tabchef manages your tabs with recipes: ready-made rules you can read, turn on with one switch, and customize.

GROUP
Put tabs into Chrome tab groups by URL, title or GitHub repo, with the names, colors and order you choose. Groups stay in that order, even after a restart.

DE-DUPLICATE
Open a page you already have open and Tabchef closes the new tab and switches you to the existing one. A pull request's Files, Commits and Checks pages count as the pull request itself.

CLOSE FINISHED TABS
Turn on the Finished recipe and OAuth callback pages, redirect pages you list, and Google Meet tabs after the call has ended close on their own. Pinned and locked tabs are never closed, and a tab with unsaved form edits is never closed without asking.

MERGED PULL REQUESTS
Connect GitHub and the Merged tab lists your open pull request tabs that have merged, so you can close them in one click, or have them close on their own.

JIRA TICKETS AND THEIR PULL REQUESTS
Group a Jira ticket's tab with the pull requests that name its key in their title or branch. The Projects tab and the side panel show each ticket with its status and pull requests, and offer to close the group once the ticket is done.

RECIPES
Turn on a bundle of rules with one switch: Duplicates, Finished, GitHub pull requests, Merged PRs, and Jira ticket projects. Customize any rule in the form editor, or write your own, and keep your own rules in named sections you can collapse and move.

SEE WHAT CHANGES, AND WHY
Before a settings change moves or closes tabs, a preview shows exactly what will happen. History lists what was grouped or closed and by which rule, and "Why is this tab here?" names the rule behind any open tab.

PRIVACY
Your rules and tab data stay in your browser, and settings sync through your Chrome account. Tabchef has no servers and no analytics. If you connect GitHub or Jira, Tabchef asks those services directly from your browser for the state of the pull requests and tickets in your open tabs; tokens stay in this browser.
Full privacy policy: https://github.com/ecoutu/tabchef/blob/main/PRIVACY.md

OPEN SOURCE
https://github.com/ecoutu/tabchef. Bug reports and recipe ideas are welcome.

## Category and language

- **Category:** Productivity → Developer Tools. The listing leads with the developer workflow (pull requests, Jira
  tickets). Productivity → Workflow & Planning is the fallback if a reviewer reads it as a general tab manager.
- **Language:** English

## Graphic assets

Made by the store-art issue ([#48](https://github.com/ecoutu/tabchef/issues/48)) and the icon issue ([#47](https://github.com/ecoutu/tabchef/issues/47)); the designs are in the launch kit
(https://claude.ai/artifact/RF913qNnKxbSjjQqTaFTVe). Screenshots come from the real extension, not mocks.
`npm run store:assets` renders them, and each release re-renders them and commits the ones that changed in its
`chore(release)` commit, so the files here match the latest release. The dashboard still needs them uploaded by hand.

| Field | Size | File |
|---|---|---|
| Store icon | 128×128 (96×96 artwork, 16 px transparent padding) | `public/icon/128.png` |
| Screenshot 1: duplicates | 1280×800 | `docs/store/images/screenshot-1-duplicates.png` |
| Screenshot 2: groups by repo | 1280×800 | `docs/store/images/screenshot-2-groups.png` |
| Screenshot 3: Jira ticket with its pull requests | 1280×800 | `docs/store/images/screenshot-3-projects.png` |
| Screenshot 4: merged pull requests | 1280×800 | `docs/store/images/screenshot-4-merged.png` |
| Screenshot 5: preview before apply | 1280×800 | `docs/store/images/screenshot-5-preview.png` |
| Small promo tile (required) | 440×280 | `docs/store/images/promo-small-440x280.png` |
| Marquee promo tile (optional) | 1400×560 | `docs/store/images/promo-marquee-1400x560.png` |

## Additional fields

- **Homepage URL:** https://github.com/ecoutu/tabchef
- **Support URL:** https://github.com/ecoutu/tabchef/issues

Both need the repository to be public ([#50](https://github.com/ecoutu/tabchef/issues/50)).

## Single purpose

Organize the user's browser tabs: group, de-duplicate and close them according to rules the user turns on or writes, including rules that use the state of the GitHub pull requests and Jira tickets open in those tabs.

## Permission justifications

One field per permission in the dashboard's Privacy practices section. The optional permissions are asked for at
runtime, only when the user turns on a feature that needs them.

### tabs

Reads each tab's URL and title to match the user's rules, and moves, groups and closes tabs as those rules say. The URLs and titles are processed in the browser and are not sent anywhere.

### tabGroups

Creates, names, colors, orders and collapses Chrome tab groups for the user's group rules, and keeps the groups in the order the user configured.

### storage

Saves the user's settings and rules (synced through the user's Chrome account), and keeps local data in this browser only: the history of what was grouped or closed and why, projects, cached pull request and ticket state, and connection tokens (never synced).

### contextMenus

Adds right-click items on a page: group or auto-close pages like this one, skip duplicate checks for the site, "Why is this tab here?", and add the tab to a project or remove it.

### alarms

Wakes the service worker on a schedule: re-checks rules that depend on how long ago a tab was opened (every minute), runs closes the user delayed, and refreshes cached pull request and ticket state.

### webNavigation

Sees when a tab starts loading a new page, including in-page navigations such as moving between a pull request's tabs on GitHub, so duplicates are caught before the new page loads and the tab's group is updated for its new address.

### notifications (optional)

Asked for only when the user turns on notifications for duplicates. Shows a notification asking whether to close a duplicate tab, and whether to close a tab that has unsaved form edits.

### scripting (optional)

Asked for only when the user turns on a rule or recipe that reads pages. Injects Tabchef's own bundled scripts into tabs on sites the user granted: a banner that asks before closing a duplicate or a tab with unsaved form edits, and a page watcher for rules that match on page text, read a value from the page (for example a pull request's branch) or protect unsaved form edits. The watcher reports only whether the phrases a rule names appear on the page, the values a rule reads, and whether a form field was edited; it never sends the page text.

### sidePanel

Shows the user's projects (a Jira ticket with its pull requests) in Chrome's side panel.

### Host permissions (optional)

The dashboard may not ask: all host access is in `optional_host_permissions` and requested at runtime. If a reviewer asks:

Host access is optional and requested at runtime, one site at a time, when the user turns on a feature that needs it: github.com and api.github.com to read pull request state for the GitHub connection or from the pull request page; the user's own Jira site (any *.atlassian.net or self-hosted address) for Jira tickets; meet.google.com to notice that a call has ended; sites the user names in their own page rules; and http://localhost for rules about local development servers, such as OAuth callback pages. Without a grant, rules use only tab URLs and titles.

## Remote code

**No, I am not using remote code.** All JavaScript is bundled in the package. Recipes and rules are YAML or JSON data
read by a fixed interpreter; they cannot contain code.

## Data usage

Tabchef has no developer servers and sends nothing to the developer. Recommended answers:

- **Authentication information: checked.** GitHub and Jira tokens are stored in this browser only and sent only to
  GitHub or the user's Jira site.
- **Web history: checked.** With a connection set up, the pull request numbers and Jira keys found in the user's
  open tabs are sent to GitHub or the user's Jira site to read their state. Nothing goes anywhere without a
  connection.
- **Website content: unchecked.** Page reading happens in the browser; only the user's own rules see the result, and
  none of it leaves the browser.
- **User activity: unchecked.** The form-edit check is a yes/no flag kept in the browser; keystrokes are never read.
- Everything else: unchecked.
- Certify all three statements: the data is not sold to third parties, not used or transferred for purposes
  unrelated to the single purpose, and not used to determine creditworthiness or for lending.

## Privacy policy URL

https://github.com/ecoutu/tabchef/blob/main/PRIVACY.md

## Test instructions

Optional field for reviewers. Every feature but the GitHub and Jira connections works without an account. Walk
through these on the build you upload before pasting them in (the first-submission issue has the checkbox).

1. Open any page, then open the same address in a new tab: the new tab closes and the first one comes forward (the
   Duplicates recipe, on by default).
2. On the Recipes page, turn on the rule "Group GitHub tabs by repository" (GitHub pull requests recipe), then open
   two pages of one repository on github.com: they join one tab group named after the repository.
3. On the Recipes page, turn on the Finished recipe, then open http://localhost:3000/callback in a background tab:
   it closes on its own after about 3 seconds, and the popup offers Undo. To verify: the exact moment a tab counts
   as not in use.
4. The GitHub and Jira connections need the reviewer's own accounts. Without them, the Merged PRs and Jira ticket
   recipes work from tab titles and page reading.
