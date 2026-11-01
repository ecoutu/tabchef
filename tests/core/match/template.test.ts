import { describe, it, expect } from 'vitest';
import { renderTemplate, templateVars } from '../../../src/core/match/template';

describe('renderTemplate', () => {
  it('substitutes and applies filters', () => {
    expect(renderTemplate('{owner}/{repo|upper}', { owner: 'acme', repo: 'api' })).toBe('acme/API');
    expect(renderTemplate('{a|lower}', { a: 'ABC' })).toBe('abc');
  });
  it('unknown var renders empty', () => {
    expect(renderTemplate('x{nope}y', {})).toBe('xy');
    expect(renderTemplate('{toString}', {})).toBe('');
  });
  it('unknown filter leaves value; plain text untouched', () => {
    expect(renderTemplate('{a|bogus} {', { a: 'v' })).toBe('v {');
  });
});

describe('templateVars', () => {
  it('lists variable names used by the template', () => {
    expect(templateVars('{owner}/{repo|upper} {owner}')).toEqual(['owner', 'repo']);
    expect(templateVars('plain')).toEqual([]);
  });
});
