import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import project from '../../src/core/project.json' with { type: 'json' };
import { GITHUB_APP_CLIENT_ID, REPO_URL, repoFileUrl } from '../../src/core/project';

describe('project facts (src/core/project.json)', () => {
  it('REPO_URL is a GitHub repository web address', () => {
    expect(REPO_URL).toBe(project.repositoryUrl);
    expect(REPO_URL).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  });

  it('REPO_URL matches the origin remote, so a move updates both', () => {
    let origin = '';
    try {
      origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    } catch {
      return; // no git checkout (e.g. a source tarball)
    }
    const slug = (u: string) => u.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '').toLowerCase();
    expect(slug(origin)).toBe(REPO_URL.toLowerCase());
  });

  it('repoFileUrl links a file on main', () => {
    expect(repoFileUrl('docs/recipes.md')).toBe(`${REPO_URL}/blob/main/docs/recipes.md`);
  });

  it('GITHUB_APP_CLIENT_ID has the GitHub App client id format', () => {
    expect(GITHUB_APP_CLIENT_ID).toBe(project.githubAppClientId);
    expect(GITHUB_APP_CLIENT_ID).toMatch(/^Iv[0-9]{2}[A-Za-z0-9]{16}$/);
  });
});
