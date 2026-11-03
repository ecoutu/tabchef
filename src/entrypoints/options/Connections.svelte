<script lang="ts">
  // Connections page (M3 T7): GitHub and Jira. Tokens never enter this page's state: a token field is read from the
  // input on Save and cleared; responses are metadata only. Every permission request is made synchronously in its
  // click handler, before any await (Chrome needs the click's user gesture).
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import Field from './Field.svelte';
  import Help from './Help.svelte';
  import { send } from '../../ui/send';
  import { requestPermissions } from '../../ui/permissions';
  import { connectionRows, endOfLocalDay, hostName, type ConnectionRow } from '../../ui/connections-model';
  import { isConnectionsChangedMessage } from '../../engine/messages';
  import { builtinConnectionDefs, isJiraSite, jiraDef } from '../../core/connections/builtin';
  import type { ConnectionDef, ConnectionStatus } from '../../core/connections/types';

  const NEEDS_HOSTS = 'Tabchef needs access to github.com and api.github.com to connect GitHub.';
  const TOKEN_HELP = 'Fine-grained token (recommended): choose the repositories, then Repository permissions → Pull requests: Read-only (Metadata: Read-only is added automatically). Classic token: the repo scope, which also grants write access. Tabchef only reads.';
  const JIRA_TOKENS_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
  const JIRA_SESSION_LABEL = 'Use my browser session instead (read-only, best effort)';
  const JIRA_HELP = {
    site: 'Your Jira Cloud address without https://, for example your-site.atlassian.net.',
    email: 'The email address of the Atlassian account the API token belongs to.',
    token: `Create API tokens at ${JIRA_TOKENS_URL}. A scoped token needs the read:jira-work and read:jira-user scopes.`,
    scoped: 'Recommended: a token limited to the read:jira-work and read:jira-user scopes. Tabchef only reads.',
    classic: 'A token with the full access of your Atlassian account. Tabchef only reads.',
    expiry: 'Atlassian does not report when a token expires, so enter its expiry date to get a warning before it stops working.',
    session: 'Uses the Jira sign-in of this browser instead of a token: read-only, and it may stop working if Chrome blocks third-party cookies.',
  };
  const BAD_SITE = 'Enter your Jira site, like your-site.atlassian.net.';

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
  // The Jira form: site, email and kind are not secret (prefilled from a stored connection); the token is read from its
  // input on Save and cleared.
  let jiraSite = $state('');
  let jiraEmail = $state('');
  let jiraKind = $state<'scoped' | 'classic'>('scoped');
  let jiraExpiry = $state('');
  let jiraTokenInput = $state<HTMLInputElement | null>(null);

  const rows = $derived(connectionRows(defs, status, Date.now()));
  const github = $derived(rows.find((r) => r.id === 'github'));
  const jira = $derived(rows.find((r) => r.id === 'jira'));
  const githubHosts = $derived(defs.find((d) => d.id === 'github')?.hosts ?? builtinConnectionDefs().github.hosts);

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  /** One re-list when a rate-limit block ends: nothing else reports it (no status change fires). */
  let unblockTimer: ReturnType<typeof setTimeout> | undefined;
  const MAX_UNBLOCK_WAIT_MS = 3_600_000;
  let alive = true;
  /** Bumped on every Connect: a poll answer for an older flow is ignored. */
  let flowGen = 0;

  /** Repos of open PR tabs the GitHub connection cannot read (connections.list). */
  let unreadable = $state<{ repo: string; error: string }[]>([]);

  async function load(): Promise<void> {
    const r = await send({ type: 'connections.list' });
    if (!r.ok) { error = r.error; return; }
    defs = r.data.defs;
    status = r.data.status;
    unreadable = r.data.unreadable ?? [];
    loaded = true;
    prefillJira();
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

  /** Once, fills the empty Jira form fields from the stored connection (a re-sign-in keeps the site, email and kind). */
  let jiraPrefilled = false;
  function prefillJira(): void {
    const j = defs.find((d) => d.id === 'jira')?.jira;
    if (jiraPrefilled || !j?.site) return;
    jiraPrefilled = true;
    if (!jiraSite) jiraSite = j.site;
    if (!jiraEmail && j.email) jiraEmail = j.email;
    if (j.tokenKind) jiraKind = j.tokenKind;
  }

  /** The typed site as the engine reads it (trimmed, lowercased), or undefined with the inline error set. */
  function typedSite(): string | undefined {
    const site = jiraSite.trim().toLowerCase();
    if (isJiraSite(site)) return site;
    error = BAD_SITE;
    return undefined;
  }

  /** Awaits a permission prompt started in a click handler; false (with the inline message) when denied. */
  async function hostsGranted(granted: Promise<boolean>, hosts: string[]): Promise<boolean> {
    let ok: boolean;
    try { ok = await granted; } catch (e) { ok = false; error = e instanceof Error ? e.message : String(e); }
    if (alive && !ok && !error) error = `Tabchef needs access to ${hosts.map(hostName).join(' and ')} to connect Jira.`;
    return alive && ok;
  }

  /**
   * Connect Jira with a token. Validation is synchronous, then the permission request for the typed site's hosts,
   * before any await; the token field is cleared at once.
   */
  function connectJira(e: SubmitEvent): void {
    e.preventDefault();
    const input = jiraTokenInput;
    const token = input?.value.trim() ?? '';
    if (input) input.value = '';
    error = ''; info = '';
    const site = typedSite();
    if (!site) return;
    const email = jiraEmail.trim();
    if (!email) { error = 'Enter the email address of your Atlassian account.'; return; }
    if (!token) { error = 'Paste a token first.'; return; }
    const expiresAt = jiraExpiry ? endOfLocalDay(jiraExpiry) : undefined;
    if (jiraExpiry && expiresAt === undefined) { error = 'Enter a valid expiry date.'; return; }
    if (expiresAt !== undefined && expiresAt <= Date.now()) { error = 'The expiry date is in the past.'; return; }
    const tokenKind = jiraKind;
    const hosts = jiraDef(site, tokenKind).hosts;
    const granted = requestPermissions({ origins: [...hosts] });
    busy = true;
    void (async () => {
      try {
        if (!(await hostsGranted(granted, hosts))) return;
        const r = await send({
          type: 'connections.setToken', id: 'jira', token,
          jira: { site, email, tokenKind, ...(expiresAt !== undefined && { expiresAt }) },
        });
        if (!alive) return;
        if (!r.ok) { error = r.error; return; }
        jiraExpiry = '';
        info = 'Connected to Jira.';
        await load();
      } finally {
        busy = false;
      }
    })();
  }

  /** Jira session mode: the typed site's host is requested synchronously, then setSession. */
  function connectJiraSession(): void {
    error = ''; info = '';
    const site = typedSite();
    if (!site) return;
    const hosts = jiraDef(site, 'session').hosts;
    const granted = requestPermissions({ origins: [...hosts] });
    busy = true;
    void (async () => {
      try {
        if (!(await hostsGranted(granted, hosts))) return;
        const r = await send({ type: 'connections.setSession', site });
        if (!alive) return;
        if (!r.ok) { error = r.error; return; }
        info = 'Connected to Jira with your browser session (read-only).';
        await load();
      } finally {
        busy = false;
      }
    })();
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

  /**
   * Grant access (M3-R96): credentials are stored but host access was revoked. Requests only the missing hosts and
   * starts no sign-in. The permission request is the first statement (the click's user gesture).
   */
  function grantAccess(row: ConnectionRow): void {
    const granted = requestPermissions({ origins: [...row.hostsMissing] });
    error = ''; info = '';
    void (async () => {
      let ok: boolean;
      try { ok = await granted; } catch (e) { ok = false; error = e instanceof Error ? e.message : String(e); }
      if (!alive) return;
      if (!ok) { if (!error) error = `Tabchef needs access to ${row.hostsMissing.map(hostName).join(' and ')} to use ${row.label}.`; return; }
      await load();
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
    else {
      const who = r.data.login ?? r.data.displayName;
      info = who ? `Connection works (signed in as ${who}).` : 'Connection works.';
    }
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
        <span class="badge" class:good={github.state === 'ok'} class:bad={github.state === 'needs-reauth' || github.state === 'error' || github.state === 'rate-limited' || github.hostsMissing.length > 0}>{github.badge}</span>
      </div>
      <dl>
        {#if github.login}<div><dt>Account</dt><dd>Signed in as {github.login}{github.auth === 'token' ? ' (personal access token)' : ''}</dd></div>{/if}
        {#if github.scopes}<div><dt>Scopes</dt><dd>{github.scopes}</dd></div>{/if}
        {#if github.stored}<div><dt>Last used</dt><dd>{github.lastUsed}</dd></div>{/if}
        {#if github.lastError}<div><dt>Last error</dt><dd class="err">{github.lastError}</dd></div>{/if}
      </dl>
      {#each github.ssoLinks as l (l.org)}
        <p><a href={l.url} target="_blank" rel="noopener noreferrer">{l.text}</a></p>
      {/each}
      {#if github.state === 'ok' && unreadable.length}
        <p class="warn" role="status">
          This connection cannot read pull requests in {unreadable.map((u) => u.repo).join(', ')}, so their state and branch
          come from the open page only.
          {github.auth === 'token'
            ? 'Use a personal access token that can read these repositories (and is authorized for SAML SSO if the organization uses it).'
            : 'Ask an organization owner to install the Tabchef GitHub App on these repositories, or connect with a personal access token that can read them.'}
        </p>
      {/if}

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
        {#if github.hostsMissing.length}
          <button type="button" class="primary" onclick={() => grantAccess(github!)} disabled={busy}>Grant access</button>
        {:else if github.state === 'not-configured' || github.state === 'needs-reauth'}
          <button type="button" class="primary" onclick={connectGitHub} disabled={busy}>Connect GitHub</button>
        {/if}
        {#if github.state !== 'not-configured'}
          <button type="button" onclick={() => testConnection(github!)} disabled={busy}>Test connection</button>
        {/if}
        {#if github.stored}
          <button type="button" class="danger" onclick={() => disconnect(github!)} disabled={busy}>Disconnect</button>
        {/if}
        {#if github.revokeUrl && github.stored}
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
  {/if}

  {#if jira}
    <section class="card" aria-labelledby="conn-jira">
      <div class="head">
        <h3 id="conn-jira">{jira.label}</h3>
        <span class="badge" class:good={jira.state === 'ok'} class:bad={jira.state === 'needs-reauth' || jira.state === 'error' || jira.state === 'rate-limited' || jira.hostsMissing.length > 0}>{jira.badge}</span>
      </div>
      {#if jira.stored}
        <dl>
          {#if jira.site}<div><dt>Site</dt><dd>{jira.site}</dd></div>{/if}
          {#if jira.mode}<div><dt>Mode</dt><dd>{jira.mode}</dd></div>{/if}
          {#if jira.email}<div><dt>Account</dt><dd>{jira.email}</dd></div>{/if}
          <div><dt>Last used</dt><dd>{jira.lastUsed}</dd></div>
          {#if jira.lastError}<div><dt>Last error</dt><dd class="err">{jira.lastError}</dd></div>{/if}
        </dl>
      {/if}
      {#if jira.expiryWarning}<p class="warn" role="status">{jira.expiryWarning}</p>{/if}

      <div class="row">
        {#if jira.hostsMissing.length}
          <button type="button" class="primary" onclick={() => grantAccess(jira!)} disabled={busy}>Grant access</button>
        {/if}
        {#if jira.state !== 'not-configured'}
          <button type="button" onclick={() => testConnection(jira!)} disabled={busy}>Test connection</button>
        {/if}
        {#if jira.stored}
          <button type="button" class="danger" onclick={() => disconnect(jira!)} disabled={busy}>Disconnect</button>
        {/if}
        {#if jira.revokeUrl && jira.stored}
          <a href={jira.revokeUrl} target="_blank" rel="noopener noreferrer">Revoke on Atlassian</a>
        {/if}
      </div>

      {#if !jira.hostsMissing.length && (jira.state === 'not-configured' || jira.state === 'needs-reauth')}
        <form onsubmit={connectJira}>
          <div class="row">
            <Field label="Jira site" help={JIRA_HELP.site}>
              <input type="text" placeholder="your-site.atlassian.net" autocomplete="off" spellcheck="false" bind:value={jiraSite} />
            </Field>
            <Field label="Atlassian account email" help={JIRA_HELP.email}>
              <input type="email" autocomplete="email" spellcheck="false" bind:value={jiraEmail} />
            </Field>
          </div>
          <fieldset>
            <legend>Token kind</legend>
            <Field label="Scoped API token — recommended" help={JIRA_HELP.scoped} inline>
              <input type="radio" name="jira-kind" value="scoped" bind:group={jiraKind} />
            </Field>
            <Field label="Classic API token" help={JIRA_HELP.classic} inline>
              <input type="radio" name="jira-kind" value="classic" bind:group={jiraKind} />
            </Field>
          </fieldset>
          <div class="row">
            <Field label="API token" help={JIRA_HELP.token}>
              <input type="password" autocomplete="off" spellcheck="false" bind:this={jiraTokenInput} />
            </Field>
            <Field label="Token expiry (optional)" help={JIRA_HELP.expiry}>
              <input type="date" bind:value={jiraExpiry} />
            </Field>
            <button type="submit" class="primary" disabled={busy}>Connect Jira</button>
          </div>
          <p class="help">
            <a href={JIRA_TOKENS_URL} target="_blank" rel="noopener noreferrer">Create a token</a> on your Atlassian account.
          </p>
        </form>
        <div class="row">
          <button type="button" onclick={connectJiraSession} disabled={busy}>{JIRA_SESSION_LABEL}</button>
          <Help label="Browser session" text={JIRA_HELP.session} />
        </div>
      {/if}
    </section>
  {/if}

  {#if loaded && !github && !jira}
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
  .warn { color: var(--danger); margin: 0; }
  fieldset { border: none; margin: 0; padding: 0; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  legend { color: var(--muted); font-size: 12px; padding: 0; margin-bottom: 2px; }
  .ok { color: var(--accent); margin: 0; }
</style>
