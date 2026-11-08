# GitHub App listing

The copy for the Tabchef GitHub App's public page, what the app may do and why, and the values for each field of its
settings page (https://github.com/settings/apps/tabchef). [listing.md](listing.md) is the same for the Chrome Web
Store; [PRIVACY.md](../../PRIVACY.md) is the privacy policy both point to.

Tabchef signs in to GitHub through this app with the OAuth device flow. The app's public client id,
`Iv23liQTWp7D0YtIccKH`, is in `src/core/project.json` (`githubAppClientId`); replacing the app is one edit there plus
a release. The app has no client secret in Tabchef, no server and no webhook: the extension talks to GitHub straight
from the user's browser.

Facts the repository can't confirm, because they live only in the app's settings, are marked **(verify on the app
settings page)**. Making the app installable by any account is [#51](https://github.com/ecoutu/tabchef/issues/51).

## Name

Tabchef

Keep it the same as the extension's name (`name` in `terms.json`). A rename ([#46](https://github.com/ecoutu/tabchef/issues/46)) renames the app too, and changes
its public address, which follows the name: https://github.com/apps/tabchef (verify on the app settings page).

## Short description

Lets the Tabchef Chrome extension read the state of your pull requests, so it can close merged ones and group them
with their Jira tickets.

## Description

The text for the app's **Description** field, shown on its public page.

Tabchef is a Chrome extension that groups, de-duplicates and closes your tabs with recipes. This app lets Tabchef
read the pull requests in your open tabs from GitHub's API.

WHAT IT DOES
- Merged PRs: lists your open pull request tabs that have merged, so you can close them in one click, or have them
  close on their own.
- Jira ticket projects: finds the pull requests that name a Jira ticket's key in their title or branch, and shows
  them with the ticket.

PERMISSIONS
Read-only access to pull requests and repository metadata. Tabchef never writes to GitHub.

PRIVACY
Tabchef has no servers. Requests go straight from your browser to GitHub, and your token stays in your browser.
Privacy policy: https://github.com/ecoutu/tabchef/blob/main/PRIVACY.md

SIGN IN
In Tabchef's options, open Connections and click Connect GitHub, then enter the code it shows at
https://github.com/login/device. Install the app on the accounts and organizations whose repositories you want
Tabchef to read.

Source and issues: https://github.com/ecoutu/tabchef

## What Tabchef uses the app for

Only while the user has connected GitHub on the Connections page. Without a connection, the same recipes read a pull
request's state and branch from its open page on github.com, when the user grants that site.

| Feature | Recipe | What it asks GitHub |
|---|---|---|
| Merged pull requests: the popup's Merged tab, and closing merged pull request tabs on their own | Merged PRs | The state of each pull request open in a tab |
| A pull request's branch, to match it to a Jira key | Jira ticket projects (PR branch), Jira ticket projects (PR title or branch) | The same pull request state, which includes the branch |
| A Jira ticket's linked pull requests (Projects page and side panel) | The Jira ticket projects recipes | A search for pull requests naming the ticket's key |
| The account shown on the Connections page | none | Who the token belongs to |

Grouping tabs by repository (the GitHub pull requests recipe) reads only tab addresses and never calls GitHub.

## Permissions

The device flow sends no `scope`: a GitHub App's user token gets the permissions set on the app, limited to the
repositories the app is installed on and the user can see. The minimum the code needs is below; the app is meant to
have exactly these (verify on the app settings page).

| Permission | Access | Why |
|---|---|---|
| Repository → Pull requests | Read-only | Read a pull request's state, whether it merged and when, draft flag, title, branch, review decision and address; and search pull requests by Jira key. |
| Repository → Metadata | Read-only | Required by GitHub for every app. Lets the API resolve the repository of each pull request and of each search result. |
| Every other repository permission | No access | Not used. |
| Organization permissions | No access | Not used. |
| Account permissions | No access | Not used. `GET /user` returns the signed-in login without any account permission. |

Tabchef never writes: it sends only `GET /user` and GraphQL queries, never a mutation.

## Events and webhooks

None. Tabchef has no server to receive them, so **Webhook → Active** is off and the app subscribes to no events
(verify on the app settings page). Tabchef refreshes pull request state on its own schedule instead: a pull request
is looked up again after 5 minutes (never again once merged), a Jira key's search after 15 minutes.

## Requests and data

Every request goes from the browser to `github.com` or `api.github.com` only, over https, without cookies, and with a
15-second timeout. Tabchef needs the user to grant it access to both sites first; it asks when Connect GitHub is
clicked.

| Request | Sent | Kept |
|---|---|---|
| `POST https://github.com/login/device/code` | The client id | A one-time device code, in session storage until the sign-in ends |
| `POST https://github.com/login/oauth/access_token` | The client id, and the device code or the refresh token | The tokens (see below) |
| `GET https://api.github.com/user` | The token | The login, shown as "Signed in as …" |
| `POST https://api.github.com/graphql`, pull request state | Owner, repository and number of the pull requests in open tabs, up to 50 per query | State, merged time, draft flag, title, branch, review decision, address |
| `POST https://api.github.com/graphql`, linked pull requests | Up to 10 Jira keys per query, each searched in pull request titles and branch names, within the organizations of the project's open pull request tabs and the recipe's organization list, or else among pull requests involving the user | Number, title, address, state, merged time, branch, repository owner and name of each match |

Search text travels only in GraphQL variables; the query text is fixed. Pull request results are cached in the
browser's local storage, are never synced and are never in backups. Nothing is sent to the developer; Tabchef has no
servers and no analytics.

## Tokens

- **Sign-in:** the OAuth device flow, with the client id only. Tabchef shows the user code on the Connections page
  with a link to https://github.com/login/device, and polls GitHub at the interval GitHub gives (slower when GitHub
  answers `slow_down`) while that page is open. The code expires when GitHub says (15 minutes when it doesn't); the
  user can cancel at any time.
- **Expiring tokens** (the app's "Expire user authorization tokens" setting, meant to be on; verify on the app
  settings page): the access token is kept in the browser's session storage, which Chrome clears when the browser
  closes, and the refresh token in local storage. An access token is refreshed a minute before it expires, or after a
  401, with the client id and the refresh token only; one refresh runs at a time, and the new refresh token GitHub
  returns replaces the old one. If GitHub rejects the refresh token, or it has expired, the Connections page asks the
  user to sign in to GitHub again.
- **Non-expiring tokens** (that setting off): the single token is kept in local storage, and refreshing is skipped.
- **Storage:** where Chrome supports it, local storage is restricted to the extension's own pages and service
  worker, so content scripts can't read it. Tokens are never synced, never exported in backups, never logged, and removed from every error message.
- **No client secret.** The device flow and the refresh work without one, so the app's client secret is never put
  in the extension. A private key isn't needed either.

## Installing

1. In Tabchef's options, open the Connections page and click **Connect GitHub**, then allow access to github.com
   and api.github.com.
2. Enter the code shown at https://github.com/login/device and authorize Tabchef.
3. Install the app on the accounts whose repositories Tabchef should read: https://github.com/apps/tabchef → Install
   (verify on the app settings page). Signing in alone authorizes the app; it reads only repositories where it is
   also installed.

Organizations:
- A member who isn't an owner can request the installation; an organization owner approves it.
- An organization with SAML single sign-on may also need the sign-in authorized for it. When GitHub reports that, the
  Connections page shows a link to authorize Tabchef for that organization.
- Repositories Tabchef can't read are listed on the Connections page, with what to do next. For those, Tabchef
  falls back to reading the open pull request page.

Until [#51](https://github.com/ecoutu/tabchef/issues/51) is done, only the account that owns the app can install it, so other people use a personal
access token.

## Personal access token instead

Connections → **Use a personal access token instead**. Tabchef checks the token with `GET /user` before it stores it,
and stores nothing if GitHub rejects it.

- **Fine-grained token (recommended):** choose the repositories, then Repository permissions → Pull requests:
  Read-only. GitHub adds Metadata: Read-only on its own.
- **Classic token:** the `repo` scope, which also grants write access. Tabchef only reads.

The token is kept like a non-expiring app token: in local storage, never synced or exported. It doesn't need the app
to be installed.

## Disconnecting and revoking

- **Disconnect** (Connections page) deletes the tokens Tabchef stored and signs out of GitHub in Tabchef. It does
  not revoke the authorization on GitHub.
- **Revoke on GitHub** opens https://github.com/settings/applications, where the user revokes Tabchef under
  Authorized GitHub Apps. A personal access token is revoked from the token settings on GitHub.
- To stop the app reading an account's repositories, uninstall it from that account's installed apps settings
  (https://github.com/settings/installations, or the organization's settings).
- Removing the extension's access to github.com and api.github.com in Chrome stops every request; the Connections
  page then offers **Grant access**.

## URLs

- **Homepage URL:** https://github.com/ecoutu/tabchef
- **Support:** https://github.com/ecoutu/tabchef/issues
- **Privacy policy:** https://github.com/ecoutu/tabchef/blob/main/PRIVACY.md
- **Public page:** https://github.com/apps/tabchef (verify on the app settings page)

The homepage and privacy policy URLs open for anyone only once the repository is public ([#50](https://github.com/ecoutu/tabchef/issues/50)).

## App settings checklist

The fields of https://github.com/settings/apps/tabchef, top to bottom.

- [ ] **GitHub App name:** Tabchef.
- [ ] **Description:** the Description above.
- [ ] **Homepage URL:** https://github.com/ecoutu/tabchef.
- [ ] **Callback URL:** none. Tabchef signs in with the device flow and never redirects back.
- [ ] **Expire user authorization tokens:** on. Tabchef refreshes them; off works too, with long-lived tokens.
- [ ] **Request user authorization (OAuth) during installation:** off.
- [ ] **Enable Device Flow:** on. Sign-in fails without it.
- [ ] **Setup URL:** none.
- [ ] **Webhook → Active:** off; no webhook URL or secret.
- [ ] **Permissions:** Repository → Pull requests: Read-only and Metadata: Read-only; every other permission: No access.
- [ ] **Subscribe to events:** none.
- [ ] **Where can this GitHub App be installed?** Any account ([#51](https://github.com/ecoutu/tabchef/issues/51)).
- [ ] **Client secrets:** none needed; never put one in the extension or the repository.
- [ ] **Private keys:** none needed by Tabchef.
- [ ] **Display information:** the extension icon (`public/icon/128.png`, final icon from [#47](https://github.com/ecoutu/tabchef/issues/47)) as the logo.
- [ ] The **Client ID** matches `githubAppClientId` in `src/core/project.json`.
- [ ] Sign in from a second GitHub account and read one of its pull requests.

## GitHub Marketplace

Not listed. The app is free and the public page above is enough to install it. A Marketplace listing would reuse the
name, short description and description above, and needs the app to be public first.
