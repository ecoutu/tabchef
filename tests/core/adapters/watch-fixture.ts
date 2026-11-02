// Runs a saved page through M2's watch extraction (src/engine/page-watch.ts) with the watch config the worker answers
// for `url` (PageFacts.watchConfigFor), and returns the reported page.facts extracts: what a page adapter parses.
import { vi } from 'vitest';
import { startPageWatch } from '../../../src/engine/page-watch';
import { PageFacts } from '../../../src/engine/page-facts';
import type { PageFactsMessage } from '../../../src/engine/messages';
import type { Program, Rule } from '../../../src/core/lang/types';
import { defaultConfig } from '../../../src/core/config/defaults';
import { programOf } from '../../helpers/config';

/** A program of one user rule whose extracts read every given `{adapter, field}`. */
export function adapterProgram(adapter: 'github.prPage' | 'jira.issuePage', fields: string[]): Program {
  const rule: Rule = {
    id: 'a', name: 'a', enabled: true, match: { url: '*' }, actions: [{ showInView: { view: 'v' } }],
    extract: Object.fromEntries(fields.map((f) => [f, { adapter, field: f }])),
  };
  return programOf({ ...defaultConfig(), rules: [rule], order: ['user/a'] });
}

export async function extractFixture(html: string, url: string, program: Program): Promise<Record<string, string>> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const config = new PageFacts({ session: { get: async () => undefined, set: async () => {} } }).watchConfigFor(url, program);
  const reports: PageFactsMessage[] = [];
  const w = startPageWatch({
    doc, win: window,
    send: async (m) => {
      if (m.type === 'watch.hello') return { type: 'watch.config', ...config };
      reports.push(m);
      return { ok: true };
    },
  });
  await vi.waitFor(() => { if (reports.length === 0) throw new Error('no page.facts yet'); });
  w.stop();
  return reports[0]!.extracts;
}
