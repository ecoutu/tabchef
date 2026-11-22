# Launch copy

Taglines, the launch posts and the plan for posting them, from the launch kit
(https://claude.ai/artifact/RF913qNnKxbSjjQqTaFTVe), updated as features ship: merged pull requests and Jira ticket
projects are features here, not "coming next". The store listing is in [store/listing.md](store/listing.md).
`npm run check:terms` checks this file too, and the sections headed "(max N characters)" against their limits.

This file is the product's announcement (Show HN and social posts). The blog post "Introducing
Tabchef" ([ecoutu.github.io#11](https://github.com/ecoutu/ecoutu.github.io/issues/11), PR
[#21](https://github.com/ecoutu/ecoutu.github.io/pull/21)) is the long version people land on from the short posts;
its publishing checklist is on that issue. Don't post the same text twice.

- Web Store: `[Web Store link]`, once the listing is live ([#52](https://github.com/ecoutu/tabchef/issues/52))
- Repo: `https://github.com/ecoutu/tabchef`
- Blog post: `https://blog.ecoutu.io/posts/introducing-tabchef/`

Post the launch posts only once the listing is live (#52; the repository is already public). Replace
`[Web Store link]` with the listing's address: `https://chromewebstore.google.com/detail/dpahpabicobmcinpamlkpmeeagnalheg`
redirects to it, and the dashboard shows the final URL once the item is published.

## Order

Announce everything once the listing is live, so people can install in one click instead of loading an unpacked zip.

1. Store listing goes live (#52).
2. The blog post goes live, its **Try it** section linking the listing first and the zip as the alternative.
3. Run the checks in **Before announcing**.
4. Show HN, on a weekday morning US time (Tue–Thu, ~8–10am ET).
5. Social posts the same day, after the Show HN is up.
6. Reddit and the other places in **Where else**, a few days later.

If the store review drags on, the blog post can go out first with the zip instructions and no promotion, and the
announcements wait.

## Before announcing

- [ ] Web Store listing live; `[Web Store link]` replaced in this file's posts and in the blog post's **Try it** section
- [ ] Blog post live and checked (its own checklist)
- [ ] Link preview: paste the blog post URL and the listing URL into a Bluesky/X/LinkedIn composer (or
      opengraph.xyz) and check the title, description and image
- [ ] README links the blog post (optional; a "Why I built it" link near the top)
- [ ] The recipe idea issue form works: `https://github.com/ecoutu/tabchef/issues/new?template=recipe_idea.yml`

## Taglines

| Use | Tagline |
|---|---|
| Brand: tiles, social, headlines | Recipes for your tabs. |
| Plain: if the name leaves cooking behind | Rules for your tabs. |
| Benefit | Tabs that tidy themselves. |
| Position: marquee tile, README, Show HN | The tab manager that understands your dev workflow. |

Use the brand line where the group / de-duplicate / close chips explain it. Use "rules" in the summary and the
description, which people read to decide whether to install.

## Summary (for anywhere that needs one)

Short (one line):

Tabchef: a Chrome extension that groups, de-duplicates and closes tabs with rules you can read and change.

Medium (newsletter blurb, profile pin, cross-post intro):

I ran two tab extensions that kept fighting, so I wrote one that does both from one set of rules. Tabchef groups tabs by repo, switches you to the tab you already have open, closes OAuth callbacks and ended Meet calls, and groups a Jira ticket with its pull requests. Rules ship as plain YAML recipes, settings changes are previewed before they move or close tabs, and there are no servers or analytics.

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

I wrote up why I built it, with screenshots: https://blog.ecoutu.io/posts/introducing-tabchef/

https://github.com/ecoutu/tabchef

## Submitting the Show HN

HN doesn't allow reading material as a Show HN, so submit the Web Store listing (or the repo) as the URL, not the
blog post. Don't also submit the blog post on its own; it would split the discussion and look like vote-farming.

## Social post (max 280 characters)

Tabchef is out for Chrome. It groups tabs by repo, closes the duplicate when you open a PR twice, cleans up OAuth callbacks and ended Meet calls, and groups a Jira ticket with its PRs. Recipes are plain YAML you can read before you turn them on.

## Posting the social post

For X and Bluesky, add the listing or the blog post link if it fits; otherwise trim. Attach the marquee tile, or let
the link preview show the image; not both.

On Mastodon and LinkedIn, post the longer version below and add hashtags where they help:
`#ChromeExtension #DevTools #OpenSource`.

## Longer social post: Mastodon, LinkedIn (max 500 characters)

Two tab extensions kept fighting over my GitHub tabs, so I wrote Tabchef, one Chrome extension that does both jobs from one set of rules.

- Groups tabs by URL, title or repo
- De-duplicates, always closing the new tab
- Closes finished tabs: OAuth callbacks, ended Meet calls
- Groups a Jira ticket with its PRs

Rules are plain YAML recipes, settings changes are previewed first, and there are no servers or analytics.

https://blog.ecoutu.io/posts/introducing-tabchef/

## README hero

An excerpt of the shipped rule in `src/recipes/builtin/github-prs.yaml`, with its list of GitHub's own pages cut down
to two. Showing the actual rule is the strongest pitch for "rules you can read". It ships turned off: its **On**
checkbox on the Rules page turns it on.

```yaml
recipe: github-prs
name: GitHub pull requests
rules:
  - id: group-by-repo
    name: Group GitHub tabs by repository
    enabled: false
    match:
      all:
        - url: 'github.com/:owner/:repo*'
        # GitHub's own pages have two path segments but are not a repository.
        - not:
            url:
              - 'github.com/settings/*'
              - 'github.com/notifications/*'
    actions:
      - group:
          title: '{repo}'
          color: grey
          merge: true
```

## Where else

One at a time, a few days after Show HN, adapting the text to each place rather than pasting:

- [ ] r/chrome_extensions: the longer social post with `docs/store/images/screenshot-2-groups.png`; link the store listing and the blog
      post.
- [ ] r/programming's weekly self-promotion thread, or r/webdev's Showoff Saturday.
- [ ] Lobsters, if someone with an invite will post it (tag `show`); link the blog post or the repo.
- [ ] dev.to / Hashnode cross-post of the blog post, with the canonical URL set to the blog so search credits it.
- [ ] Developer-tool newsletters that take submissions (Console.dev, TLDR, Changelog News): the medium summary and
      the blog post link.

## After

- [ ] Stay in the HN thread for the first few hours; answer every question.
- [ ] File what people ask for as `idea` issues; recipe requests go through the recipe idea form.
- [ ] Answer blog comments (Giscus, the Announcements category).
- [ ] Close #55 when the posting is done. (The blog's #11 closes when PR #21 merges.)
- [ ] A week later, note what drove traffic and installs (store dashboard, GitHub traffic, blog analytics) for the
      next launch.
