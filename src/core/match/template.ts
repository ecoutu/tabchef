const TOKEN = /\{(\w+)(?:\|(\w+))?\}/g;

/** Renders `{name}`, `{name|upper}`, `{name|lower}`. Unknown vars render as ''. */
export function renderTemplate(t: string, vars: Record<string, string>): string {
  return t.replace(TOKEN, (_m, name: string, filter?: string) => {
    const v = Object.prototype.hasOwnProperty.call(vars, name) ? (vars[name] ?? '') : '';
    if (filter === 'upper') return v.toUpperCase();
    if (filter === 'lower') return v.toLowerCase();
    return v;
  });
}
