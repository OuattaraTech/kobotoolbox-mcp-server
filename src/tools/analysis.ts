import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "path";
import {
  LoadDataInputSchema,
  AnalyzeInputSchema,
  CrosstabInputSchema,
  DataSampleInputSchema,
  BuildReportInputSchema,
} from "../schemas/analysisSchemas.js";
import { loadDataset } from "../services/store.js";
import { profileDataset, crosstab } from "../services/analyze.js";
import { buildReportSpec, formatStats, ReportInput } from "../services/reportBuilder.js";
import { renderReport } from "../services/renderer.js";
import { resolveColumn } from "../services/dataset.js";
import { OUTPUT_DIR } from "../constants.js";
import { errorContent, truncate } from "./shared.js";

function slugify(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "rapport"
  );
}

export function registerAnalysisTools(server: McpServer): void {
  server.registerTool(
    "kobo_load_data",
    {
      title: "Load and Clean KoboToolbox Data",
      description: `Download ALL submissions of a form and prepare them for analysis. Start every analysis here.

Unlike kobo_list_submissions (one page of raw records), this pulls the whole dataset, replaces stored choice codes with their labels, converts numbers and dates, flattens groups, and reports data quality. The cleaned snapshot is cached for 15 minutes and reused by kobo_analyze, kobo_crosstab, kobo_get_data_sample and kobo_build_report.

Args:
  - uid (string): the form's asset uid
  - query (string, optional): Mongo-style server-side filter, e.g. '{"region":"Sud-Ouest"}'
  - max_rows (number): safety cap (default: everything, up to 50000)
  - language (string, optional): label language for multilingual forms
  - refresh (boolean): re-download instead of using the cache
  - response_format ('markdown' | 'json')

Returns: the list of analysable questions with their measurement type (categorical / numeric / datetime / text) and answer options, the number of submissions, and a data-quality summary (missing values, duplicates, skipped repeat groups).

Use the returned question list to decide what to analyse — its "field" values are what you pass to the other tools.`,
      inputSchema: LoadDataInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof LoadDataInputSchema>) => {
      try {
        const { dataset } = await loadDataset(params.uid, {
          query: params.query,
          maxRows: params.max_rows,
          language: params.language,
          refresh: params.refresh,
        });

        const output = {
          uid: dataset.uid,
          form_name: dataset.formName,
          language: dataset.language,
          rows_analysed: dataset.rows.length,
          rows_total: dataset.quality.rowsTotal,
          columns: dataset.columns.map((c) => ({
            field: c.path,
            question: c.header,
            measure: c.measure,
            type: c.type,
            options: c.categories,
          })),
          quality: {
            duplicate_rows: dataset.quality.duplicateRows,
            empty_questions: dataset.quality.emptyColumns,
            constant_questions: dataset.quality.constantColumns,
            most_incomplete: dataset.quality.columns
              .filter((c) => c.missingPct > 0)
              .sort((a, b) => b.missingPct - a.missingPct)
              .slice(0, 10)
              .map((c) => ({ question: c.header, missing: c.missing, missing_pct: c.missingPct })),
            notes: dataset.quality.notes,
          },
        };

        if (params.response_format === "json") {
          return {
            content: [{ type: "text" as const, text: truncate(JSON.stringify(output, null, 2)) }],
            structuredContent: output,
          };
        }

        if (!dataset.rows.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Le formulaire « ${dataset.formName} » n'a aucune soumission${params.query ? " correspondant au filtre" : ""} — rien à analyser.`,
              },
            ],
          };
        }

        const colLines = output.columns
          .filter((c) => c.measure !== "meta")
          .map((c) => {
            const opts = c.options?.length
              ? ` — options : ${c.options.slice(0, 8).join(", ")}${c.options.length > 8 ? `, +${c.options.length - 8}` : ""}`
              : "";
            return `- \`${c.field}\` (${c.measure}) : ${c.question}${opts}`;
          });

        const qualityLines = [
          `- Doublons potentiels : ${output.quality.duplicate_rows}`,
          ...(output.quality.most_incomplete.length
            ? [
                `- Questions les plus incomplètes : ${output.quality.most_incomplete
                  .slice(0, 5)
                  .map((q) => `${q.question} (${q.missing_pct}%)`)
                  .join(", ")}`,
              ]
            : ["- Aucune valeur manquante détectée"]),
          ...(output.quality.empty_questions.length
            ? [`- Questions sans aucune réponse : ${output.quality.empty_questions.join(", ")}`]
            : []),
          ...output.quality.notes.map((n) => `- ${n}`),
        ];

        const text = `**${dataset.formName}** — ${dataset.rows.length} soumission(s) analysée(s) sur ${output.rows_total}.

**Questions analysables (${colLines.length}) :**
${colLines.join("\n")}

**Qualité des données :**
${qualityLines.join("\n")}`;

        return { content: [{ type: "text" as const, text: truncate(text) }], structuredContent: output };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_analyze",
    {
      title: "Descriptive Statistics of KoboToolbox Data",
      description: `Compute descriptive statistics for every question (or a chosen subset) of a form.

For each question it returns the statistics that fit its type:
  - categorical: counts and percentages per answer option (multi-select handled correctly — percentages are of respondents, so they can exceed 100%)
  - numeric: n, mean, median, standard deviation, min, max, quartiles, sum
  - date: earliest and latest
  - free text: number of distinct answers plus examples

Args:
  - uid (string): the form's asset uid
  - columns (array, optional): restrict to these questions (field name or question label)
  - query (string, optional): Mongo-style filter
  - response_format ('markdown' | 'json')

Loads the data automatically if it isn't cached yet.

Examples:
  - Use when: "What do the responses to my cocoa form look like?" -> uid=...
  - Use when: "What's the average plot size?" -> columns=["plot_size"]
  - Don't use when: you need two questions crossed (use kobo_crosstab)`,
      inputSchema: AnalyzeInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof AnalyzeInputSchema>) => {
      try {
        const { dataset } = await loadDataset(params.uid, { query: params.query });
        if (!dataset.rows.length) {
          return { content: [{ type: "text" as const, text: "Aucune soumission à analyser." }] };
        }

        if (params.columns?.length) {
          const unknown = params.columns.filter((c) => !resolveColumn(dataset, c));
          if (unknown.length) {
            return errorContent(
              new Error(
                `Question(s) introuvable(s) : ${unknown.join(", ")}. Utilisez kobo_load_data pour voir les champs disponibles.`
              )
            );
          }
        }

        const stats = profileDataset(dataset, params.columns);
        if (!stats.length) {
          return { content: [{ type: "text" as const, text: "Aucune statistique exploitable sur ces questions." }] };
        }

        if (params.response_format === "json") {
          const output = { form_name: dataset.formName, n: dataset.rows.length, statistics: stats };
          return {
            content: [{ type: "text" as const, text: truncate(JSON.stringify(output, null, 2)) }],
            structuredContent: output,
          };
        }

        const text = `**${dataset.formName}** — statistiques sur ${dataset.rows.length} soumission(s)\n\n${formatStats(stats)}`;
        return { content: [{ type: "text" as const, text: truncate(text) }] };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_crosstab",
    {
      title: "Cross-tabulate Two KoboToolbox Questions",
      description: `Cross two questions to see how answers to one vary with the other — the core of comparative analysis.

Args:
  - uid (string): the form's asset uid
  - row_column (string): question forming the rows (field name or label)
  - col_column (string): question forming the columns
  - metric: 'count' (default), 'row_pct', 'col_pct', 'mean' or 'sum'
  - value_column (string): numeric question to average/sum — required for 'mean' and 'sum'
  - query (string, optional): Mongo-style filter
  - response_format ('markdown' | 'json')

Returns: the contingency table with row, column and grand totals, and how many submissions were excluded for missing either answer.

Examples:
  - Use when: "Is crop health worse in some regions?" -> row_column="region", col_column="crop_health"
  - Use when: "Share of each health status within each region" -> ..., metric="row_pct"
  - Use when: "Average plot size by region and crop" -> row_column="region", col_column="crop", metric="mean", value_column="plot_size"`,
      inputSchema: CrosstabInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof CrosstabInputSchema>) => {
      try {
        const { dataset } = await loadDataset(params.uid, { query: params.query });
        if (!dataset.rows.length) {
          return { content: [{ type: "text" as const, text: "Aucune soumission à croiser." }] };
        }

        const result = crosstab(dataset, {
          rowColumn: params.row_column,
          colColumn: params.col_column,
          metric: params.metric,
          valueColumn: params.value_column,
        });

        if (params.response_format === "json") {
          return {
            content: [{ type: "text" as const, text: truncate(JSON.stringify(result, null, 2)) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        }

        const unit =
          params.metric === "row_pct"
            ? "% en ligne"
            : params.metric === "col_pct"
              ? "% en colonne"
              : params.metric === "mean"
                ? `moyenne de ${result.valueLabel}`
                : params.metric === "sum"
                  ? `somme de ${result.valueLabel}`
                  : "effectifs";
        const showTotals = params.metric === "count" || params.metric === "sum";

        const header = `| ${result.rowLabel} | ${result.columns.join(" | ")}${showTotals ? " | Total" : ""} |`;
        const sep = `| --- | ${result.columns.map(() => "---").join(" | ")}${showTotals ? " | ---" : ""} |`;
        const body = result.rows.map(
          (r) => `| ${r.label} | ${r.cells.join(" | ")}${showTotals ? ` | **${r.total}**` : ""} |`
        );
        const totals = showTotals
          ? [`| **Total** | ${result.columnTotals.map((t) => `**${t}**`).join(" | ")} | **${result.grandTotal}** |`]
          : [];

        const text = `**${result.rowLabel} × ${result.colLabel}** (${unit})

${[header, sep, ...body, ...totals].join("\n")}

_${result.excluded} soumission(s) exclue(s) faute de réponse sur l'une des deux questions._`;

        return { content: [{ type: "text" as const, text: truncate(text) }] };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_get_data_sample",
    {
      title: "Read Cleaned KoboToolbox Rows",
      description: `Return actual cleaned rows of the dataset, with labels rather than codes.

Use this to read open-ended answers, sanity-check the data before drawing conclusions, or inspect specific records. For aggregate figures prefer kobo_analyze or kobo_crosstab — they are far more compact.

Args:
  - uid (string): the form's asset uid
  - limit (number): rows to return, 1-200 (default 20)
  - offset (number): rows to skip (default 0)
  - columns (array, optional): only these questions
  - query (string, optional): Mongo-style filter
  - response_format ('markdown' | 'json')`,
      inputSchema: DataSampleInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof DataSampleInputSchema>) => {
      try {
        const { dataset } = await loadDataset(params.uid, { query: params.query });
        if (!dataset.rows.length) {
          return { content: [{ type: "text" as const, text: "Aucune soumission." }] };
        }

        const cols = params.columns?.length
          ? params.columns.map((c) => resolveColumn(dataset, c)).filter((c): c is NonNullable<typeof c> => !!c)
          : dataset.columns.filter((c) => c.measure !== "meta").slice(0, 25);

        if (!cols.length) {
          return errorContent(new Error("Aucune des colonnes demandées n'existe dans ce formulaire."));
        }

        const slice = dataset.rows.slice(params.offset, params.offset + params.limit);
        const render = (v: unknown): string =>
          v === null || v === undefined ? "" : Array.isArray(v) ? v.join(" ; ") : String(v);

        if (params.response_format === "json") {
          const output = {
            total: dataset.rows.length,
            offset: params.offset,
            count: slice.length,
            columns: cols.map((c) => ({ field: c.path, question: c.header })),
            rows: slice.map((r) => Object.fromEntries(cols.map((c) => [c.path, r[c.path] ?? null]))),
          };
          return {
            content: [{ type: "text" as const, text: truncate(JSON.stringify(output, null, 2)) }],
            structuredContent: output,
          };
        }

        const header = `| ${cols.map((c) => c.header).join(" | ")} |`;
        const sep = `| ${cols.map(() => "---").join(" | ")} |`;
        const body = slice.map(
          (r) => `| ${cols.map((c) => render(r[c.path]).replace(/\|/g, "/").slice(0, 120)).join(" | ")} |`
        );
        const text = `${slice.length} ligne(s) sur ${dataset.rows.length} (à partir de ${params.offset}) :\n\n${[header, sep, ...body].join("\n")}`;
        return { content: [{ type: "text" as const, text: truncate(text) }] };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_build_report",
    {
      title: "Generate Excel / Word / PDF Analysis Report",
      description: `Produce finished deliverables from a form's data: an analytical Excel workbook, a written Word report, and/or a PDF — saved to disk.

YOU write the analysis (objective, summary, findings, section commentary, recommendations); the server computes every figure from the real submissions, so the numbers in the deliverable always match the data. Never type counts or percentages into 'custom' tables that the server can compute for you — use the directives below instead.

Each section carries your prose plus 'visuals', declared as directives:
  - {source:"frequencies", column:"crop_health", chart_kind:"pie"} — counts/% per answer, as table and chart
  - {source:"numeric_summary", column:"plot_size"} — mean/median/std/quartiles table
  - {source:"crosstab", row_column:"region", col_column:"crop_health", metric:"count"} — contingency table + grouped chart
  - {source:"custom", columns:[...], rows:[[...]]} — only for figures the server cannot derive
Each accepts: show ('table'|'chart'|'both'), chart_kind, title, note (a "how to read this" caption), top_n.

What the Excel workbook contains: a summary sheet (objective, executive summary, findings, recommendations), one sheet per section with tables and NATIVE, editable Excel charts, a cross-tab sheet, the cleaned data as a real Excel Table named 'DonneesKobo' (select it, then Insert > PivotTable to build your own pivot in two clicks), and a data-quality sheet.

Note on pivot tables: cross-tabs are delivered as computed tables, not as live PivotTable objects — no open-source library can create those. The named Excel Table above is there precisely so you can add one yourself instantly.

Args:
  - uid (string): the form's asset uid
  - objective (string): the analytical question this report answers
  - formats (array): any of 'xlsx', 'docx', 'pdf'
  - title, methodology, summary, findings[], recommendations[]: your written content
  - sections[]: {heading, text, visuals[]}
  - file_name (string, optional): base name without extension
  - query (string, optional): Mongo-style filter restricting the analysis

Returns: the full path of each generated file.

Run kobo_load_data first so you know which questions exist and what shape the data is in.`,
      inputSchema: BuildReportInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof BuildReportInputSchema>) => {
      try {
        const { dataset } = await loadDataset(params.uid, {
          query: params.query,
          maxRows: params.max_rows,
        });
        if (!dataset.rows.length) {
          return errorContent(
            new Error("Ce formulaire n'a aucune soumission à analyser — impossible de produire un rapport.")
          );
        }

        const stamp = new Date().toISOString().slice(0, 10);
        const baseName = params.file_name
          ? slugify(params.file_name)
          : `${slugify(dataset.formName)}_${stamp}`;

        const input: ReportInput = {
          title: params.title,
          objective: params.objective,
          methodology: params.methodology,
          summary: params.summary,
          findings: params.findings,
          recommendations: params.recommendations,
          sections: params.sections,
          formats: params.formats,
        };

        const spec = buildReportSpec(dataset, input, { outputDir: OUTPUT_DIR, baseName });
        const result = await renderReport(spec);

        const lines = result.files.map(
          (f) => `- **${f.format.toUpperCase()}** : \`${f.path}\` (${(f.size_bytes / 1024).toFixed(0)} Ko)`
        );
        const warnings = result.warnings.length
          ? `\n\n⚠️ ${result.warnings.join("\n⚠️ ")}`
          : "";

        const text = `Rapport généré à partir de ${dataset.rows.length} soumission(s) du formulaire « ${dataset.formName} ».

${lines.join("\n")}

Dossier : \`${path.dirname(result.files[0]?.path ?? OUTPUT_DIR)}\`${warnings}`;

        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { files: result.files, warnings: result.warnings, output_dir: OUTPUT_DIR },
        };
      } catch (error) {
        return errorContent(error);
      }
    }
  );
}
