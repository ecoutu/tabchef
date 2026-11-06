# Recipes and rules

This guide is for people who want to change what Tabchef does with their tabs or write rules of their own. It covers
what a rule is made of, how recipes work, how group titles are built, and what each recipe can do with the access
you give it. The worked examples at the end come straight from the built-in recipes.

Everything here is set up on the options page: right-click the Tabchef icon and choose **Options**. Its pages are
Rules, Recipes, Duplicates, History, Backups, Import and Connections.

## What a rule is

A rule says which tabs it applies to and what to do with them. Every rule has:

- `id`: a short name made of lowercase letters, digits, `-` and `_`.
- `name`: what the Rules page shows.
- `enabled`: `true` or `false`.
- `match`: the condition a tab must meet.
- `actions`: one or more things to do with a matching tab.

It can also have `extract` (values to pull out of the tab for the group title) and `dryRun: true` (History logs what
the rule would do, and no tab is touched).

On the Rules page, **Add rule** starts a rule in a form with the common fields: URL patterns, a title pattern, the group,
**Duplicates**, **Close tabs** and **Dry run**. The **YAML** button shows the same rule as YAML, where every part
of the rule language is available. A rule the form cannot show opens as a summary with **Edit in YAML**. Right-click a
page and choose **Group pages like this under…** or **Auto-close pages like this** to start a rule from that page's
address.

A rule in YAML looks like this:

<!-- user-rule -->
```yaml
id: docs
name: Docs sites
enabled: true
match:
  any:
    - url: '*.readthedocs.io/*'
    - url: 'docs.python.org/*'
actions:
  - group:
      title: Docs
      color: cyan
      collapsed: true
```

### Match: which tabs a rule applies to

`match` holds exactly one condition. Combine several with `all`, `any` and `not`.

| Condition | Matches when |
| --- | --- |
| `url: <pattern>` or `url: [<pattern>, ...]` | the tab's URL matches the pattern, or any pattern in the list |
| `title: <pattern>` | the tab's title matches |
| `opener: <condition>` | the tab that opened this tab meets the condition |
| `group: <title>` | the tab is in a tab group with exactly this title |
| `pinned: true` / `pinned: false` | the tab is pinned, or not |
| `audible: true` / `audible: false` | the tab is playing sound, or not |
| `age: {gt: 2h}`, `age: {lt: 10m}` | the tab was opened more than, or less than, that long ago |
| `pageText: <text>` or `pageText: [<text>, ...]` | the page shows this text (or any text in the list) |
| `all: [...]`, `any: [...]`, `not: <condition>` | every condition, any condition, or not the condition |

Durations are a whole number and a unit: `500ms`, `30s`, `15m`, `2h` or `1d`.

**URL patterns.** A URL pattern is a glob over the whole address, host and path together. Tabchef turns each glob into
the browser's URLPattern to match it, but you write Tabchef's glob, not raw URLPattern syntax:

- `*` matches any run of characters, including `/`, `?` and `#`. `github.com/*` matches every page on github.com.
- `:name` at the start of a path segment matches one segment and captures it under that name.
  `github.com/:owner/:repo*` captures `owner` and `repo` from `https://github.com/acme/web/pull/7`.
- `*.example.com` matches example.com and any of its subdomains.
- With no scheme, a pattern matches both `http://` and `https://`. `*://` means the same. Write a scheme, such as
  `chrome://`, to match only that one.
- `localhost:*` matches any port.
- Matching ignores case.
- A pattern between slashes is a regular expression: `/^https:\/\/(?<site>[a-z]+)\.example\.com\//`. Named groups
  (`(?<site>...)`) are captured like `:name`.
- Globs cannot use `( )` or `{ }`, and `:name` does not work in the host. Use a regular expression for those.
- A pattern can be at most 500 characters.

The rule form shows how many open tabs the URL patterns match as you type.

**Title patterns** are simpler: `*` matches anything, the pattern must match the whole title, and case is ignored.
`*Inbox*` matches any title that contains Inbox. A title pattern between slashes is a regular expression, and its
named groups are captured too.

**Page text** is a plain substring test that ignores case and treats curly quotes as straight ones. Tabchef can only
read the text of pages on sites you have given it access to, so a `pageText` condition stays false elsewhere.

### Extract: values for the group title

`extract` names values to pull out of a tab. Each one can be used in a group title as `{name}`, next to the values the
patterns capture.

<!-- user-rule -->
```yaml
id: tickets
name: Support tickets
enabled: true
match:
  url: 'support.example.com/tickets/*'
extract:
  team: {from: title, regex: '^\[(?<team>[^\]]+)\]', group: team}
actions:
  - group:
      title: 'Tickets · {team}'
      color: orange
```

- `{from: url, regex: ...}` or `{from: title, regex: ...}` runs the regular expression on the URL or the title. The value
  is the group named by `group` (a name or a number), else the first group, else the whole match.
- `{selector: 'h1'}` reads the text of the first element the CSS selector finds on the page, and `attr` reads one of
  its attributes instead. Like `pageText`, this needs access to the site.

The built-in recipes also use `jiraKey` (finds a Jira issue key in the URL, the title or a value from a connection)
and `adapter` (a value Tabchef reads from a GitHub pull request page or a Jira issue page).

### Actions: what a rule does

| Action | What it does |
| --- | --- |
| `group` | puts the tab in a tab group |
| `dedupe` | sets how duplicates of the tab are handled: `mode: always-switch`, `ask` or `off`. In the form this is the **Duplicates** field; with **Use the Duplicates page setting**, the **Mode** on the Duplicates page applies. |
| `close` | closes the tab, or lists it in the popup's Finished tab for you to close |
| `showInView` | lists the tab in a recipe's popup tab (built-in recipes) |
| `assignProject` | makes the tab part of a project (recipe rules only, see below) |

**Group** takes:

- `title`: the group's name. It can contain `{name}` values, described in
  [Group titles and colors](#group-titles-and-colors).
- `color`: `grey`, `blue`, `red`, `yellow`, `green`, `pink`, `purple`, `cyan` or `orange`, or a `{name}` value that
  gives one of them. A value that gives anything else falls back to grey.
- `collapsed`: create the group collapsed. Expanding it yourself is left alone.
- `sortGroups`: when one rule makes several groups, order them by `creation` (the default) or `alphabetical` title.
- `strict`: on by default. A grouped tab that moves to a URL the rule no longer matches leaves the group. With
  `strict: false` it stays.
- `merge`: keep one group across windows. Matching tabs in other windows move to the window that has the group.
- `anchors`: URLs Tabchef opens inside the group when it creates the group, so a group can start with a dashboard or
  an inbox.

Pinned tabs and browser pages such as `chrome://` and `file://` are never grouped.

**Close** takes `after` (how long after the page loads; leave it out to close as soon as the tab matches) and `mode`:
`auto` closes the tab, and you can undo it, while `suggest` only lists it in the popup's Finished tab. Tabs you are
using, pinned or locked tabs, and tabs with unsaved form edits are never closed automatically.

**Assign to a project** (`assignProject`) is for recipes that collect related tabs into one project per key, such as
one per Jira ticket. The tab joins the project named by `key`, else the one named by `fallbackKey`, and `create: true`
lets it start a new project. Projects show in the popup's Projects tab and in the side panel. Only
recipe rules can assign projects.

### Priority order and sections

The Rules page lists your own rules and the rules of the recipes you turned on, in one list. **Order is priority.** For
each kind of action, the first rule in the list that matches a tab wins. One rule can decide a tab's group while a
rule further down decides whether it closes. If the winning group rule's title comes out empty for a tab, the next
matching group rule is tried. Groups also appear in the tab bar in this order.

Drag a rule's handle, or use its up and down buttons, to change the order. When you turn on a recipe, its rules are
added after your own. Consecutive rules of one recipe sit under one header that moves them together.

**New section** names a section, and a rule's **Section** menu puts it there. A section collapses and moves as one
block. Sections only organize the Rules page: order is still priority.

**Test against my open tabs** shows how many open tabs a rule would move or close, and History lists what each rule
did. For any open tab, **Why is this tab here?** in its right-click menu shows which rules matched it.

## Recipes

A recipe is a set of rules you turn on with one switch. The built-in recipes are Duplicates, GitHub pull requests,
Finished, Merged PRs, three Jira ticket projects variants (PR title, PR branch, or PR title or branch), and Manual
projects, which has no rules: it lets you create a named project ("Add to project › New project…" on a tab, or New
project on the Projects page) and add tabs to it by hand.

### Turning one on

On the Recipes page, each recipe has a card with its description, the status of each of its rules, and its settings.
**Enable** asks Chrome for any site access the recipe needs, then shows what it would do to your open tabs before it
turns on. If you turn down access that only one rule needs, the recipe still turns on and that rule shows as paused, for example
"Paused: needs access to meet.google.com". **Disable** turns it off again.

Only one of the three Jira ticket projects recipes can be on at a time. Enabling one turns the others off.

### Params

A recipe's settings on its card are its params: the patterns, texts, delays and choices its rules use. Change them and
click **Save settings**; the change is previewed against your open tabs first. Each setting's **?** explains it.

Inside a recipe, a rule refers to a param as `{params.<name>}`. A list param, such as Finished's OAuth callback URL
patterns, fills the whole list. Finished's redirect rule has an empty list by default, so it does nothing until you add
patterns; the Rules page marks it as inactive.

### Recipe rules are read-only

You cannot edit a recipe's rules, but on the Rules page you can:

- move them anywhere in the priority order;
- turn one rule off (or back on) with its **On** checkbox without turning off the whole recipe;
- test them against your open tabs;
- **Customize**: copy the rule, with your params filled in, into a rule of your own named "… (custom)". The copy is
  placed just above the original, so it wins, and you can edit it like any of your rules. **Edit copy** takes you back
  to it later.

Some parts of the rule language work only inside recipes: `needs`, `source` (data read from GitHub or Jira) and
`assignProject`. Customize leaves out `needs`. A copy that keeps `source` or `assignProject` reports an error instead
of running, so remove them from your copy.

## Group titles and colors

A group title is text with `{name}` placeholders. Each placeholder is filled from:

- a `:name` captured by a URL pattern;
- a named group in a URL or title regular expression;
- an `extract` of the rule.

So `url: 'github.com/:owner/:repo*'` with `title: '{repo}'` makes one group per repository. A name that has no value for
a tab is filled with nothing, and Tabchef checks when you save that each name you use can be filled. With a single
`url` condition, every pattern in its list must capture the name.

**Filters** change a value. Add them after a `|`, and chain as many as you like, left to right:

| Filter | Result |
| --- | --- |
| `{repo\|upper}` | `WEB` |
| `{repo\|lower}` | `web` |
| `{name\|trim}` | the value without spaces at either end |
| `{repo\|replace:-: }` | every `-` replaced by a space (plain text, not a regular expression; an empty replacement deletes) |
| `{repo\|map:repoColors}` | the value looked up in the table `repoColors`; empty when the table has no entry |
| `{team\|default:Other}` | `Other` when the value is empty |

Filter arguments are separated by `:`. Write `\:`, `\|` or `\}` for those characters inside an argument.

**Lookup tables** map values to other values, most often to colors. A rule can use them in its color:

<!-- user-config -->
```json
{
  "tables": {
    "repoColors": { "web": "blue", "api": "green", "docs": "yellow" }
  },
  "rules": [
    {
      "id": "repos",
      "name": "Acme repositories",
      "enabled": true,
      "match": { "url": "github.com/acme/:repo*" },
      "actions": [
        { "group": { "title": "{repo}", "color": "{repo|lower|map:repoColors|default:grey}" } }
      ]
    }
  ]
}
```

Tables live in your config, next to your rules. To add one, click **Export current config as JSON** on the Backups page,
add a `tables` entry to the file, and import it with **Import JSON**. The Import page also creates a table when you
choose **Use templated rule** for a run of similar imported rules. A `map:` filter that names a table that does not
exist is an error when you save.

## Levels and connections

Some recipes do more the more access you give Tabchef. The Jira ticket projects cards on the Recipes page list their
levels, each "available" or "locked" with what it needs. Other recipes show what they need on their card and next to
each rule. **Allow access** asks Chrome for the sites a locked level needs; **Set up a connection** opens the
Connections page, where you sign in to GitHub or Jira.

- **Titles:** with no extra access, Tabchef sees each tab's URL and title. Grouping, Duplicates, Finished's OAuth and
  redirect rules, and GitHub pull requests all work from these alone.
- **Page details:** with access to a site, Tabchef can read text and details on its pages: Finished's Meet rule reads
  "You left the meeting", Merged PRs reads a pull request's state from its page, and the Jira recipes read a ticket's
  status from the ticket's own page.
- **Connections:** with GitHub or Jira connected, Tabchef asks those services directly for the state of the pull
  requests and tickets in your open tabs.

What each recipe needs:

| Recipe | Titles | Page details | Connections |
| --- | --- | --- | --- |
| Duplicates, GitHub pull requests | everything | | |
| Finished | OAuth and redirect rules | Meet rule (meet.google.com) | |
| Merged PRs | | listing merged pull requests (github.com) | listing them; **Close merged pull request tabs** needs the GitHub connection, since only it gives the merge time |
| Jira ticket projects (PR title) | ticket tabs and pull requests whose title names the key | ticket status from the ticket's own page | ticket status from Jira |
| Jira ticket projects (PR branch) | ticket tabs only | pull requests join by the branch on their page (github.com) | pull requests join by the branch from GitHub; ticket status from Jira |
| Jira ticket projects (PR title or branch) | ticket tabs and pull requests whose title names the key | the branch from the pull request page | the branch from GitHub; ticket status from Jira |

A rule declares what it needs with `needs`. `anyOf` lists alternatives, best first, and the rule runs at the first one
you have. An empty alternative (`{}`) means the rule also runs with titles only. When none is met, the rule is paused,
and its status says what it is waiting for.

## Worked examples

These excerpts are copied from the built-in recipes in
[src/recipes/builtin](../src/recipes/builtin). A test compares each one with the recipe it comes from, so they stay
exact.

### 1. One group per GitHub repository

From GitHub pull requests. This rule is off by default: turn it on with its **On** checkbox on the Rules page.

<!-- example: github-prs/group-by-repo -->
```yaml
id: group-by-repo
name: Group GitHub tabs by repository
enabled: false
match:
  url: 'github.com/:owner/:repo*'
actions:
  - group:
      title: '{repo}'
      color: grey
      merge: true
```

The pattern captures `owner` and `repo` from any github.com address with at least two path segments, and the title uses
`repo`, so `github.com/acme/web/pull/7` and `github.com/acme/web/issues` share the group "web". `merge: true` keeps one
"web" group across all your windows. To color each repository differently, Customize it and use a lookup table in the
copy's color.

### 2. Close a Meet tab when the call ends

From Finished. The rule reads page text, so it needs access to meet.google.com.

<!-- example: finished/meet-ended -->
```yaml
id: meet-ended
name: Close Meet tabs after the call ends
enabled: true
needs:
  hosts: ['https://meet.google.com/*']
trigger:
  on: [pageText]
match:
  all:
    - url: 'meet.google.com/*'
    - pageText: '{params.meetEndedTexts}'
actions:
  - close:
      after: 2s
      mode: '{params.mode}'
```

`pageText` is filled from the recipe's params, so the texts are a setting on the Finished card:

<!-- example: finished -->
```yaml
params:
  meetEndedTexts:
    type: string[]
    default:
      - You left the meeting
      - You've left the call
      - The call has ended
    label: Page text that means a Meet call has ended
  mode:
    type: string
    default: auto
    enum: [auto, suggest]
```

A Meet tab matches once it shows any of these texts. With **Close automatically or suggest in the Finished list** set
to `suggest`, the tab is listed in the popup's Finished tab instead of closing.

### 3. Join a pull request to its Jira ticket by branch name

From Jira ticket projects (PR branch). The recipe makes one project per Jira issue key, shown as a tab group:

<!-- example: jira-ticket-branch -->
```yaml
project: {key: '{key}', title: '{params.titleFormat}', color: '{params.color}', container: group, join: [rules, manual]}
levels:
  - {id: titles, label: Titles, rules: [ticket]}
  - {id: page, label: Page details, rules: [ticket, pr]}
  - {id: connections, label: Connections, rules: [ticket, pr]}
```

Its ticket rule starts a project for each Jira ticket tab, with the key taken from the URL. This rule adds pull requests:

<!-- example: jira-ticket-branch/pr -->
```yaml
id: pr
name: PR by branch
enabled: true
needs:
  anyOf:
    - connections: [github]
    - hosts: ['https://github.com/*']
source:
  connection: github
  query: github.pull_request
  args: {owner: '{owner}', repo: '{repo}', number: '{num}'}
  fields: {headRefName: headRefName, state: state}
  fallback: {adapter: github.prPage}
match:
  url: 'github.com/:owner/:repo/pull/:num*'
extract:
  key: {from: source.headRefName, jiraKey: {pattern: '{params.keyPattern}', allow: '{params.projectPrefixes}', ignore: '{params.ignoredPrefixes}'}}
actions:
  - assignProject: {key: '{key}'}
```

Step by step:

1. `match` captures `owner`, `repo` and `num` from the pull request's address.
2. `source` asks the GitHub connection for that pull request, using the captures as `args`, and keeps its branch as
   `source.headRefName`. Without the connection, `fallback` reads the branch from the pull request page.
3. `extract` finds a Jira key such as `ABC-123` in the branch name, using the recipe's **Issue key pattern**, **Your
   Jira project keys** and **Prefixes that are never keys** settings.
4. `assignProject` puts the pull request in that key's project. It has no `create: true`, so it joins a project
   that exists, or starts one only when the key's prefix is confirmed: listed in **Your Jira project keys**, or known
   from a ticket the Jira connection answered for.
5. `needs` lists the GitHub connection first and github.com access second. With neither, the rule is paused, which is
   why the Titles level lists only the ticket rule.
