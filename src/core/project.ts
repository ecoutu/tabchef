// Project facts that change when the repository moves or the GitHub App is replaced. They live in project.json, so a
// move is one edit there plus a release; nothing else in src hardcodes them. The import attribute lets Node load it
// too (Playwright e2e). Each value is read in a pure IIFE, so bundles that import this module without using one (the
// content scripts) drop it.
import project from './project.json' with { type: 'json' };

/** The repository's web address, e.g. https://github.com/ecoutu/tabchef. */
export const REPO_URL: string = /* @__PURE__ */ (() => project.repositoryUrl)();

/** A file in the repository on main, as a web page (docs linked from the UI). */
export const repoFileUrl = (path: string): string => `${REPO_URL}/blob/main/${path}`;

/** Public client id of the Tabchef GitHub App (device flow). Never add a client secret anywhere. */
export const GITHUB_APP_CLIENT_ID: string = /* @__PURE__ */ (() => project.githubAppClientId)();
