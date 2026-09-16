import { Dataset, DatasetColumn, resolveColumn } from "./dataset.js";

export interface Frequency {
  value: string;
  count: number;
  pct: number;
}

export type ColumnStats =
  | {
      kind: "categorical";
      header: string;
      label: string;
      n: number;
      missing: number;
      unique: number;
      multiSelect: boolean;
      frequencies: Frequency[];
    }
  | {
      kind: "numeric";
      header: string;
      label: string;
      n: number;
      missing: number;
      min: number;
      max: number;
      mean: number;
      median: number;
      std: number;
      q1: number;
      q3: number;
      sum: number;
    }
  | {
      kind: "datetime";
      header: string;
      label: string;
      n: number;
      missing: number;
      earliest: string;
      latest: string;
    }
  | {
      kind: "text";
      header: string;
      label: string;
      n: number;
      missing: number;
      unique: number;
      samples: string[];
    };

const round = (v: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Expands a cell into the value(s) it contributes; select_multiple yields several. */
function valuesOf(cell: unknown): string[] {
  if (cell === null || cell === undefined) return [];
  if (Array.isArray(cell)) return cell.map((v) => String(v));
  const s = String(cell);
  return s.trim() === "" ? [] : [s];
}

function profileColumn(dataset: Dataset, col: DatasetColumn): ColumnStats | null {
  const cells = dataset.rows.map((r) => r[col.path]);
  const answered = cells.filter((c) => valuesOf(c).length > 0);
  const missing = cells.length - answered.length;

  if (col.measure === "numeric") {
    const nums = answered
      .map(Number)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (!nums.length) return null;
    const sum = nums.reduce((a, b) => a + b, 0);
    const mean = sum / nums.length;
    const variance = nums.reduce((acc, n) => acc + (n - mean) ** 2, 0) / nums.length;
    return {
      kind: "numeric",
      header: col.header,
      label: col.label,
      n: nums.length,
      missing,
      min: round(nums[0]),
      max: round(nums[nums.length - 1]),
      mean: round(mean),
      median: round(quantile(nums, 0.5)),
      std: round(Math.sqrt(variance)),
      q1: round(quantile(nums, 0.25)),
      q3: round(quantile(nums, 0.75)),
      sum: round(sum),
    };
  }

  if (col.measure === "datetime") {
    const dates = answered
      .map((c) => String(c))
      .filter((s) => !Number.isNaN(Date.parse(s)))
      .sort();
    if (!dates.length) return null;
    return {
      kind: "datetime",
      header: col.header,
      label: col.label,
      n: dates.length,
      missing,
      earliest: dates[0],
      latest: dates[dates.length - 1],
    };
  }

  if (col.measure === "categorical") {
    const multi = col.type.startsWith("select_multiple");
    const counts = new Map<string, number>();
    for (const cell of cells) {
      for (const v of valuesOf(cell)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (!counts.size) return null;

    // Percentages are of respondents, so a multi-select column can exceed 100%.
    const base = answered.length || 1;
    const entries = [...counts.entries()];
    // Respect the order declared in the form when we know it.
    if (col.categories?.length) {
      const order = new Map(col.categories.map((c, i) => [c, i]));
      entries.sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999) || b[1] - a[1]);
    } else {
      entries.sort((a, b) => b[1] - a[1]);
    }

    return {
      kind: "categorical",
      header: col.header,
      label: col.label,
      n: answered.length,
      missing,
      unique: counts.size,
      multiSelect: multi,
      frequencies: entries.map(([value, count]) => ({
        value,
        count,
        pct: round((count / base) * 100, 1),
      })),
    };
  }

  // Free text / geo / everything else: describe rather than aggregate.
  const seen = new Map<string, number>();
  for (const cell of answered) {
    const v = String(cell);
    seen.set(v, (seen.get(v) ?? 0) + 1);
  }
  // A low-cardinality text column is really a category - treat it as one.
  if (col.measure === "text" && seen.size > 0 && seen.size <= 25 && answered.length >= seen.size * 2) {
    const entries = [...seen.entries()].sort((a, b) => b[1] - a[1]);
    return {
      kind: "categorical",
      header: col.header,
      label: col.label,
      n: answered.length,
      missing,
      unique: seen.size,
      multiSelect: false,
      frequencies: entries.map(([value, count]) => ({
        value,
        count,
        pct: round((count / (answered.length || 1)) * 100, 1),
      })),
    };
  }

  return {
    kind: "text",
    header: col.header,
    label: col.label,
    n: answered.length,
    missing,
    unique: seen.size,
    samples: [...seen.keys()].slice(0, 5),
  };
}

export function profileDataset(dataset: Dataset, only?: string[]): ColumnStats[] {
  const targets = only?.length
    ? (only.map((ref) => resolveColumn(dataset, ref)).filter(Boolean) as DatasetColumn[])
    : dataset.columns.filter((c) => c.measure !== "meta" && c.path !== "_submitted_by");

  return targets.map((col) => profileColumn(dataset, col)).filter((s): s is ColumnStats => s !== null);
}

export interface CrosstabResult {
  rowLabel: string;
  colLabel: string;
  metric: string;
  valueLabel?: string;
  /** Column headers of the table, excluding the leading row-label column. */
  columns: string[];
  /** One entry per row: its label plus a cell per column. */
  rows: Array<{ label: string; cells: number[]; total: number }>;
  columnTotals: number[];
  grandTotal: number;
  /** Submissions where either variable was unanswered. */
  excluded: number;
}

/**
 * Cross-tabulates two questions. Counts by default; with metric "mean" or "sum"
 * it aggregates a third, numeric question inside each cell.
 */
export function crosstab(
  dataset: Dataset,
  opts: {
    rowColumn: string;
    colColumn: string;
    metric?: "count" | "row_pct" | "col_pct" | "mean" | "sum";
    valueColumn?: string;
  }
): CrosstabResult {
  const rowCol = resolveColumn(dataset, opts.rowColumn);
  const colCol = resolveColumn(dataset, opts.colColumn);
  if (!rowCol) throw new Error(`Colonne introuvable pour les lignes : "${opts.rowColumn}"`);
  if (!colCol) throw new Error(`Colonne introuvable pour les colonnes : "${opts.colColumn}"`);

  const metric = opts.metric ?? "count";
  const isAggregate = metric === "mean" || metric === "sum";
  let valueCol: DatasetColumn | undefined;
  if (isAggregate) {
    if (!opts.valueColumn) {
      throw new Error(`La metrique "${metric}" exige une colonne de valeurs numeriques (value_column).`);
    }
    valueCol = resolveColumn(dataset, opts.valueColumn);
    if (!valueCol) throw new Error(`Colonne de valeurs introuvable : "${opts.valueColumn}"`);
    if (valueCol.measure !== "numeric") {
      throw new Error(`La colonne "${valueCol.header}" n'est pas numerique.`);
    }
  }

  // Each cell collects its contributions: 1 per observation for counts,
  // the numeric value itself for mean/sum.
  const cells = new Map<string, number[]>();
  const rowKeys: string[] = [];
  const colKeys: string[] = [];
  const seenRow = new Set<string>();
  const seenCol = new Set<string>();
  let excluded = 0;

  for (const r of dataset.rows) {
    const rVals = valuesOf(r[rowCol.path]);
    const cVals = valuesOf(r[colCol.path]);
    if (!rVals.length || !cVals.length) {
      excluded++;
      continue;
    }
    let contribution = 1;
    if (valueCol) {
      const n = Number(r[valueCol.path]);
      if (!Number.isFinite(n)) {
        excluded++;
        continue;
      }
      contribution = n;
    }
    for (const rv of rVals) {
      if (!seenRow.has(rv)) {
        seenRow.add(rv);
        rowKeys.push(rv);
      }
      for (const cv of cVals) {
        if (!seenCol.has(cv)) {
          seenCol.add(cv);
          colKeys.push(cv);
        }
        const key = `${rv} ${cv}`;
        const bucket = cells.get(key);
        if (bucket) bucket.push(contribution);
        else cells.set(key, [contribution]);
      }
    }
  }

  const orderBy = (keys: string[], col: DatasetColumn): string[] => {
    if (!col.categories?.length) return keys.sort((a, b) => a.localeCompare(b, "fr"));
    const order = new Map(col.categories.map((c, i) => [c, i]));
    return keys.sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999) || a.localeCompare(b, "fr"));
  };
  const sortedRows = orderBy(rowKeys, rowCol);
  const sortedCols = orderBy(colKeys, colCol);

  const aggregate = (vals: number[] | undefined): number => {
    if (!vals?.length) return 0;
    const total = vals.reduce((a, b) => a + b, 0);
    if (metric === "mean") return round(total / vals.length);
    return round(total, metric === "count" ? 0 : 2);
  };

  const raw = sortedRows.map((rk) => sortedCols.map((ck) => aggregate(cells.get(`${rk} ${ck}`))));

  // A mean-of-means is misleading, so margins for "mean" are recomputed from
  // the underlying observations rather than from the displayed cells.
  const marginOf = (keys: Array<{ rk: string; ck: string }>): number => {
    const pooled: number[] = [];
    for (const { rk, ck } of keys) pooled.push(...(cells.get(`${rk} ${ck}`) ?? []));
    return aggregate(pooled);
  };

  const rowTotals = sortedRows.map((rk) => marginOf(sortedCols.map((ck) => ({ rk, ck }))));
  const columnTotals = sortedCols.map((ck) => marginOf(sortedRows.map((rk) => ({ rk, ck }))));
  const grandTotal = marginOf(sortedRows.flatMap((rk) => sortedCols.map((ck) => ({ rk, ck }))));

  // Percentage metrics rescale the raw counts.
  let display = raw;
  if (metric === "row_pct") {
    display = raw.map((row, ri) => row.map((v) => (rowTotals[ri] ? round((v / rowTotals[ri]) * 100, 1) : 0)));
  } else if (metric === "col_pct") {
    display = raw.map((row) => row.map((v, ci) => (columnTotals[ci] ? round((v / columnTotals[ci]) * 100, 1) : 0)));
  }

  return {
    rowLabel: rowCol.header,
    colLabel: colCol.header,
    metric,
    valueLabel: valueCol?.header,
    columns: sortedCols,
    rows: sortedRows.map((label, ri) => ({
      label,
      cells: display[ri],
      total: metric === "row_pct" ? 100 : rowTotals[ri],
    })),
    columnTotals,
    grandTotal,
    excluded,
  };
}
