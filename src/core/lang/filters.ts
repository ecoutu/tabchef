export type Tables = Record<string, Record<string, string>>;

export interface FilterDef {
  /** Number of `:`-separated arguments the filter takes. */
  arity: number;
  apply: (value: string, args: string[], tables: Tables) => string;
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Template filters, applied left to right. Fixed set; never user-extensible. */
export const FILTERS: Record<string, FilterDef> = Object.assign(Object.create(null) as Record<string, FilterDef>, {
  upper: { arity: 0, apply: (v: string) => v.toUpperCase() },
  lower: { arity: 0, apply: (v: string) => v.toLowerCase() },
  trim: { arity: 0, apply: (v: string) => v.trim() },
  // Literal, all-occurrences replace (never a regex). An empty replacement deletes.
  replace: { arity: 2, apply: (v: string, [a, b]: string[]) => (a === '' ? v : v.split(a as string).join(b as string)) },
  // Missing table or key yields '' so `default:` can catch it.
  map: {
    arity: 1,
    apply: (v: string, [t]: string[], tables: Tables) => {
      const table = own(tables, t as string) ? tables[t as string] : undefined;
      return table && own(table, v) ? (table[v] ?? '') : '';
    },
  },
  default: { arity: 1, apply: (v: string, [d]: string[]) => (v === '' ? (d as string) : v) },
});
