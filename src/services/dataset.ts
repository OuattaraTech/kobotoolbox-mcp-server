import { Codebook, FieldDef } from "./codebook.js";

export interface DatasetColumn {
  /** Submission key, e.g. "section_a/crop_health". */
  path: string;
  /** Short, unique, human-readable header used in deliverables. */
  header: string;
  label: string;
  type: string;
  measure: FieldDef["measure"];
  /** Ordered choice labels, for categorical columns (drives chart ordering). */
  categories?: string[];
}

export interface ColumnQuality {
  path: string;
  header: string;
  measure: string;
  missing: number;
  missingPct: number;
  unique: number;
  constant: boolean;
  empty: boolean;
  /** Choice codes found in data that the form doesn't define. */
  unknownCodes?: string[];
}

export interface QualityReport {
  rowsFetched: number;
  rowsTotal: number;
  truncated: boolean;
  duplicateRows: number;
  columns: ColumnQuality[];
  emptyColumns: string[];
  constantColumns: string[];
  repeatGroupsSkipped: string[];
  notes: string[];
}

export interface Dataset {
  uid: string;
  formName: string;
  language: string | null;
  columns: DatasetColumn[];
  /** One record per submission, keyed by column path, values already labelled. */
  rows: Array<Record<string, unknown>>;
  quality: QualityReport;
}

/** Metadata Kobo adds to every submission that is worth keeping for analysis. */
const META_COLUMNS: Array<{ path: string; label: string; measure: DatasetColumn["measure"]; type: string }> = [
  { path: "_id", label: "ID soumission", measure: "meta", type: "integer" },
  { path: "_submission_time", label: "Date de soumission", measure: "datetime", type: "datetime" },
  { path: "_submitted_by", label: "Soumis par", measure: "categorical", type: "text" },
  { path: "_validation_status", label: "Statut de validation", measure: "categorical", type: "text" },
];

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/** Builds unique, readable column headers from question labels. */
function makeHeaders(fields: Array<{ path: string; label: string }>): Record<string, string> {
  const used = new Map<string, number>();
  const out: Record<string, string> = {};
  for (const f of fields) {
    // Collapse whitespace and trim overly long question text.
    let base = f.label.replace(/\s+/g, " ").trim();
    if (base.length > 100) base = base.slice(0, 97) + "...";
    if (!base) base = f.path;

    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    out[f.path] = seen === 0 ? base : `${base} (${seen + 1})`;
  }
  return out;
}

function cleanValue(
  raw: unknown,
  field: FieldDef,
  unknownCodes: Set<string>
): unknown {
  if (isMissing(raw)) return null;

  switch (field.measure) {
    case "numeric": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
      return Number.isFinite(n) ? n : null;
    }
    case "categorical": {
      const map = field.choiceMap;
      if (field.type.startsWith("select_multiple")) {
        const codes = String(raw).trim().split(/\s+/).filter(Boolean);
        const labels = codes.map((c) => {
          if (map && !(c in map)) unknownCodes.add(c);
          return map?.[c] ?? c;
        });
        return labels;
      }
      const code = String(raw).trim();
      if (map && !(code in map)) unknownCodes.add(code);
      return map?.[code] ?? code;
    }
    default:
      return raw;
  }
}

/**
 * Turns raw Kobo submissions into a clean, labelled, analysis-ready table:
 * choice codes become choice labels, numbers become numbers, blanks become
 * nulls, and a quality report flags what an analyst needs to know before
 * drawing conclusions.
 */
export function buildDataset(
  codebook: Codebook,
  raw: Array<Record<string, unknown>>,
  meta: { total: number; truncated: boolean }
): Dataset {
  // Repeating groups hold nested tables; they can't live in a flat column.
  const flatFields = codebook.fields.filter((f) => !f.inRepeat && f.measure !== "media");
  const mediaFields = codebook.fields.filter((f) => f.measure === "media");

  const headerSource = [
    ...flatFields.map((f) => ({ path: f.path, label: f.label })),
    ...META_COLUMNS.map((m) => ({ path: m.path, label: m.label })),
  ];
  const headers = makeHeaders(headerSource);

  const columns: DatasetColumn[] = [
    ...flatFields.map((f) => ({
      path: f.path,
      header: headers[f.path],
      label: f.label,
      type: f.type,
      measure: f.measure,
      categories: f.choices?.map((c) => c.label),
    })),
    ...META_COLUMNS.map((m) => ({
      path: m.path,
      header: headers[m.path],
      label: m.label,
      type: m.type,
      measure: m.measure,
    })),
  ];

  const unknownByPath = new Map<string, Set<string>>();
  const rows = raw.map((sub) => {
    const rec: Record<string, unknown> = {};
    for (const f of flatFields) {
      const unknown = unknownByPath.get(f.path) ?? new Set<string>();
      unknownByPath.set(f.path, unknown);
      rec[f.path] = cleanValue(sub[f.path], f, unknown);
    }
    for (const m of META_COLUMNS) {
      let v = sub[m.path];
      // _validation_status is an object like {label: "Approved", uid: "..."}.
      if (m.path === "_validation_status" && v && typeof v === "object") {
        v = (v as Record<string, unknown>)["label"] ?? null;
      }
      rec[m.path] = isMissing(v) ? null : v;
    }
    return rec;
  });

  // ---- Quality report -----------------------------------------------------
  const columnQuality: ColumnQuality[] = columns.map((col) => {
    let missing = 0;
    const seen = new Set<string>();
    for (const r of rows) {
      const v = r[col.path];
      if (v === null || (Array.isArray(v) && v.length === 0)) {
        missing++;
      } else {
        seen.add(Array.isArray(v) ? v.join("|") : String(v));
      }
    }
    const unknown = unknownByPath.get(col.path);
    return {
      path: col.path,
      header: col.header,
      measure: col.measure,
      missing,
      missingPct: rows.length ? Math.round((missing / rows.length) * 1000) / 10 : 0,
      unique: seen.size,
      constant: seen.size === 1 && rows.length > 1,
      empty: seen.size === 0,
      unknownCodes: unknown && unknown.size ? [...unknown].slice(0, 10) : undefined,
    };
  });

  // Duplicates are judged on answers only, ignoring Kobo's per-submission metadata.
  const answerPaths = flatFields.map((f) => f.path);
  const fingerprints = new Set<string>();
  let duplicateRows = 0;
  for (const r of rows) {
    const fp = JSON.stringify(answerPaths.map((p) => r[p]));
    if (fingerprints.has(fp)) duplicateRows++;
    else fingerprints.add(fp);
  }

  const notes: string[] = [];
  if (meta.truncated) {
    notes.push(
      `Seules ${rows.length} soumissions sur ${meta.total} ont été récupérées (plafond de sécurité). Les analyses portent sur cet échantillon.`
    );
  }
  if (codebook.repeatGroups.length) {
    notes.push(
      `Le formulaire contient ${codebook.repeatGroups.length} groupe(s) répétitif(s) (${codebook.repeatGroups.join(", ")}) : leurs réponses imbriquées ne figurent pas dans le tableau plat.`
    );
  }
  if (mediaFields.length) {
    notes.push(
      `${mediaFields.length} question(s) de type photo/audio/fichier ont été exclues du tableau (elles ne contiennent que des noms de fichiers).`
    );
  }
  if (duplicateRows) {
    notes.push(`${duplicateRows} soumission(s) ont des réponses strictement identiques à une autre — doublons possibles.`);
  }

  return {
    uid: codebook.uid,
    formName: codebook.formName,
    language: codebook.language,
    columns,
    rows,
    quality: {
      rowsFetched: rows.length,
      rowsTotal: meta.total,
      truncated: meta.truncated,
      duplicateRows,
      columns: columnQuality,
      emptyColumns: columnQuality.filter((c) => c.empty).map((c) => c.header),
      constantColumns: columnQuality.filter((c) => c.constant).map((c) => c.header),
      repeatGroupsSkipped: codebook.repeatGroups,
      notes,
    },
  };
}

/** Resolves a user-supplied column reference (path, header or label) to a column. */
export function resolveColumn(dataset: Dataset, ref: string): DatasetColumn | undefined {
  const needle = ref.trim().toLowerCase();
  return (
    dataset.columns.find((c) => c.path.toLowerCase() === needle) ??
    dataset.columns.find((c) => c.header.toLowerCase() === needle) ??
    dataset.columns.find((c) => c.label.toLowerCase() === needle) ??
    dataset.columns.find((c) => c.path.split("/").pop()?.toLowerCase() === needle)
  );
}
