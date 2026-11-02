<script lang="ts">
  // Connections page (M3 T7, GitHub part). Tokens never enter this page's state: the token field is read from the
  // input on Save and cleared; responses are metadata only. Jira's rows and forms land with Task 6.
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import Field from './Field.svelte';
  import { send } from '../../ui/send';
  import { requestPermissions } from '../../ui/permissions';
  import { connectionRows, type ConnectionRow } from '../../ui/connections-model';
  import { isConnectionsChangedMessage } from '../../engine/messages';
  import { builtinConnectionDefs } from '../../core/connections/builtin';
  import type { ConnectionDef, ConnectionStatus } from '../../core/connections/types';

  const NEEDS_HOSTS = 'Tabchef needs access to github.com and api.github.com to connect GitHub.';
  const TOKEN_HELP = 'Fine-grained token (recommended): choose the repositories, then Repository permissions → Pull requests: Read-only (Metadata: Read-only is added automatically). Classic token: the repo scope, which also grants write access. Tabchef only reads.';

  let defs = $state<ConnectionDef[]>([]);
  let status = $state<ConnectionStatus[]>([]);
  let loaded = $state(false);
  let info = $state('');
  let error = $state('');
  let busy = $state(false);
  /** The device flow in progress: the code to enter on GitHub. Never the device_code (the worker keeps it). */
  let flow = $state<{ userCode: string; verificationUri: string } | null>(null);
  let copied = $state(false);
  let tokenInput = $state<HTMLInputElement | null>(null);

  const rows = $derived(connectionRows(defs, status, Date.now()));
  const github = $derived(rows.find((r) => r.id === 'github'));
  const githubHosts = $derived(defs.find((d) => d.id === 'github')?.hosts ?? builtinConnectionDefs().github.hosts);

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  /** One re-list when a rate-limit block ends: nothing else reports it (no status change fires). */
  let unblockTimer: ReturnType<typeof setTimeout> | undefined;
  const MAX_UNBLOCK_WAIT_MS = 3_600_000;
  let alive = true;
  /** Bumped on every Connect: a poll answer for an older flow is ignored. */
  let flowGen = 0;

  async function load(): Promise<void> {
    const r = await send({ type: 'connections.list' });
    if (!r.ok) { error = r.error; return; }
    defs = r.data.defs;
    status = r.data.status;
    loaded = true;
    scheduleUnblock();
  }

  function scheduleUnblock(): void {
    clearTimeout(unblockTimer);
    unblockTimer = undefined;
    const until = status.filter((s) => s.state === 'rate-limited' && s.blockedUntil !== undefined).map((s) => s.blockedUntil!);
    if (!alive || until.length === 0) return;
    const wait = Math.min(Math.max(Math.min(...until) - Date.now(), 0) + 1_000, MAX_UNBLOCK_WAIT_MS);
    unblockTimer = setTimeout(() => { unblockTimer = undefined; void load(); }, wait);
  }

  function stopPolling(): void {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function schedulePoll(gen: number, intervalS: number): void {
    stopPolling();
    if (!alive) return;
    pollTimer = setTimeout(() => { void poll(gen); }, Math.max(1, intervalS) * 1000);
  }

  async function poll(gen: number): Promise<void> {
    const r = await send({ type: 'connections.github.poll' });
    if (!alive || gen !== flowGen) return;
    if (!r.ok) { flow = null; error = r.error; info = ''; return; }
    const p = r.data;
    switch (p.state) {
      case 'pending':
        info = p.message ?? 'Waiting for you to enter the code on GitHub…';
        schedulePoll(gen, p.interval ?? 5);
        return;
      case 'slow-down':
        info = 'GitHub asked Tabchef to check less often; still waiting…';
        schedulePoll(gen, p.interval ?? 10);
        return;
      case 'done':
        flow = null;
        info = 'Connected to GitHub.';
        await load();
        return;
      default:
        // expired, denied, error: the flow is over; Connect GitHub starts a new one.
        flow = null;
        info = '';
        error = p.message ?? 'GitHub sign-in failed';
    }
  }

  /** The permission request is the first statement: Chrome needs the click's user gesture, lost after an await. */
  function connectGitHub(): void {
    const granted = requestPermissions({ origins: [...githubHosts] });
    const gen = ++flowGen;
    stopPolling();
    error = ''; info = ''; flow = null; copied = false;
    void (async () => {
      let ok: boolean;
      try { ok = await granted; } catch (e) { ok = false; error = e instanceof Error ? e.message : String(e); }
      if (!alive || gen !== flowGen) return; // the page closed (or Cancel) while Chrome's prompt was open
      if (!ok) { if (!error) error = NEEDS_HOSTS; return; }
      const r = await send({ type: 'connections.github.start' });
      if (!alive || gen !== flowGen) return;
      if (!r.ok) { error = r.error; return; }
      flow = { userCode: r.data.userCode, verificationUri: r.data.verificationUri };
      info = 'Waiting for you to enter the code on GitHub…';
      schedulePoll(gen, r.data.interval);
    })();
  }

  function cancelFlow(): void {
    flowGen++;
    stopPolling();
    flow = null;
    info = '';
  }

  async function copyCode(): Promise<void> {
    if (!flow) return;
    try {
      await navigator.clipboard.writeText(flow.userCode);
      copied = true;
    } catch {
      error = 'Could not copy; select the code and copy it yourself.';
    }
  }

  async function saveToken(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const input = tokenInput;
    const token = input?.value.trim() ?? '';
    if (input) input.value = '';
    error = ''; info = '';
    if (!token) { error = 'Paste a token first.'; return; }
    busy = true;
    const r = await send({ type: 'connections.setToken', id: 'github', token });
    busy = false;
    if (!r.ok) { error = r.error; return; }
    cancelFlow();
    info = 'Token saved.';
    await load();
  }

  async function testConnection(row: ConnectionRow): Promise<void> {
    error = ''; info = '';
    busy = true;
    const r = await send({ type: 'connections.test', id: row.id });
    busy = false;
    if (!r.ok) error = r.error;
    else info = r.data.login ? `Connection works (signed in as ${r.data.login}).` : 'Connection works.';
    await load();
  }

  async function disconnect(row: ConnectionRow): Promise<void> {
    if (row.id === 'github') cancelFlow(); // stop polling first; the worker also cancels the stored flow
    error = ''; info = '';
    busy = true;
    const r = await send({ type: 'connections.disconnect', id: row.id });
    busy = false;
    if (!r.ok) { error = r.error; return; }
    info = `Disconnected from ${row.label}.`;
    await load();
  }

  onMount(() => {
    void load();
    const onMsg = (m: unknown): void => { if (isConnectionsChangedMessage(m)) void load(); };
    browser.runtime.onMessage.addListener(onMsg);
    return () => {
      alive = false;
      stopPolling();
      clearTimeout(unblockTimer);
      browser.runtime.onMessage.removeListener(onMsg);
    };
  });
</script>

<div class="connections">
  <p class="help">Connections let recipes read pull request and issue status. Tabchef only reads, and tokens stay in this browser.</p>

  {#if error}<p class="err" role="alert">{error}</p>{/if}
  {#if info}<p class="ok" role="status">{info}</p>{/if}

  {#if github}
    <section class="card" aria-labelledby="conn-github">
      <div class="head">
        <h3 id="conn-github">{github.label}</h3>
        <span class="badge" class:good={github.state === 'ok'} class:bad={github.state === 'needs-reauth' || github.state === 'error' || github.state === 'rate-limited'}>{github.badge}</span>
      </div>
      <dl>
        {#if github.login}<div><dt>Account</dt><dd>Signed in as {github.login}{github.auth === 'token' ? ' (personal access token)' : ''}</dd></div>{/if}
        {#if github.scopes}<div><dt>Scopes</dt><dd>{github.scopes}</dd></div>{/if}
        {#if github.state !== 'not-configured'}<div><dt>Last used</dt><dd>{github.lastUsed}</dd></div>{/if}
        {#if github.lastError}<div><dt>Last error</dt><dd class="err">{github.lastError}</dd></div>{/if}
      </dl>
      {#each github.ssoLinks as l (l.org)}
        <p><a href={l.url} target="_blank" rel="noopener noreferrer">{l.text}</a></p>
      {/each}

      {#if flow}
        <div class="flow">
          <p>Enter this code on GitHub:</p>
          <p class="code"><code>{flow.userCode}</code>
            <button type="button" aria-label="Copy code" onclick={copyCode}>Copy</button>
            {#if copied}<span class="muted">Copied</span>{/if}
          </p>
          <p>
            <a href={flow.verificationUri} target="_blank" rel="noopener noreferrer">Open github.com/login/device</a>
            <button type="button" onclick={cancelFlow}>Cancel</button>
          </p>
        </div>
      {/if}

      <div class="row">
        {#if github.state === 'not-configured' || github.state === 'needs-reauth'}
          <button type="button" class="primary" onclick={connectGitHub} disabled={busy}>Connect GitHub</button>
        {/if}
        {#if github.state !== 'not-configured'}
          <button type="button" onclick={() => testConnection(github!)} disabled={busy}>Test connection</button>
          <button type="button" class="danger" onclick={() => disconnect(github!)} disabled={busy}>Disconnect</button>
        {/if}
        {#if github.revokeUrl && github.state !== 'not-configured'}
          <a href={github.revokeUrl} target="_blank" rel="noopener noreferrer">Revoke on GitHub</a>
        {/if}
      </div>

      <details>
        <summary>Use a personal access token instead</summary>
        <form onsubmit={saveToken}>
          <p class="help">
            <strong>Fine-grained token (recommended):</strong> pick the repositories and grant read-only
            <em>Pull requests</em> and <em>Metadata</em>. A <strong>classic</strong> token needs the <code>repo</code> scope.
            <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">Create a token</a>
          </p>
          <div class="row">
            <Field label="Personal access token" help={TOKEN_HELP}>
              <input type="password" autocomplete="off" spellcheck="false" bind:this={tokenInput} />
            </Field>
            <button type="submit" disabled={busy}>Save token</button>
          </div>
        </form>
      </details>
    </section>
  {:else if loaded}
    <p class="muted">No connections.</p>
  {/if}
</div>

<style>
  .connections { display: flex; flex-direction: column; gap: 8px; }
  .help, .muted { color: var(--muted); margin: 0; }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; background: var(--bg); }
  .head { display: flex; align-items: center; gap: 8px; }
  h3 { margin: 0; font-size: 14px; }
  .badge { font-size: 12px; border: 1px solid var(--border); border-radius: 10px; padding: 0 8px; color: var(--muted); }
  .badge.good { color: var(--accent); border-color: var(--accent); }
  .badge.bad { color: var(--danger); border-color: var(--danger); }
  dl { margin: 0; display: flex; flex-direction: column; gap: 2px; }
  dl > div { display: flex; gap: 6px; }
  dt { color: var(--muted); min-width: 80px; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .flow { border: 1px solid var(--accent); border-radius: 8px; padding: 6px 10px; background: var(--surface); }
  .flow p { margin: 4px 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .code code { font-size: 20px; letter-spacing: 2px; font-weight: 600; }
  .row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
  details { margin-top: 4px; }
  summary { cursor: pointer; color: var(--accent); }
  form { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
  a { color: var(--accent); }
  .err { color: var(--danger); margin: 0; }
  .ok { color: var(--accent); margin: 0; }
</style>
