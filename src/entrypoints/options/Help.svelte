<script lang="ts">
  // A "?" help tip for an options setting. Shown on hover or keyboard focus, pinned open by a click (touch), closed by
  // Escape, blur or a second click. The tip describes the button (aria-describedby), so screen readers read it on
  // focus. Place it NEXT TO a <label>, never inside one: a button in a label is invalid and can toggle the control.
  let { label, text }: { label: string; text: string } = $props();

  const uid = $props.id();
  const id = `help-${uid}`;
  let hover = $state(false);
  let focus = $state(false);
  let pinned = $state(false);
  let dismissed = $state(false);
  const open = $derived(!dismissed && (hover || focus || pinned));

  function onClick(): void {
    dismissed = false;
    if (pinned) { pinned = false; dismissed = true; } else pinned = true;
  }
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && open) { e.stopPropagation(); pinned = false; dismissed = true; }
  }
</script>

<span class="help-tip" role="presentation" onmouseenter={() => { hover = true; dismissed = false; }} onmouseleave={() => { hover = false; }}>
  <button type="button" aria-label={`About ${label}`} aria-describedby={id} aria-expanded={open}
    onclick={onClick} onkeydown={onKeydown}
    onfocus={() => { focus = true; dismissed = false; }} onblur={() => { focus = false; pinned = false; }}>?</button>
  <span {id} role="tooltip" class="tip" hidden={!open}>{text}</span>
</span>

<style>
  .help-tip { position: relative; display: inline-flex; vertical-align: middle; }
  button {
    width: 16px; height: 16px; padding: 0; border-radius: 50%; border: 1px solid var(--border); background: var(--surface);
    color: var(--muted); font: 600 10px/1 system-ui, sans-serif; cursor: help;
  }
  button:hover, button:focus-visible { color: var(--text); border-color: var(--text); }
  .tip {
    position: absolute; top: calc(100% + 4px); left: 0; z-index: 10; width: max-content; max-width: min(280px, 80vw);
    padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text);
    font-size: 12px; line-height: 1.4; box-shadow: 0 2px 8px rgb(0 0 0 / 0.15); white-space: normal;
  }
  .tip[hidden] { display: none; }
</style>
