# [1.9.0](https://github.com/ecoutu/tabchef/compare/v1.8.0...v1.9.0) (2026-11-11)


### Bug Fixes

* **dedupe:** treat a pull request link with extra parameters as the same pull request ([9142e24](https://github.com/ecoutu/tabchef/commit/9142e249b11bf790b4e3e0887aa55ed7e50c45cd))
* **projects:** move a tab out of its project when a settings change stops its rule from matching ([0e34a7f](https://github.com/ecoutu/tabchef/commit/0e34a7f4fc0acc5a0a143a303ff2bb6fa8995d4f))
* **recipes:** look up pull requests' details as soon as a recipe that needs them is turned on ([14e2af4](https://github.com/ecoutu/tabchef/commit/14e2af49e49e07642ca1cdb94b998b043d9c1de8))
* **sources:** check statuses as often as the "check every" setting says ([bc916b5](https://github.com/ecoutu/tabchef/commit/bc916b5a8ec82d7e7122c5085bf5747a7e7d124d))
* **sources:** stop asking again every few seconds about an issue or ticket the API cannot find or read ([b3244c8](https://github.com/ecoutu/tabchef/commit/b3244c888065c1e8d633c0a22ed3d09e77003f57))
* **sources:** update an issue's, ticket's or pull request's status as soon as its page shows a change ([527f9e2](https://github.com/ecoutu/tabchef/commit/527f9e2384a7e819e718daa0277ffda353532ba4))


### Features

* **connections:** read GitHub issues and the issues a pull request closes ([9b3fbef](https://github.com/ecoutu/tabchef/commit/9b3fbef43490ab4d7eb94d60b5430dc405573a98))
* **popup:** list done projects in the Finished tab, with close, close-and-archive and keep ([a251d46](https://github.com/ecoutu/tabchef/commit/a251d46bfaac469f1091b4206856afa318663758))
* **projects:** name GitHub issue groups after their issue and list each issue's pull requests ([02b41ab](https://github.com/ecoutu/tabchef/commit/02b41ab32b353b0334daeab8d21d45acf6c1d660))
* **recipes:** add a githubIssue extract that reads issue references from URLs and branches ([ee3be3a](https://github.com/ecoutu/tabchef/commit/ee3be3a3263d15edd25ebb123840032695c4ef0c))
* **recipes:** add GitHub issue projects, grouping an issue with its pull requests ([041c0c8](https://github.com/ecoutu/tabchef/commit/041c0c81a97dd2f67a68deaa50a71892899d17f6))
* **recipes:** keep a Jira board out of the group of the ticket it shows ([b49e390](https://github.com/ecoutu/tabchef/commit/b49e390c09228ca990b0c664fdf8502a60090ac1))
* **recipes:** read a GitHub issue's state from its page ([fcf079f](https://github.com/ecoutu/tabchef/commit/fcf079ff32bafcd24a0e97625b3a5f4f81060573))

# [1.8.0](https://github.com/ecoutu/tabchef/compare/v1.7.0...v1.8.0) (2026-11-11)


### Bug Fixes

* **dedupe:** close a second copy of a Jira ticket opened from a link with extra parameters ([346075d](https://github.com/ecoutu/tabchef/commit/346075d15f54e7f674efe28d33c29d0435267b43)), closes [#179](https://github.com/ecoutu/tabchef/issues/179)
* **github-prs:** treat a pull request's new Files changed page as the pull request ([eee893c](https://github.com/ecoutu/tabchef/commit/eee893cd9353cfd1a7df95fa5d2e4380a7868596)), closes [#179](https://github.com/ecoutu/tabchef/issues/179)


### Features

* **projects:** show breadcrumbs on project pages, with Projects as the way back ([9bfe62e](https://github.com/ecoutu/tabchef/commit/9bfe62e62fcbfae8a79f8e1f31072b54ceeeace7)), closes [#180](https://github.com/ecoutu/tabchef/issues/180)

# [1.7.0](https://github.com/ecoutu/tabchef/compare/v1.6.0...v1.7.0) (2026-11-08)


### Bug Fixes

* **groups:** leave a hand-made group alone when Tabchef's group of that name is gone ([ed42c58](https://github.com/ecoutu/tabchef/commit/ed42c5872eb03ebc1e35de0f2b2b1ea583de5bae))
* **options:** drop the extra Projects link above a project ([7d8e707](https://github.com/ecoutu/tabchef/commit/7d8e70745afd83b92ab2c39a284beda1f204352a))
* **projects:** keep the project list in step with storage when a save fails ([b730bf1](https://github.com/ecoutu/tabchef/commit/b730bf1563949dad74980eb1e4bdc5d39c58fd30))
* **projects:** list every project that takes tabs in the add-to-project menu ([45576f6](https://github.com/ecoutu/tabchef/commit/45576f605728592cc0543c17b6ca2470714e7e92))
* **projects:** put a project's own tabs directly in its bookmark folder ([9e0d063](https://github.com/ecoutu/tabchef/commit/9e0d063a655700fce8e4aa5b6c6cb1df8508d68a))
* **projects:** refuse duplicate project names instead of numbering them ([a44ee7f](https://github.com/ecoutu/tabchef/commit/a44ee7f8a6d6ba8c7809d9b2787723251bf09e95))
* **projects:** tell the user when sync stops keeping a project ([0fcb753](https://github.com/ecoutu/tabchef/commit/0fcb7534b3dc003201af03ef551863d162e2cbfc))
* **recipes:** stop grouping GitHub settings and other non-repository pages by repository ([771abb8](https://github.com/ecoutu/tabchef/commit/771abb8487a0b331c29e72675221dae9fbcea527)), closes [#136](https://github.com/ecoutu/tabchef/issues/136)


### Features

* **backups:** include projects in backup export and import ([d3b1acf](https://github.com/ecoutu/tabchef/commit/d3b1acfef150f5de5d322fb75183e1b6dfac43ec))
* **projects:** collapse and expand projects in the popup and side panel ([8591639](https://github.com/ecoutu/tabchef/commit/859163900b159981db8edced4de457bd3bde0dfc)), closes [#151](https://github.com/ecoutu/tabchef/issues/151)
* **projects:** rename project groups when their Jira ticket is renamed ([f0c3069](https://github.com/ecoutu/tabchef/commit/f0c3069a45195fa54b93f5aafe27265e745ecf3c))
* **projects:** show the ticket title next to the key in project lists ([0b56761](https://github.com/ecoutu/tabchef/commit/0b5676168b155e9348b990570971e8ea1e644465))

# [1.6.0](https://github.com/ecoutu/tabchef/compare/v1.5.0...v1.6.0) (2026-11-07)


### Bug Fixes

* **projects:** keep a project whose saved tab list is unreadable ([63e77eb](https://github.com/ecoutu/tabchef/commit/63e77eb880a4629ca756f0764d71024b5dc52232))
* **projects:** keep every saved tab when a project is closed and saved again ([ad425dc](https://github.com/ecoutu/tabchef/commit/ad425dcd65b8d334e63f5dde23923fe6e73b1226))
* **projects:** keep saved tabs that were not reopened after a browser restart ([809fadd](https://github.com/ecoutu/tabchef/commit/809fadd7bc7cd425fd369de468eec9ecf53666fc))
* **projects:** open the rest of a project's saved tabs when one can't be opened ([2e6a1e2](https://github.com/ecoutu/tabchef/commit/2e6a1e2ddd661990bd48136c27a3d8496c805d4d))


### Features

* **projects:** describe projects as bookmark folders ([39fc8ac](https://github.com/ecoutu/tabchef/commit/39fc8ac3db8f4d909912f83a23e38675cd5f93a3))
* **projects:** merge project changes from two devices ([b4785aa](https://github.com/ecoutu/tabchef/commit/b4785aab49d1d0adfc0b6e99a9ee2da0c98525fd))
* **projects:** sync kept projects through bookmark folders ([4498001](https://github.com/ecoutu/tabchef/commit/4498001d04f7c47b32c90789cc0f90860e07594d))
* **projects:** turn on project sync from the projects page ([9aebe42](https://github.com/ecoutu/tabchef/commit/9aebe42e1f5490670406cade540feeb701773e3d))

# [1.5.0](https://github.com/ecoutu/tabchef/compare/v1.4.0...v1.5.0) (2026-11-07)


### Bug Fixes

* **recipes:** reject project rules in a recipe without a project definition ([adffd70](https://github.com/ecoutu/tabchef/commit/adffd70c2d42cce8d36a3f75450bfe330b9d1a6c))
* **ui:** name project closes in plain words ([5fe8f19](https://github.com/ecoutu/tabchef/commit/5fe8f193ac6a17d8245c123f8badd5a7b0f5c27e)), closes [#40](https://github.com/ecoutu/tabchef/issues/40)


### Features

* **projects:** add manual projects ([5895551](https://github.com/ecoutu/tabchef/commit/5895551300477bcb988a188c217628d04235f6cb))
* **projects:** archive projects ([be604d0](https://github.com/ecoutu/tabchef/commit/be604d0613e941d1fdfcd79f0873d1e033c21d32))
* **projects:** save a tab group as a project ([b6f4ba2](https://github.com/ecoutu/tabchef/commit/b6f4ba2eaf764d98020456b82f3022f90a8a6850))
* **projects:** save, close and reopen projects ([9016ba0](https://github.com/ecoutu/tabchef/commit/9016ba0dfb22049e00dcad855cd9846f8eff4a59))

# [1.4.0](https://github.com/ecoutu/tabchef/compare/v1.3.0...v1.4.0) (2026-11-06)


### Bug Fixes

* **projects:** count only ticket tabs as on the connected jira site ([3555855](https://github.com/ecoutu/tabchef/commit/3555855501ad1d3017e51ad127cd0926c65fd5af))
* **projects:** refresh sources once when a rule's level kind changes ([3607d36](https://github.com/ecoutu/tabchef/commit/3607d36230b52cdee0e0656ffa1c39a8dc651389))
* **projects:** run an off-site jira ticket tab at its level without the connection ([772b939](https://github.com/ecoutu/tabchef/commit/772b939cd9631461a5f62e9c7ad3738e1b31481a))
* **projects:** take a project's site from its lowest-id ticket tab ([cb24498](https://github.com/ecoutu/tabchef/commit/cb24498a6ed87dd4f82c8a93f16b18411353da4c))


### Features

* **dashboard:** add projects and project home routes ([9fadd90](https://github.com/ecoutu/tabchef/commit/9fadd9097127b421c3082b3000413faa6f204b34))
* **dashboard:** add the project home page ([bd7cd5a](https://github.com/ecoutu/tabchef/commit/bd7cd5a8d7cc5af8fc398228f8ae90ce3b86ddac))
* **projects:** accept newer project fields and fill placement defaults ([bf3551f](https://github.com/ecoutu/tabchef/commit/bf3551f8dde4cbf1bb382fbd764f0c67c6c4abdc))

# [1.3.0](https://github.com/ecoutu/tabchef/compare/v1.2.1...v1.3.0) (2026-11-05)


### Bug Fixes

* **engine:** hold a tab opened inside github until its new title arrives ([ca70e44](https://github.com/ecoutu/tabchef/commit/ca70e44a82740bd52200ff2ffcf1a95c58794ff9))
* **engine:** stop logging closed grouped tabs as moved out of their group ([5161e55](https://github.com/ecoutu/tabchef/commit/5161e5554b1e0fc8043f4abd4476545b5aebb439))
* **panel:** stop chrome crashing when the side panel opens ([5582b35](https://github.com/ecoutu/tabchef/commit/5582b35656ebe22eeb7fae18834d5b3afbf5aedb))
* **popup:** refresh tab counts after closing or restoring a project group ([84860f5](https://github.com/ecoutu/tabchef/commit/84860f53fbd43cdec52f015d9ea11f3d16ca850d))
* **projects:** close a project's duplicate tabs with its group ([d3ed381](https://github.com/ecoutu/tabchef/commit/d3ed3814cf13fc8ae7c1e738bf50306cf2cd51e2))


### Features

* **popup:** show a loading status while the projects tab first loads ([3892ed7](https://github.com/ecoutu/tabchef/commit/3892ed7a95ec415613ea1dc0563c14071bd2fa8d))

## [1.2.1](https://github.com/ecoutu/tabchef/compare/v1.2.0...v1.2.1) (2026-11-04)


### Bug Fixes

* **engine:** wait for a tab to finish loading before grouping it ([32278cb](https://github.com/ecoutu/tabchef/commit/32278cbff3b21857959f36da92f2ae005295cc5c))

# [1.2.0](https://github.com/ecoutu/tabchef/compare/v1.1.1...v1.2.0) (2026-11-03)


### Bug Fixes

* **rules:** label the rule form's group title field group name ([23c055e](https://github.com/ecoutu/tabchef/commit/23c055e99273d9581c83c69becbbd39a8bd44a60))
* **ui:** say duplicates instead of dedupe in labels, menus and warnings ([a54d200](https://github.com/ecoutu/tabchef/commit/a54d20031cfc7b2be6c621e6daca6a63f21676c5))


### Features

* **icon:** replace the placeholder icon with the toque ([810afd5](https://github.com/ecoutu/tabchef/commit/810afd5283ab407b06835ebc71bbf981efd69ab8))
* **options:** link the guide to recipes and rules from the rules and recipes pages ([d98945e](https://github.com/ecoutu/tabchef/commit/d98945ef3303392feac09f91612e8bcaa43b57f4))

## [1.1.1](https://github.com/ecoutu/tabchef/compare/v1.1.0...v1.1.1) (2026-11-03)


### Bug Fixes

* **sources:** keep a pull request's data while its tab moves between the pr's own pages ([7f21488](https://github.com/ecoutu/tabchef/commit/7f21488f38b6f26cfe0aabfeed6356dd47c5cc79))

# [1.1.0](https://github.com/ecoutu/tabchef/compare/v1.0.0...v1.1.0) (2026-11-03)


### Bug Fixes

* **background:** give a new tab's pending URL to safety ([c6547ba](https://github.com/ecoutu/tabchef/commit/c6547ba78767b1cd56f1e1da93db739b05872285))
* **banner:** never throw when the extension context is invalidated ([cd8a07c](https://github.com/ecoutu/tabchef/commit/cd8a07c73388d02123d5bff331b35fbe0b697f8b))
* **close:** never offer locked or pinned tabs for closing ([135a65e](https://github.com/ecoutu/tabchef/commit/135a65e93cfeeb64197581a88d43f46279cecfbf))
* **engine:** re-plan when a tab's title changes ([b137f13](https://github.com/ecoutu/tabchef/commit/b137f13d463ec3de4fcb3a006f70da43bd536eb8))
* **manifest:** stop requesting the unused identity and bookmarks permissions ([7f02747](https://github.com/ecoutu/tabchef/commit/7f027475f9abbfead2444c70952f7679f758849d))
* **options:** name the Duplicates page in the Import hint ([1618754](https://github.com/ecoutu/tabchef/commit/161875401547f9a7233e386c20788323fb04679c))
* **options:** preview restores and imports before replacing the config ([d9aa3a2](https://github.com/ecoutu/tabchef/commit/d9aa3a2014868b75cfff871a838a613325255381))
* **options:** widen the options page to 1200px so rule controls fit on one line ([53142ac](https://github.com/ecoutu/tabchef/commit/53142ac72029e490b68a17a1dad8993635041a4b))
* **popup:** widen the popup to 520px so the tab strip no longer overflows ([c072ac2](https://github.com/ecoutu/tabchef/commit/c072ac247f688b3278b10874dd5de40cb53c9747))


### Features

* **config:** named sections for user rules ([35d2bee](https://github.com/ecoutu/tabchef/commit/35d2beee7f166a1f3662cdee659260804db259f3))
* **config:** one priority order for your rules and recipe rules, upgrading existing settings ([a761f98](https://github.com/ecoutu/tabchef/commit/a761f98c41b6a521edae40789d7b149d351a59ee))
* **config:** override recipe rule defaults in both directions ([0b00aeb](https://github.com/ecoutu/tabchef/commit/0b00aeb1614a82b91a6565b765cf71e40f8fb4a1))
* **config:** toggle recipe rules one at a time ([e834725](https://github.com/ecoutu/tabchef/commit/e834725d69a4fde7463194973f27e7460dddfec0))
* **connections:** github personal access tokens ([8ac12fc](https://github.com/ecoutu/tabchef/commit/8ac12fcc9212eb46dea2862bd4cb2933ff929751))
* **connections:** jira scoped/classic token and read-only session auth ([1a477a9](https://github.com/ecoutu/tabchef/commit/1a477a95442679ffcb694560a269b836a3309a1e))
* **connections:** keep connection tokens on this device only and redact them from errors ([0394f7e](https://github.com/ecoutu/tabchef/commit/0394f7e8ccf192361a6fd15e7ae0c0fc33f544ee))
* **connections:** name the repos whose pull requests github cannot read ([b6c5338](https://github.com/ecoutu/tabchef/commit/b6c5338717a9fb41e5ac08d1a907e6c6b423163a))
* **connections:** refresh expired tokens and respect github and jira rate limits ([96c7c08](https://github.com/ecoutu/tabchef/commit/96c7c08921f992d7360c324ffcc0ec90412635ca))
* **connections:** sign in through the tabchef github app ([8367f45](https://github.com/ecoutu/tabchef/commit/8367f456094b01f460fab13f9bf8381da219aeb7))
* **connections:** sign in with github via device flow ([a129513](https://github.com/ecoutu/tabchef/commit/a12951331db546810c119ec10361bb2f6ca875be))
* **dedupe:** per-site fragment overrides and optional title-aware dedupe ([26bba1c](https://github.com/ecoutu/tabchef/commit/26bba1cdc1b9a2d3eec6900e16b2d6ed4ec0fd42))
* **engine:** anchor tabs for groups ([0068de0](https://github.com/ecoutu/tabchef/commit/0068de060d52aa2e51988fd8670bd63d660bda85))
* **engine:** dry-run mode per rule and globally ([b74fdb2](https://github.com/ecoutu/tabchef/commit/b74fdb201d7f8e187e17963bcebca29e99f5bd7d))
* **engine:** remember when each tab was opened and re-check age rules every minute ([73dc094](https://github.com/ecoutu/tabchef/commit/73dc0947a4db14e72a5d27e212ccaaddc787e132))
* **import:** suggest collapsing per-repo rules into one templated rule ([079a127](https://github.com/ecoutu/tabchef/commit/079a1272e4ca532c2d547e74c3072079c37856ce))
* **options:** collapsible, movable rule sections ([4b1eaa4](https://github.com/ecoutu/tabchef/commit/4b1eaa4e3aeeaac82d9494b7a366e1d00208881e))
* **options:** connections page with github device flow and personal access tokens ([dc0c7bf](https://github.com/ecoutu/tabchef/commit/dc0c7bfba1b199eea3d3de7b7b9c04305a10d11c))
* **options:** help tips for the duplicate settings ([6f76184](https://github.com/ecoutu/tabchef/commit/6f76184a59846bcf981f5b9500af0214287ec14b))
* **options:** help tips on recipe settings and the rule form ([8374d0a](https://github.com/ecoutu/tabchef/commit/8374d0a04682350c4a8b99ea2b28d42aabde19fc))
* **options:** jira connection card with scoped, classic and session modes ([61f9882](https://github.com/ecoutu/tabchef/commit/61f98829557402c41308bee6f7b6151b6bd7ce96))
* **options:** move a recipe's rules as one block ([8fa3aa4](https://github.com/ecoutu/tabchef/commit/8fa3aa4ab163fd8a6468e10eefdc73dfa1bf598d))
* **popup:** recipe-declared views with overflow ([1f52893](https://github.com/ecoutu/tabchef/commit/1f52893cbe4f46c5e9f01766d28682e0e778bd02))
* **projects:** add tabs to a project by hand and close a project's group in one step ([2a4dda6](https://github.com/ecoutu/tabchef/commit/2a4dda6f9f65c1426aace91d6b557f0be8349caf))
* **projects:** find jira keys in urls, titles and branches, skipping look-alikes such as utf-8 ([fa2a695](https://github.com/ecoutu/tabchef/commit/fa2a695dd377496709d2531f578a7c501f83265c))
* **projects:** projects that tabs join by rule or by hand ([6a49eb2](https://github.com/ecoutu/tabchef/commit/6a49eb2a53ed046b9475bbeda6dcad026010e367))
* **recipes:** access levels that show what a recipe can do with the access you granted ([735cdd0](https://github.com/ecoutu/tabchef/commit/735cdd03d56f033433d4ba4223fa019bc5d9f949))
* **recipes:** ask for the site access a recipe needs, and pause it when access is revoked ([7161a9c](https://github.com/ecoutu/tabchef/commit/7161a9ca24518dc3d91fe819e333aa76c853dd8d))
* **recipes:** built-in recipes, checked against the recipe schema ([f5533a1](https://github.com/ecoutu/tabchef/commit/f5533a12d6d61d8feb2cbe38e3a398fe880995c8))
* **recipes:** finished recipe for OAuth callbacks, redirects and ended Meet calls ([1f7899d](https://github.com/ecoutu/tabchef/commit/1f7899d14f5c9657fc4f76094e8900c5b32695eb))
* **recipes:** jira ticket project recipes with title, branch and either variants ([9e88445](https://github.com/ecoutu/tabchef/commit/9e884455512ad1f73d46c89b011e066e59db5a81))
* **recipes:** merged prs recipe and popup tab ([7b33b3f](https://github.com/ecoutu/tabchef/commit/7b33b3f654ad9132b864639c95b351ff3802af0c))
* **rules:** close tabs after a delay or suggest closing them, skipping tabs still in use ([634ebb4](https://github.com/ecoutu/tabchef/commit/634ebb4a20d6e7de9c10bf0d40e7583db37c17c9))
* **rules:** durations, group title templates with filters, and lookup tables ([0561f31](https://github.com/ecoutu/tabchef/commit/0561f31510b86314100908228f7b04ce2656a64a))
* **rules:** group a recipe's rules under one header; mark rules that cannot match ([da3d653](https://github.com/ecoutu/tabchef/commit/da3d653e3d75e7cc27b3e7e13ffea301abbdf1a6))
* **rules:** let a rule fall back to reading the open page when no connection is set up ([b263982](https://github.com/ecoutu/tabchef/commit/b2639826051da5c2d4c86add61289220108a01c6))
* **rules:** match any port in url patterns ([8d3987e](https://github.com/ecoutu/tabchef/commit/8d3987e7145e4683889be23079052d10f89b4e54))
* **rules:** match on how long ago a tab was opened ([ee40e97](https://github.com/ecoutu/tabchef/commit/ee40e97fe10af50b5ae152629767a8f1c4b08df4))
* **rules:** match on url, title and opener, combined with any, all and not ([f581dc4](https://github.com/ecoutu/tabchef/commit/f581dc40a186e037ff509a400e31a77e3719b99a))
* **rules:** react to text on the page, read values from it, and notice unsaved form edits ([502f672](https://github.com/ecoutu/tabchef/commit/502f672ab485ee23cf80024518dc47cf4cf0efdd))
* **rules:** read pull request and ticket data, compare its fields, and assign tabs to projects ([8750e3d](https://github.com/ecoutu/tabchef/commit/8750e3d16dd4f119ef0cc595e101f72b833c9100))
* **rules:** run your rules and recipe rules together in priority order ([3a47bd4](https://github.com/ecoutu/tabchef/commit/3a47bd43889fddee06b3c8a39ad78b1d4ca52023))
* **sources:** cache pull request and ticket data and keep the last known state when a lookup fails ([17da29d](https://github.com/ecoutu/tabchef/commit/17da29d8e2494c3b519bc799023aa412011f8a19))
* **sources:** look up jira ticket status and summary in batches ([145a1ae](https://github.com/ecoutu/tabchef/commit/145a1ae640d9929ebfb290e1ac6457ea62717e1d))
* **sources:** look up pull request state and linked pull requests on github in batches ([be84291](https://github.com/ecoutu/tabchef/commit/be8429135946483d8fbfbffbc1a798c3d8b94f9b))
* **sources:** read pull request and ticket state from the open page ([0e9bbf8](https://github.com/ecoutu/tabchef/commit/0e9bbf80be2a3986899d751b6c47724e219b1f0e))
* **ui:** conflict view and shadowed-rule warnings ([78f00f1](https://github.com/ecoutu/tabchef/commit/78f00f11522c1d2cfc364fb62159fd8707051563))
* **ui:** context menu with pre-filled rule creation ([37c10c9](https://github.com/ecoutu/tabchef/commit/37c10c95dda4213d0a359e0f2c31682fee7e11fb))
* **ui:** popup projects tab and side panel ([1d5208d](https://github.com/ecoutu/tabchef/commit/1d5208d69d5e7bade2282fa7f1d05af2338633c6))
* **ui:** preview before apply and test against open tabs ([ba4a0ef](https://github.com/ecoutu/tabchef/commit/ba4a0ef63162138af4c6429a8a9365e800d6c953))
* **ui:** recipes page and YAML rule editor ([080da89](https://github.com/ecoutu/tabchef/commit/080da899fa28c789c7747ee2025f0fb918cbeb7d))


### Performance Improvements

* **options:** build section membership once per rules page render ([9e04820](https://github.com/ecoutu/tabchef/commit/9e04820ac0d80b3ba86cdd8d1524ab63be48b2f8))

# Changelog
