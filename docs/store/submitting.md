# Submitting to the Chrome Web Store

The first submission is manual (spec §11.1). After it, semantic-release publishes each release automatically
([#53](https://github.com/ecoutu/tabchef/issues/53)). The copy for every dashboard field is in [listing.md](listing.md); the launch posts are in
[launch.md](launch.md). The milestone **M5** on GitHub tracks all of it.

## 0. Before you start

Each of these has an issue in M5. The submission needs all of them.

- [ ] The product name is final ([#46](https://github.com/ecoutu/tabchef/issues/46)). The name is hard to change after launch: the listing, the icon, the
      tiles and the GitHub App all carry it.
- [ ] The final icon is in `public/icon/` ([#47](https://github.com/ecoutu/tabchef/issues/47)), and the screenshots and promo tiles are in
      `docs/store/images/` ([#48](https://github.com/ecoutu/tabchef/issues/48)).
- [ ] The repository is public ([#50](https://github.com/ecoutu/tabchef/issues/50)), so the privacy policy, homepage and support URLs open for anyone.
- [ ] The Tabchef GitHub App can be installed on any account ([#51](https://github.com/ecoutu/tabchef/issues/51)), so other people can sign in through
      it.
- [ ] A GitHub release with the zip exists for the version you upload (`tabchef-<version>-chrome.zip`).

## 1. Register as a Chrome Web Store developer (once)

**Choose the publisher account first.** The listing, its users, its reviews and its item ID belong to the Google
account that publishes it, not to the GitHub repository. Moving the repository later is cheap (GitHub redirects the
old links), but moving a published item to another developer account means asking Chrome Web Store support.
Publishing it again as a new item loses every user. Tabchef is published from the maintainer's personal Google account
as an individual. If a company should own it one day, decide that before this step.

1. Sign in to the Google account that will own the listing. Turn on 2-Step Verification for it first: the dashboard
   requires it.
2. Open the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), accept the developer agreement and
   pay the one-time registration fee.
3. Account section: set the publisher (display) name, then add and verify a contact email. Items can't be published
   until the email is verified. The contact email is public on the listing, so use an address you can redirect later,
   such as a forwarding alias, rather than your main inbox.
4. Account section: answer the trader declaration (EU Digital Services Act). A free extension made by one person
   with no business behind it is normally "non-trader"; a trader's address and phone number are shown on the listing.

## 2. Create the item

1. Download `tabchef-<version>-chrome.zip` from the latest GitHub release, or build it with `npm ci && npm run zip`
   (it lands in `.output/`). Always upload a zip built from a released commit, so the version in the store matches a
   tag.
2. Dashboard → **New item** → upload the zip. The dashboard reads the name, summary, version, icon and permissions
   from the manifest inside it.
3. Write down the item ID from the item's URL (32 letters). Automated publishing needs it ([#53](https://github.com/ecoutu/tabchef/issues/53)).

## 3. Store listing section

Copy each field from [listing.md](listing.md):

1. **Description:** the Description section, as plain text. The store keeps line breaks but no formatting.
2. **Category** and **Language:** the Category and language section.
3. **Graphic assets:** upload the store icon, the five screenshots in order, the small promo tile and the marquee
   tile from the Graphic assets table.
4. **Additional fields:** homepage and support URLs. Leave the "official URL" empty unless a domain is verified in
   Google Search Console.
5. Save the draft.

## 4. Privacy practices section

1. **Single purpose:** paste the Single purpose section.
2. **Permission justifications:** paste each permission's text. The dashboard lists only the permissions in the
   uploaded manifest; skip any it doesn't ask for.
3. **Remote code:** "No, I am not using remote code."
4. **Data usage:** tick the boxes as the Data usage section says, and certify the three statements.
5. **Privacy policy URL:** `https://github.com/ecoutu/tabchef/blob/main/PRIVACY.md`. Open it in a private window
   first to check it loads without a GitHub login.

## 5. Distribution section

1. **Payments:** free.
2. **Visibility:** choose one.
   - **Unlisted** for a soft launch: only people with the link can install, and the listing doesn't show in search.
     Switch to Public later in this section.
   - **Public** to launch right away.
3. **Regions:** all regions.

## 6. Test instructions section

Paste the Test instructions section of [listing.md](listing.md), after walking through the steps on the build you
uploaded. It tells the reviewer which features need an account.

## 7. Submit for review

1. Click **Submit for review**. Untick "publish automatically after approval" if you want to pick the launch day
   yourself (you then have 30 days to publish).
2. Expect a few days. Optional host access to all sites (`https://*/*`) can make the review take longer, even
   though nothing is granted at install.
3. A rejection email names the policy and usually the permission. The common fixes are a clearer justification or
   single purpose; change the text in [listing.md](listing.md) too, so the next submission starts from it.

## 8. After it's live

1. Note the listing URL: `https://chromewebstore.google.com/detail/<item id>`.
2. Add the install link to the README and to the repository's About section.
3. Post the launch copy ([#55](https://github.com/ecoutu/tabchef/issues/55)).
4. Set up automated publishing ([#53](https://github.com/ecoutu/tabchef/issues/53)) so the next release ships without these steps.

## Later releases (automated)

Once [#53](https://github.com/ecoutu/tabchef/issues/53) is done, merging to `main` is the whole process: semantic-release cuts the version and the
GitHub release, then uploads the zip to the store and submits it for review. To do it by hand instead: upload the
new zip under **Package** → **Upload new package**, then **Submit for review**. A version must be higher than the
published one.

Re-check [listing.md](listing.md) when a release adds a permission: the dashboard asks for its justification. A
required permission that adds an install warning also disables the extension for existing users until they accept
it, so prefer optional permissions asked for at runtime.
