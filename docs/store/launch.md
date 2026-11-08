# Launch copy

Taglines and the launch posts, from the launch kit (https://claude.ai/artifact/RF913qNnKxbSjjQqTaFTVe), updated for
1.1: merged pull requests and Jira ticket projects have shipped, so they are features here, not "coming next". The
store listing itself is in [listing.md](listing.md). `npm run check:terms` checks this file too, and the sections
headed "(max N characters)" against their limits.

Post the launch posts only once the listing is live ([#55](https://github.com/ecoutu/tabchef/issues/55); the repository is already public). Replace
`[Web Store link]` with the listing's address: `https://chromewebstore.google.com/detail/dpahpabicobmcinpamlkpmeeagnalheg`
redirects to it, and the dashboard shows the final URL once the item is published.

## Taglines

| Use | Tagline |
|---|---|
| Brand: tiles, social, headlines | Recipes for your tabs. |
| Plain: if the name leaves cooking behind | Rules for your tabs. |
| Benefit | Tabs that tidy themselves. |
| Position: marquee tile, README, Show HN | The tab manager that understands your dev workflow. |

Use the brand line where the group / de-duplicate / close chips explain it. Use "rules" in the summary and the
description, which people read to decide whether to install.

## Show HN title (max 80 characters)

Show HN: Tabchef – rule-based tab grouping and de-duplication for Chrome

## Show HN text

I ran two tab extensions that kept fighting: one grouped GitHub tabs by repo, the other closed duplicates. Neither knew that a pull request's Files tab and its Conversation tab are the same page to me. So I wrote one extension that does both, from one set of rules.

Rules match on URL patterns (a glob Tabchef compiles to the browser's URLPattern), page titles and, on sites you allow, page text, and act by grouping, de-duplicating or closing. Rules ship in recipes, which are plain YAML data with no code in them, so you can read exactly what a recipe will do before you turn it on.

It also knows about the work around a tab. Connect GitHub and the Merged tab lists pull requests that have merged so you can close them. Turn on a Jira ticket recipe and a ticket's tab is grouped with the pull requests that name its key in their title or branch.

Things I cared about:
- De-duplication always closes the new tab, never the one you were using.
- Nothing with unsaved form input gets closed without asking.
- Group order in the tab bar matches the order in your settings.
- Every settings change goes through a preview first, and "Why is this tab here?" names the rule behind any tab.
- No servers and no analytics. GitHub and Jira are asked directly from your browser, and tokens stay in it.

I'd like feedback on the rule language (the guide: https://github.com/ecoutu/tabchef/blob/main/docs/recipes.md) and on which recipes you'd want built in. There's an issue form for recipe ideas.

[Web Store link] · https://github.com/ecoutu/tabchef

## Social post (max 280 characters)

Tabchef is out for Chrome. It groups tabs by repo, closes the duplicate when you open a PR twice, cleans up OAuth callbacks and ended Meet calls, and groups a Jira ticket with its PRs. Recipes are plain YAML you can read before you turn them on.

## README hero

A real rule, trimmed from the shipped `src/recipes/builtin/github-prs.yaml` (which also sets `enabled: false` and
`merge: true`). Showing the actual rule is the strongest pitch for "rules you can read".

```yaml
recipe: github-prs
name: GitHub pull requests
rules:
  - id: group-by-repo
    name: Group GitHub tabs by repository
    match:
      url: 'github.com/acme/:repo*'
    actions:
      - group:
          title: '{repo}'
          color: grey
```

## Where to post

1. Show HN, on a weekday morning US time. Stay in the thread for the first few hours to answer questions.
2. The social post, with the marquee tile as the image.
3. Optional, a few days later: r/chrome_extensions and r/programming's weekly self-promotion thread, with the same
   text as the social post.
