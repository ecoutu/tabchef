import { describe, it, expect } from 'vitest';
import { explainHash, matchRoute } from '../../src/ui/routes';

const ROUTES = [{ path: '/rules' }, { path: '/history' }, { path: '/explain/:tabId' }, { path: '/rules/new' }];

describe('matchRoute (R28: longest prefix, with params)', () => {
  it('exact paths', () => {
    expect(matchRoute(ROUTES, '#/history')).toEqual({ path: '/history', params: {} });
  });
  it('params', () => {
    expect(matchRoute(ROUTES, '#/explain/42')).toEqual({ path: '/explain/:tabId', params: { tabId: '42' } });
  });
  it('longest prefix wins, and query params are params', () => {
    expect(matchRoute(ROUTES, '#/rules/new?url=https%3A%2F%2Fx.com%2F&kind=group')).toEqual({ path: '/rules/new', params: { url: 'https://x.com/', kind: 'group' } });
    expect(matchRoute(ROUTES, '#/rules/whatever')).toEqual({ path: '/rules', params: {} });
  });
  it('unknown, empty or a param route without its param → /rules', () => {
    for (const h of ['', '#', '#/nope', '#/explain', '#/explain/']) expect(matchRoute(ROUTES, h)).toEqual({ path: '/rules', params: {} });
  });
  it('explainHash is the route T16 links to', () => {
    expect(explainHash(7)).toBe('#/explain/7');
    expect(matchRoute(ROUTES, explainHash(7)).params).toEqual({ tabId: '7' });
  });
});
