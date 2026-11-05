# Tabchef privacy policy

Effective 2026-11-03.

Tabchef is a Chrome extension that groups, de-duplicates and closes your tabs according to rules you turn on or
write. It has no servers and no analytics, and it sends nothing to its developer. This policy describes what Tabchef
reads, where it keeps it, and the only cases in which anything leaves your browser.

## What Tabchef reads

- **Your tabs:** each tab's address, title, opener and tab group, to match your rules and to group, move or close
  tabs. This happens in your browser.
- **Pages, only on sites you allow:** some rules and recipes read a page, for example to notice that a Google Meet call
  has ended or to read a pull request's branch. Tabchef asks for access to a site before it reads any page there,
  and you can revoke that access at any time in Chrome. On those sites, Tabchef's page script reports only:
  - whether the phrases a rule names appear on the page (never the page text itself);
  - the values a rule reads from the page, such as a pull request's state or branch;
  - whether a form field on the page was edited, so a tab with unsaved input is never closed without asking. It
    never reads what you type.

## Where Tabchef keeps data

- **Settings and rules** are saved with Chrome's sync storage, so they follow you to other computers signed in to
  the same Chrome profile. Chrome sync is governed by Google's privacy policy and your Chrome sync settings.
- **Everything else stays in this browser** (Chrome's local and session storage) and is never synced:
  - the history of what Tabchef grouped or closed and which rule did it;
  - your projects, tab ages and the working state of the rules;
  - cached pull request and ticket state;
  - connection tokens for GitHub and Jira.
- **Backups** you export are files on your computer. They hold your settings and rules, never tokens.

## What leaves your browser

Nothing, unless you connect GitHub or Jira yourself:

- **GitHub.** When you connect GitHub (by signing in through the Tabchef GitHub App or with a personal access token),
  Tabchef asks GitHub's API for the state of the pull requests in your open tabs: the owner, repository and number
  of each, and searches for pull requests that mention the Jira keys of your projects. The GitHub App has read-only
  access to pull requests and repository metadata.
- **Jira.** When you connect Jira (with an API token, or with the Jira session already signed in to in your browser),
  Tabchef asks your Jira site, or Atlassian's API for it, for the status and summary of the tickets whose keys appear
  in your open tabs.

These requests go straight from your browser to GitHub or Atlassian, under their privacy policies. Tabchef sends no
other data with them. Your tokens are sent only to the service they belong to.

## What Tabchef does not do

- No analytics, telemetry, advertising or tracking.
- No developer servers: nothing is sent to the developer.
- No selling or sharing of data, and no use of data for anything other than managing your tabs.
- No remote code: recipes and rules are data read by the extension's own bundled code.

## Your choices

- Turn any recipe or rule off, or pause Tabchef, from its popup and options page.
- Disconnect GitHub or Jira on the options page's Connections page: Tabchef deletes the tokens it stored.
- Revoke site access or optional permissions on Chrome's extension details page.
- Uninstalling Tabchef deletes everything it stored in this browser.

## Permissions

| Permission | Why |
|---|---|
| `tabs`, `tabGroups` | Read tab addresses and titles, and group, move and close tabs. |
| `storage` | Keep your settings, history, projects, caches and tokens as described above. |
| `contextMenus` | Right-click items such as "Why is this tab here?" and "Add to project". |
| `alarms` | Re-check time-based rules, run delayed closes and refresh cached state. |
| `webNavigation` | Notice navigations early, so duplicates close before the page loads. |
| `notifications` (optional) | Ask before closing a duplicate or a tab with unsaved input, if you turn notifications on. |
| `scripting` (optional) | Run Tabchef's own page script on sites you allow, as described above. |
| `sidePanel` | Show your projects in Chrome's side panel. |
| Site access (optional) | Asked for one site at a time, only for features that read pages or use a connection. |

## Children

Tabchef is a general-purpose tool and is not directed at children.

## Changes

Changes to this policy are made in this file; its history is public at
https://github.com/ecoutu/tabchef/commits/main/PRIVACY.md. A change that sends any new kind of data off your device
would be called out in the release notes.

## Contact

Questions: open an issue at https://github.com/ecoutu/tabchef/issues.
