import type { Config } from '../types';

export function defaultConfig(): Config {
  return {
    version: 1,
    groupRules: [],
    dedupe: {
      mode: 'always-switch',
      keep: 'existing',
      stripParams: ['utm_*', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'],
      stripFragment: true,
      ignoreTrailingSlash: true,
      canonicalizers: ['githubPr'],
      followFragment: true,
      allowDuplicates: [],
      includeIncognito: false,
      scope: 'all-windows',
      urlTransforms: [],
    },
  };
}
