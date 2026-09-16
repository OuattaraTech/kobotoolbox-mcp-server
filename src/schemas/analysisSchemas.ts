import { z } from "zod";
import { MAX_FETCH_ROWS } from "../constants.js";
import { ResponseFormatSchema } from "./schemas.js";

const UidSchema = z.string().min(1).describe("Asset uid of the form (from kobo_list_forms)");

const QuerySchema = z
  .string()
  .optional()
  .describe(
    'Optional Mongo-style filter applied server-side, e.g. \'{"region":"Sud-Ouest"}\' or \'{"_submission_time":{"$gte":"2026-01-01"}}\''
  );

const MaxRowsSchema = z
  .number()
  .int()
  .min(1)
  .max(1000000)
  .default(MAX_FETCH_ROWS)
  .describe(
    `How many submissions to pull. Defaults to ${MAX_FETCH_ROWS}, which protects against dragging a huge project into memory; pass a higher value explicitly to analyse a project larger than that.`
  );

export const LoadDataInputSchema = z
  .object({
    uid: UidSchema,
    query: QuerySchema,
    max_rows: MaxRowsSchema,
    language: z
      .string()
      .optional()
      .describe("Preferred label language for multilingual forms, e.g. 'Français' or 'fr'"),
    refresh: z
      .boolean()
      .default(false)
      .describe("Force a fresh download instead of reusing the cached snapshot (cache lasts 15 min)"),
    response_format: ResponseFormatSchema,
  })
  .strict();

export const AnalyzeInputSchema = z
  .object({
    uid: UidSchema,
    columns: z
      .array(z.string())
      .optional()
      .describe("Restrict the profile to these questions (field name or question label). Omit for all."),
    query: QuerySchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

export const CrosstabInputSchema = z
  .object({
    uid: UidSchema,
    row_column: z.string().min(1).describe("Question forming the rows of the table (field name or label)"),
    col_column: z.string().min(1).describe("Question forming the columns of the table"),
    metric: z
      .enum(["count", "row_pct", "col_pct", "mean", "sum"])
      .default("count")
      .describe(
        "count = number of submissions; row_pct/col_pct = percentages; mean/sum = aggregate value_column inside each cell"
      ),
    value_column: z
      .string()
      .optional()
      .describe("Numeric question to average or sum. Required when metric is 'mean' or 'sum'."),
    query: QuerySchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

export const DataSampleInputSchema = z
  .object({
    uid: UidSchema,
    limit: z.number().int().min(1).max(200).default(20).describe("How many cleaned rows to return"),
    offset: z.number().int().min(0).default(0).describe("Rows to skip, for paging through the data"),
    columns: z
      .array(z.string())
      .optional()
      .describe("Only return these questions. Omit for all columns."),
    query: QuerySchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

const VisualDirectiveSchema = z
  .object({
    source: z
      .enum(["frequencies", "numeric_summary", "crosstab", "custom"])
      .describe(
        "What to compute. 'frequencies' = counts per answer of one question; 'numeric_summary' = mean/median/etc of a numeric question; 'crosstab' = two questions crossed; 'custom' = a table whose numbers you supply yourself."
      ),
    column: z.string().optional().describe("Question to analyse, for 'frequencies' and 'numeric_summary'"),
    row_column: z.string().optional().describe("Rows of the cross-tab"),
    col_column: z.string().optional().describe("Columns of the cross-tab"),
    value_column: z.string().optional().describe("Numeric question aggregated by 'mean'/'sum' cross-tabs"),
    metric: z
      .enum(["count", "row_pct", "col_pct", "mean", "sum"])
      .optional()
      .describe("Cross-tab metric (default 'count')"),
    show: z
      .enum(["table", "chart", "both"])
      .default("both")
      .describe("Render this as a table, a chart, or both"),
    chart_kind: z
      .enum(["column", "bar", "pie", "doughnut", "line"])
      .optional()
      .describe("Chart type. Omit to let the server pick one suited to the data."),
    title: z.string().optional().describe("Heading shown above the table/chart"),
    note: z.string().optional().describe("Caption under the table/chart, e.g. how to read it"),
    top_n: z.number().int().min(1).max(50).optional().describe("Keep only the N most frequent answers"),
    columns: z.array(z.string()).optional().describe("For 'custom': the column headers"),
    rows: z
      .array(z.array(z.union([z.string(), z.number(), z.null()])))
      .optional()
      .describe("For 'custom': the table body, one array per row"),
  })
  .strict();

const SectionSchema = z
  .object({
    heading: z.string().min(1).describe("Section title, e.g. 'État sanitaire des cultures'"),
    text: z
      .string()
      .optional()
      .describe("Your written analysis for this section: what the data shows and what it means. Use \\n between paragraphs."),
    visuals: z
      .array(VisualDirectiveSchema)
      .optional()
      .describe("Tables and charts to compute from the real data and place in this section"),
  })
  .strict();

export const BuildReportInputSchema = z
  .object({
    uid: UidSchema,
    objective: z
      .string()
      .min(1)
      .describe("The analytical objective this report answers, in the user's own terms"),
    title: z.string().optional().describe("Report title. Defaults to 'Analyse — <form name>'."),
    formats: z
      .array(z.enum(["xlsx", "docx", "pdf"]))
      .min(1)
      .default(["xlsx"])
      .describe("Deliverables to produce: 'xlsx' analytical workbook, 'docx' written report, 'pdf' of that report"),
    methodology: z.string().optional().describe("How the analysis was conducted, including any filters applied"),
    summary: z.string().optional().describe("Executive summary: the headline answer to the objective"),
    findings: z.array(z.string()).optional().describe("Key findings, one per bullet, each citing a figure"),
    recommendations: z
      .array(z.string())
      .optional()
      .describe("Actionable recommendations that follow from the findings"),
    sections: z
      .array(SectionSchema)
      .min(1)
      .max(20)
      .describe("Body of the report: your analysis, section by section, with the tables and charts to compute"),
    file_name: z
      .string()
      .optional()
      .describe("Base file name without extension. Defaults to a slug of the form name and date."),
    query: QuerySchema,
    max_rows: MaxRowsSchema,
  })
  .strict();
