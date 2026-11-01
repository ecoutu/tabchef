// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { defaultConfig } from '../../src/core/config/defaults';

const perms = vi.hoisted(() => ({
  state: { scripting: false, notifications: false, origins: [] as string[] },
  listeners: [] as (() => void)[],
  request: vi.fn<(p: { permissions?: string[]; origins?: string[] }) => Promise<boolean>>(async () => true),
  remove: vi.fn<(p: { permissions?: string[]; origins?: string[] }) => Promise<boolean>>(async () => true),
}));
vi.mock('../../src/ui/permissions', async (orig) => ({
  ...(await orig<typeof import('../../src/ui/permissions')>()),
  readPermissions: async () => ({ ...perms.state, origins: [...perms.state.origins] }),
  requestPermissions: (p: { permissions?: string[]; origins?: string[] }) => perms.request(p),
  removePermissions: (p: { permissions?: string[]; origins?: string[] }) => perms.remove(p),
  onPermissionsChanged: (cb: () => void) => { perms.listeners.push(cb); return () => { perms.listeners = perms.listeners.filter((x) => x !== cb); }; },
}));
import Dedupe from '../../src/entrypoints/options/Dedupe.svelte';
import { parseSites } from '../../src/ui/permissions';

const props = () => ({ config: defaultConfig(), dirty: false, saving: false, serverErrors: [], onChange: vi.fn(), onSave: vi.fn() });

beforeEach(() => {
  perms.state = { scripting: false, notifications: false, origins: [] };
  perms.listeners = [];
  perms.request.mockClear();
  perms.remove.mockClear();
});
afterEach(cleanup);

describe('parseSites', () => {
  it('accepts https host patterns and http://localhost, rejects others', () => {
    expect(parseSites('https://github.com/*\n https://*.atlassian.net/* \n\n')).toEqual({ origins: ['https://github.com/*', 'https://*.atlassian.net/*'], errors: [] });
    expect(parseSites('http://localhost/*').errors).toEqual([]);
    expect(parseSites('http://example.com/*').errors).toHaveLength(1);
    expect(parseSites('github.com').errors).toHaveLength(1);
    expect(parseSites('').errors).toEqual(['Add at least one site, e.g. https://github.com/*']);
  });
});

describe('Dedupe permission controls (I6)', () => {
  it('Enable in-page prompts requests scripting + the listed sites from the click', async () => {
    render(Dedupe, props());
    await fireEvent.input(screen.getByLabelText('Sites for in-page prompts (one per line)'), { target: { value: 'https://github.com/*' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Enable in-page prompts' }));
    expect(perms.request).toHaveBeenCalledWith({ permissions: ['scripting'], origins: ['https://github.com/*'] });
  });

  it('invalid sites show an error and request nothing', async () => {
    render(Dedupe, props());
    await fireEvent.input(screen.getByLabelText('Sites for in-page prompts (one per line)'), { target: { value: 'ftp://x/*' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Enable in-page prompts' }));
    expect(perms.request).not.toHaveBeenCalled();
    expect(await screen.findByText(/ftp:\/\/x\/\*/)).toBeTruthy();
  });

  it('Enable notifications requests notifications', async () => {
    render(Dedupe, props());
    await fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }));
    expect(perms.request).toHaveBeenCalledWith({ permissions: ['notifications'] });
  });

  it('shows granted state and follows permissions.onAdded / onRemoved', async () => {
    perms.state = { scripting: true, notifications: true, origins: ['https://github.com/*'] };
    render(Dedupe, props());
    expect(await screen.findByText('In-page prompts: on for https://github.com/*')).toBeTruthy();
    expect(await screen.findByText('Notifications: on')).toBeTruthy();
    perms.state = { scripting: false, notifications: false, origins: [] };
    for (const cb of perms.listeners) cb();
    expect(await screen.findByText('In-page prompts: off')).toBeTruthy();
    expect(await screen.findByText('Notifications: off')).toBeTruthy();
  });

  it('Turn off removes the granted permissions', async () => {
    perms.state = { scripting: true, notifications: true, origins: ['https://github.com/*'] };
    render(Dedupe, props());
    await fireEvent.click(await screen.findByRole('button', { name: 'Turn off in-page prompts' }));
    expect(perms.remove).toHaveBeenCalledWith({ permissions: ['scripting'], origins: ['https://github.com/*'] });
    await fireEvent.click(await screen.findByRole('button', { name: 'Turn off notifications' }));
    expect(perms.remove).toHaveBeenCalledWith({ permissions: ['notifications'] });
  });
});
