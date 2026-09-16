import { KoboAssetDetail } from "../types.js";

export interface ChoiceDef {
  code: string;
  label: string;
}

export interface FieldDef {
  /** Key as it appears in submission JSON, e.g. "section_a/crop_health". */
  path: string;
  /** Leaf name without the group prefix. */
  name: string;
  /** Normalised question type (select_one, integer, text, ...). */
  type: string;
  /** Human-readable question text; falls back to the field name. */
  label: string;
  /** Name of the choice list backing a select question. */
  listName?: string;
  choices?: ChoiceDef[];
  /** code -> label lookup for select questions. */
  choiceMap?: Record<string, string>;
  required: boolean;
  /** Labels of the groups this field sits in, outermost first. */
  groupPath: string[];
  /** True when the field lives inside a repeating group. */
  inRepeat: boolean;
  /** Analytical role, used to pick the right statistics. */
  measure: "categorical" | "numeric" | "datetime" | "text" | "geo" | "media" | "meta";
}

export interface Codebook {
  uid: string;
  formName: string;
  language: string | null;
  availableLanguages: string[];
  fields: FieldDef[];
  byPath: Record<string, FieldDef>;
  /** Paths of repeating groups — these hold nested tables, not flat columns. */
  repeatGroups: string[];
}

const STRUCTURE_TYPES = new Set([
  "begin_group",
  "end_group",
  "begin_repeat",
  "end_repeat",
  "begin_score",
  "end_score",
  "begin_rank",
  "end_rank",
]);
const NON_DATA_TYPES = new Set(["note", "begin_kobomatrix", "end_kobomatrix"]);

const NUMERIC_TYPES = new Set(["integer", "decimal", "range", "calculate"]);
const DATETIME_TYPES = new Set(["date", "datetime", "time", "start", "end", "today"]);
const CATEGORICAL_TYPES = new Set(["select_one", "select_multiple", "select_one_from_file", "select_multiple_from_file"]);
const GEO_TYPES = new Set(["geopoint", "geotrace", "geoshape"]);
const MEDIA_TYPES = new Set(["image", "audio", "video", "file", "background-audio"]);
const META_TYPES = new Set([
  "start",
  "end",
  "today",
  "deviceid",
  "phonenumber",
  "username",
  "simserial",
  "subscriberid",
  "audit",
]);

/**
 * Kobo stores translatable strings as arrays parallel to content.translations.
 * A form with no translations stores them as a plain string or a 1-element array.
 */
function pickLabel(value: unknown, index: number): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const own = value[index];
    // `??` would keep an empty string, which is exactly the partially
    // translated case this fallback exists for.
    const picked =
      typeof own === "string" && own.trim()
        ? own
        : value.find((v) => typeof v === "string" && v.trim());
    return typeof picked === "string" ? picked.trim() || undefined : undefined;
  }
  return undefined;
}

function classify(type: string): FieldDef["measure"] {
  if (META_TYPES.has(type)) return "meta";
  if (CATEGORICAL_TYPES.has(type)) return "categorical";
  if (NUMERIC_TYPES.has(type)) return "numeric";
  if (DATETIME_TYPES.has(type)) return "datetime";
  if (GEO_TYPES.has(type)) return "geo";
  if (MEDIA_TYPES.has(type)) return "media";
  return "text";
}

/**
 * Normalises a survey row's type. Kobo writes select questions either as
 * `{type: "select_one", select_from_list_name: "x"}` (current) or as
 * `{type: "select_one x"}` (older exports) — both are handled here.
 */
function normaliseType(row: Record<string, any>): { type: string; listName?: string } {
  const raw = String(row["type"] ?? "").trim();
  const explicitList = row["select_from_list_name"];
  if (explicitList) return { type: raw, listName: String(explicitList) };

  const parts = raw.split(/\s+/);
  if (parts.length > 1 && parts[0].startsWith("select_")) {
    return { type: parts[0], listName: parts[1] };
  }
  return { type: raw };
}

/**
 * Builds a lookup of the form's structure so submissions can be turned into a
 * labelled, analysable table: question text instead of field names, choice
 * labels instead of stored codes, and a measurement type per column.
 */
export function buildCodebook(asset: KoboAssetDetail, language?: string): Codebook {
  const content = (asset.content ?? {}) as Record<string, any>;
  const survey: Array<Record<string, any>> = Array.isArray(content.survey) ? content.survey : [];
  const rawChoices: Array<Record<string, any>> = Array.isArray(content.choices) ? content.choices : [];
  const translations: Array<string | null> = Array.isArray(content.translations) ? content.translations : [null];

  const availableLanguages = translations.filter((t): t is string => typeof t === "string");
  let langIndex = 0;
  if (language) {
    const found = translations.findIndex((t) => typeof t === "string" && t.toLowerCase().includes(language.toLowerCase()));
    if (found >= 0) langIndex = found;
  }

  // Group choices by list, preserving the order they appear in the form.
  const choicesByList: Record<string, ChoiceDef[]> = {};
  for (const c of rawChoices) {
    const listName = String(c["list_name"] ?? "");
    if (!listName) continue;
    const code = String(c["name"] ?? c["$autovalue"] ?? "");
    if (!code) continue;
    (choicesByList[listName] ||= []).push({
      code,
      label: pickLabel(c["label"], langIndex) ?? code,
    });
  }

  const fields: FieldDef[] = [];
  const repeatGroups: string[] = [];
  // Stack of open groups: the data-key prefix and the human label.
  const stack: Array<{ key: string; label: string; repeat: boolean }> = [];
  // Open score/rank matrices: the wrapper row carries the choice list that all
  // of its inner rows share.
  const matrixStack: Array<string | undefined> = [];

  for (const row of survey) {
    let { type, listName } = normaliseType(row);
    if (!type) continue;

    const name = String(row["name"] ?? row["$autoname"] ?? "").trim();
    const label = pickLabel(row["label"], langIndex);

    if (type === "begin_group" || type === "begin_repeat") {
      stack.push({ key: name, label: label ?? name, repeat: type === "begin_repeat" });
      if (type === "begin_repeat") {
        repeatGroups.push(stack.map((s) => s.key).filter(Boolean).join("/"));
      }
      continue;
    }
    if (type === "end_group" || type === "end_repeat") {
      stack.pop();
      continue;
    }

    // Kobo "score" and "rank" matrices: the opening row holds the choice list
    // shared by every row inside, and each inner row is really a select_one.
    if (type === "begin_score" || type === "begin_rank") {
      const list = row["kobo--score-choices"] ?? row["kobo--rank-items"];
      matrixStack.push(typeof list === "string" ? list : undefined);
      stack.push({ key: name, label: "", repeat: false });
      continue;
    }
    if (type === "end_score" || type === "end_rank") {
      matrixStack.pop();
      stack.pop();
      continue;
    }
    if (type === "score__row" || type === "rank__level") {
      listName = matrixStack[matrixStack.length - 1];
      type = "select_one";
    }

    if (STRUCTURE_TYPES.has(type) || NON_DATA_TYPES.has(type)) continue;
    if (!name) continue;

    // Kobo publishes the exact submission key as $xpath. Trust it over our own
    // reconstruction, which cannot know how matrices nest their rows.
    const xpath = typeof row["$xpath"] === "string" ? row["$xpath"].trim() : "";
    const prefix = stack.map((s) => s.key).filter(Boolean);
    const path = xpath || [...prefix, name].join("/");
    const choices = listName ? choicesByList[listName] : undefined;

    const field: FieldDef = {
      path,
      name,
      type,
      label: label ?? name,
      listName,
      choices,
      choiceMap: choices
        ? Object.fromEntries(choices.map((c) => [c.code, c.label]))
        : undefined,
      required: row["required"] === true || row["required"] === "true",
      groupPath: stack.map((s) => s.label).filter(Boolean),
      inRepeat: stack.some((s) => s.repeat),
      measure: classify(type),
    };
    fields.push(field);
  }

  return {
    uid: asset.uid,
    formName: asset.name,
    language: translations[langIndex] ?? null,
    availableLanguages,
    fields,
    byPath: Object.fromEntries(fields.map((f) => [f.path, f])),
    repeatGroups,
  };
}
