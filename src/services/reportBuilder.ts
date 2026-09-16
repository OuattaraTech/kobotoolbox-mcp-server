import { Dataset, resolveColumn } from "./dataset.js";
import { crosstab, profileDataset, ColumnStats } from "./analyze.js";

export interface VisualDirective {
  source: "frequencies" | "numeric_summary" | "crosstab" | "custom";
  column?: string;
  row_column?: string;
  col_column?: string;
  value_column?: string;
  metric?: "count" | "row_pct" | "col_pct" | "mean" | "sum";
  show?: "table" | "chart" | "both";
  chart_kind?: "column" | "bar" | "pie" | "doughnut" | "line";
  title?: string;
  note?: string;
  top_n?: number;
  columns?: string[];
  rows?: Array<Array<string | number | null>>;
}

export interface SectionInput {
  heading: string;
  text?: string;
  visuals?: VisualDirective[];
}

export interface ReportInput {
  title?: string;
  objective: string;
  methodology?: string;
  summary?: string;
  findings?: string[];
  recommendations?: string[];
  sections: SectionInput[];
  formats: string[];
  base_name?: string;
}

interface SpecTable {
  title?: string;
  columns: Array<string | number>;
  rows: Array<Array<string | number | null>>;
  total_row_label?: string;
  note?: string;
}

interface SpecChart {
  kind: string;
  title?: string;
  categories: string[];
  series: Array<{ name: string; values: Array<number | null> }>;
  x_title?: string;
  y_title?: string;
  note?: string;
}

const TOTAL_LABEL = "Total";

/** Picks a chart type that suits the shape of the data when none is given. */
function defaultChartKind(categoryCount: number, seriesCount: number, multiSelect: boolean): string {
  if (seriesCount > 1) return "column";
  if (multiSelect) return categoryCount > 8 ? "bar" : "column";
  if (categoryCount <= 6) return "pie";
  if (categoryCount <= 12) return "column";
  return "bar";
}

function metricLabel(metric: string, valueLabel?: string): string {
  switch (metric) {
    case "row_pct":
      return "% en ligne";
    case "col_pct":
      return "% en colonne";
    case "mean":
      return `Moyenne de ${valueLabel ?? "la valeur"}`;
    case "sum":
      return `Somme de ${valueLabel ?? "la valeur"}`;
    default:
      return "Effectif";
  }
}

function buildFrequencies(
  dataset: Dataset,
  d: VisualDirective
): { table?: SpecTable; chart?: SpecChart } {
  if (!d.column) throw new Error(`Une visualisation "frequencies" exige un champ "column".`);
  const col = resolveColumn(dataset, d.column);
  if (!col) throw new Error(`Colonne introuvable : "${d.column}".`);

  const stats = profileDataset(dataset, [d.column])[0];
  if (!stats) throw new Error(`Aucune donnée exploitable pour la colonne "${col.header}".`);
  if (stats.kind !== "categorical") {
    throw new Error(
      `La colonne "${col.header}" est de type ${stats.kind} — utilisez "numeric_summary" plutôt que "frequencies".`
    );
  }

  let freqs = stats.frequencies;
  let truncatedNote = "";
  if (d.top_n && freqs.length > d.top_n) {
    const rest = freqs.slice(d.top_n);
    const restCount = rest.reduce((a, f) => a + f.count, 0);
    freqs = freqs.slice(0, d.top_n);
    truncatedNote = ` Les ${rest.length} modalités restantes (${restCount} réponses) sont regroupées hors tableau.`;
  }

  const title = d.title ?? col.label;
  const show = d.show ?? "both";

  const table: SpecTable | undefined =
    show === "chart"
      ? undefined
      : {
          title,
          columns: [col.header, "Effectif", "%"],
          rows: [
            ...freqs.map((f) => [f.value, f.count, f.pct] as Array<string | number | null>),
            [TOTAL_LABEL, stats.n, stats.multiSelect ? null : 100],
          ],
          total_row_label: TOTAL_LABEL,
          note:
            (d.note ?? "") +
            ` Base : ${stats.n} répondant(s)${stats.missing ? `, ${stats.missing} non-réponse(s)` : ""}.` +
            (stats.multiSelect ? " Question à choix multiples : le total des pourcentages dépasse 100%." : "") +
            truncatedNote,
        };

  const chart: SpecChart | undefined =
    show === "table"
      ? undefined
      : {
          kind: d.chart_kind ?? defaultChartKind(freqs.length, 1, stats.multiSelect),
          title,
          categories: freqs.map((f) => f.value),
          series: [{ name: "Effectif", values: freqs.map((f) => f.count) }],
          y_title: "Nombre de réponses",
          note: d.note,
        };

  return { table, chart };
}

function buildNumericSummary(dataset: Dataset, d: VisualDirective): { table?: SpecTable } {
  if (!d.column) throw new Error(`Une visualisation "numeric_summary" exige un champ "column".`);
  const col = resolveColumn(dataset, d.column);
  if (!col) throw new Error(`Colonne introuvable : "${d.column}".`);

  const stats = profileDataset(dataset, [d.column])[0];
  if (!stats) throw new Error(`Aucune donnée exploitable pour la colonne "${col.header}".`);
  if (stats.kind !== "numeric") {
    throw new Error(`La colonne "${col.header}" n'est pas numérique (type détecté : ${stats.kind}).`);
  }

  return {
    table: {
      title: d.title ?? `Statistiques — ${col.label}`,
      columns: ["Indicateur", "Valeur"],
      rows: [
        ["Réponses", stats.n],
        ["Non-réponses", stats.missing],
        ["Moyenne", stats.mean],
        ["Médiane", stats.median],
        ["Écart-type", stats.std],
        ["Minimum", stats.min],
        ["1er quartile", stats.q1],
        ["3e quartile", stats.q3],
        ["Maximum", stats.max],
        ["Somme", stats.sum],
      ],
      note: d.note,
    },
  };
}

function buildCrosstab(dataset: Dataset, d: VisualDirective): { table?: SpecTable; chart?: SpecChart } {
  if (!d.row_column || !d.col_column) {
    throw new Error(`Une visualisation "crosstab" exige "row_column" et "col_column".`);
  }
  const metric = d.metric ?? "count";
  const ct = crosstab(dataset, {
    rowColumn: d.row_column,
    colColumn: d.col_column,
    metric,
    valueColumn: d.value_column,
  });

  const unit = metricLabel(metric, ct.valueLabel);
  const title = d.title ?? `${ct.rowLabel} × ${ct.colLabel} (${unit.toLowerCase()})`;
  const show = d.show ?? "both";
  const showTotals = metric === "count" || metric === "sum";

  const rows: Array<Array<string | number | null>> = ct.rows.map((r) => [
    r.label,
    ...r.cells,
    ...(showTotals ? [r.total] : []),
  ]);
  if (showTotals) {
    rows.push([TOTAL_LABEL, ...ct.columnTotals, ct.grandTotal]);
  }

  const table: SpecTable | undefined =
    show === "chart"
      ? undefined
      : {
          title,
          columns: [ct.rowLabel, ...ct.columns, ...(showTotals ? [TOTAL_LABEL] : [])],
          rows,
          total_row_label: TOTAL_LABEL,
          note:
            (d.note ?? "") +
            ` Valeurs : ${unit.toLowerCase()}.` +
            (ct.excluded ? ` ${ct.excluded} soumission(s) exclue(s) faute de réponse sur l'une des deux questions.` : ""),
        };

  const chart: SpecChart | undefined =
    show === "table"
      ? undefined
      : {
          kind: d.chart_kind ?? "column",
          title,
          categories: ct.rows.map((r) => r.label),
          series: ct.columns.map((c, ci) => ({
            name: c,
            values: ct.rows.map((r) => r.cells[ci] ?? 0),
          })),
          x_title: ct.rowLabel,
          y_title: unit,
          note: d.note,
        };

  return { table, chart };
}

function buildCustom(d: VisualDirective): { table?: SpecTable } {
  if (!d.columns?.length || !d.rows) {
    throw new Error(`Une visualisation "custom" exige "columns" et "rows".`);
  }
  return {
    table: {
      title: d.title,
      columns: d.columns,
      rows: d.rows,
      note: d.note,
    },
  };
}

/**
 * Turns the model's narrative plus its visual directives into the JSON spec the
 * Python renderer consumes. Every number in the deliverable is computed here
 * from the actual submissions, so the report cannot drift from the data.
 */
export function buildReportSpec(
  dataset: Dataset,
  input: ReportInput,
  opts: { outputDir: string; baseName: string }
): Record<string, unknown> {
  const sections = input.sections.map((section) => {
    // A single ordered list keeps every table next to the chart that
    // illustrates it, instead of grouping all tables then all charts.
    const items: Array<Record<string, unknown>> = [];

    for (const directive of section.visuals ?? []) {
      let produced: { table?: SpecTable; chart?: SpecChart };
      switch (directive.source) {
        case "frequencies":
          produced = buildFrequencies(dataset, directive);
          break;
        case "numeric_summary":
          produced = buildNumericSummary(dataset, directive);
          break;
        case "crosstab":
          produced = buildCrosstab(dataset, directive);
          break;
        case "custom":
          produced = buildCustom(directive);
          break;
        default:
          throw new Error(`Type de visualisation inconnu : "${(directive as VisualDirective).source}".`);
      }
      // "block" rather than "kind": a chart's own `kind` is its chart type.
      if (produced.table) items.push({ ...produced.table, block: "table" });
      if (produced.chart) items.push({ ...produced.chart, block: "chart" });
    }

    return {
      heading: section.heading,
      text: section.text ?? "",
      items,
    };
  });

  return {
    output_dir: opts.outputDir,
    base_name: opts.baseName,
    formats: input.formats,
    title: input.title ?? `Analyse — ${dataset.formName}`,
    objective: input.objective,
    methodology: input.methodology ?? "",
    form_name: dataset.formName,
    generated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    n_rows: dataset.rows.length,
    summary: input.summary ?? "",
    findings: input.findings ?? [],
    recommendations: input.recommendations ?? [],
    sections,
    dataset: {
      columns: dataset.columns.map((c) => ({
        path: c.path,
        header: c.header,
        measure: c.measure,
      })),
      rows: dataset.rows,
    },
    quality: dataset.quality,
  };
}

/** Compact, human-readable rendering of descriptive statistics for chat. */
export function formatStats(stats: ColumnStats[]): string {
  const blocks = stats.map((s) => {
    if (s.kind === "categorical") {
      const lines = s.frequencies
        .slice(0, 15)
        .map((f) => `    - ${f.value} : ${f.count} (${f.pct}%)`)
        .join("\n");
      const more = s.frequencies.length > 15 ? `\n    - ... ${s.frequencies.length - 15} autres modalités` : "";
      return `**${s.header}** — ${s.multiSelect ? "choix multiples" : "choix unique"}, ${s.n} réponse(s), ${s.missing} manquante(s)\n${lines}${more}`;
    }
    if (s.kind === "numeric") {
      return `**${s.header}** — numérique, ${s.n} réponse(s), ${s.missing} manquante(s)\n    moyenne ${s.mean} | médiane ${s.median} | écart-type ${s.std} | min ${s.min} | max ${s.max} | Q1 ${s.q1} | Q3 ${s.q3} | somme ${s.sum}`;
    }
    if (s.kind === "datetime") {
      return `**${s.header}** — dates, ${s.n} réponse(s)\n    du ${s.earliest} au ${s.latest}`;
    }
    return `**${s.header}** — texte libre, ${s.n} réponse(s), ${s.unique} valeur(s) distincte(s)\n    exemples : ${s.samples.join(" | ") || "(aucun)"}`;
  });
  return blocks.join("\n\n");
}
