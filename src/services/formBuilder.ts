import { QuestionSpec, TranslatableText, FormContent } from "../types.js";

/**
 * Raised when a question list cannot be turned into a valid XLSForm.
 * Caught by the tools layer and reported to the model as a plain-text
 * error, so it never reaches the Kobo API as an opaque HTTP 500.
 */
export class FormSpecError extends Error {
  constructor(message: string, public problems: string[] = []) {
    super(message);
    this.name = "FormSpecError";
  }
}

/** Types that open a nesting level. */
export const OPENING_TYPES = new Set(["begin_group", "begin_repeat"]);
/** Types that close a nesting level, mapped to the opener they must match. */
export const CLOSING_TYPES: Record<string, string> = {
  end_group: "begin_group",
  end_repeat: "begin_repeat",
};

/** Metadata types collected silently by the device — they carry no label. */
export const META_TYPES = new Set([
  "start",
  "end",
  "today",
  "deviceid",
  "phonenumber",
  "username",
  "audit",
]);

/** Types that never show a label to the respondent. */
const UNLABELLED_TYPES = new Set([...META_TYPES, "calculate", "end_group", "end_repeat"]);

/** Every data-carrying question type accepted by Kobo. */
export const DATA_TYPES = new Set([
  "text",
  "integer",
  "decimal",
  "range",
  "date",
  "time",
  "datetime",
  "select_one",
  "select_multiple",
  "rank",
  "note",
  "geopoint",
  "geotrace",
  "geoshape",
  "image",
  "audio",
  "video",
  "file",
  "barcode",
  "calculate",
  "acknowledge",
  "hidden",
]);

export const SELECT_TYPES = new Set(["select_one", "select_multiple", "rank"]);

/**
 * Spellings the model is likely to reach for that XLSForm writes differently.
 * `phone_number` in particular used to be advertised by this server's own
 * schema and makes the Kobo API answer with an HTML 500 page.
 */
const TYPE_ALIASES: Record<string, string> = {
  phone_number: "phonenumber",
  phone: "phonenumber",
  dateTime: "datetime",
  date_time: "datetime",
  select1: "select_one",
  select_1: "select_one",
  select_many: "select_multiple",
  multiselect: "select_multiple",
  gps: "geopoint",
  photo: "image",
  readonly: "note",
  boolean: "acknowledge",
};

export function normaliseType(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  return TYPE_ALIASES[trimmed] ?? trimmed;
}

/** Field names must be valid XML identifiers for the ODK engine. */
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/**
 * Choice codes are looser than field names — they end up as XML *values*, not
 * element names, so digits may lead. Whitespace and quotes still break the
 * generated XPath expressions.
 */
const CHOICE_NAME_RE = /^[^\s'"`\\/]+$/;

/** Reserved words that collide with the generated XForm instance. */
const RESERVED_NAMES = new Set(["meta", "instanceID", "start", "end", "today", "formhub", "__version__"]);

// ---------------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------------

/**
 * Kobo stores every translatable string as an array running parallel to
 * `content.translations`. A monolingual form keeps a single unnamed entry.
 */
export interface TranslationPlan {
  /** Language names in column order, or [null] when the form is monolingual. */
  languages: Array<string | null>;
  multilingual: boolean;
}

function textLanguages(value: TranslatableText | undefined, into: Set<string>): void {
  if (value && typeof value === "object") {
    for (const lang of Object.keys(value)) into.add(lang);
  }
}

/**
 * Walks the whole spec to find every language mentioned, preserving the order
 * of first appearance so the primary language stays first in Kobo's UI.
 */
export function planTranslations(questions: QuestionSpec[]): TranslationPlan {
  const seen = new Set<string>();
  for (const q of questions) {
    textLanguages(q.label, seen);
    textLanguages(q.hint, seen);
    textLanguages(q.constraint_message, seen);
    textLanguages(q.required_message, seen);
    for (const c of q.choices ?? []) textLanguages(c.label, seen);
  }
  if (seen.size === 0) return { languages: [null], multilingual: false };
  return { languages: [...seen], multilingual: true };
}

/**
 * Expands one translatable value into the parallel array Kobo expects.
 * Missing translations fall back to the first language that supplies one, so a
 * partially translated form still renders readable text everywhere.
 */
function expand(value: TranslatableText | undefined, plan: TranslationPlan): string[] | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    const text = value;
    return plan.languages.map(() => text);
  }

  const fallback = plan.languages
    .map((lang) => (lang ? value[lang] : undefined))
    .find((v) => typeof v === "string" && v.trim().length > 0);

  return plan.languages.map((lang) => {
    const own = lang ? value[lang] : undefined;
    return typeof own === "string" && own.trim().length > 0 ? own : fallback ?? "";
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function labelPreview(value: TranslatableText | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  const first = Object.values(value).find((v) => typeof v === "string");
  return first ?? "";
}

/**
 * Checks a question list against the rules Kobo enforces server-side, so the
 * model gets a precise, actionable message instead of an HTTP 500.
 *
 * Returns non-fatal warnings; throws FormSpecError on anything that would be
 * rejected downstream.
 */
export function validateQuestions(questions: QuestionSpec[]): string[] {
  const problems: string[] = [];
  const warnings: string[] = [];
  const seenNames = new Map<string, number>();
  const stack: Array<{ type: string; name: string; index: number }> = [];
  const declaredNames = new Set<string>();

  questions.forEach((q, i) => {
    const pos = `question #${i + 1}`;
    const type = normaliseType(q.type);
    const name = (q.name ?? "").trim();
    const isClosing = type in CLOSING_TYPES;

    // --- type -------------------------------------------------------------
    if (!type) {
      problems.push(`${pos}: missing 'type'.`);
      return;
    }
    if (!DATA_TYPES.has(type) && !META_TYPES.has(type) && !OPENING_TYPES.has(type) && !isClosing) {
      problems.push(
        `${pos} ('${name || "?"}'): unknown type '${q.type}'. Kobo rejects unknown types with an opaque HTTP 500. ` +
          `Valid types: ${[...DATA_TYPES].join(", ")}, ${[...META_TYPES].join(", ")}, begin_group, end_group, begin_repeat, end_repeat.`
      );
    }

    // --- name -------------------------------------------------------------
    if (!name) {
      // Closing rows may omit the name; everything else needs one.
      if (!isClosing) problems.push(`${pos}: missing 'name'.`);
    } else {
      if (!NAME_RE.test(name)) {
        problems.push(
          `${pos}: name '${name}' is invalid — it must start with a letter or underscore and contain only letters, digits and underscores (no spaces or accents).`
        );
      }
      if (RESERVED_NAMES.has(name)) {
        problems.push(`${pos}: name '${name}' is reserved by the form engine. Choose another.`);
      }
      if (!isClosing) {
        const previous = seenNames.get(name);
        if (previous !== undefined) {
          problems.push(
            `${pos}: duplicate name '${name}' (already used by question #${previous + 1}). Names must be unique across the whole form, groups included.`
          );
        } else {
          seenNames.set(name, i);
          declaredNames.add(name);
        }
      }
    }

    // --- nesting ----------------------------------------------------------
    if (OPENING_TYPES.has(type)) {
      stack.push({ type, name, index: i });
    } else if (isClosing) {
      const expected = CLOSING_TYPES[type];
      const open = stack.pop();
      if (!open) {
        problems.push(`${pos}: '${type}' with no matching '${expected}' before it.`);
      } else if (open.type !== expected) {
        problems.push(
          `${pos}: '${type}' closes a '${open.type}' opened at question #${open.index + 1} ('${open.name}'). Groups and repeats cannot interleave.`
        );
      }
    }

    // --- label ------------------------------------------------------------
    const hasLabel = q.label !== undefined && labelPreview(q.label).trim().length > 0;
    if (!hasLabel && !UNLABELLED_TYPES.has(type)) {
      problems.push(`${pos} ('${name}'): missing 'label'. Only ${[...UNLABELLED_TYPES].join(", ")} may omit it.`);
    }

    // --- choices ----------------------------------------------------------
    if (SELECT_TYPES.has(type)) {
      if (!q.choices?.length) {
        problems.push(
          `${pos} ('${name}'): type ${type} requires a 'choices' array with at least one {name, label}.`
        );
      } else {
        const seenCodes = new Set<string>();
        for (const choice of q.choices) {
          const code = (choice.name ?? "").trim();
          if (!code) {
            problems.push(`${pos} ('${name}'): a choice is missing its 'name'.`);
            continue;
          }
          if (!CHOICE_NAME_RE.test(code)) {
            problems.push(
              `${pos} ('${name}'): choice code '${code}' contains a space or quote. Use underscores instead.`
            );
          }
          if (seenCodes.has(code)) {
            problems.push(`${pos} ('${name}'): duplicate choice code '${code}'.`);
          }
          seenCodes.add(code);
          if (!labelPreview(choice.label).trim()) {
            problems.push(`${pos} ('${name}'): choice '${code}' is missing its label.`);
          }
        }
      }
    } else if (q.choices?.length) {
      warnings.push(`${pos} ('${name}'): 'choices' is ignored for type ${type}.`);
    }

    // --- type-specific requirements ---------------------------------------
    if (type === "calculate" && !q.calculation?.trim()) {
      problems.push(`${pos} ('${name}'): type calculate requires a 'calculation' expression.`);
    }
    if (type === "range" && !q.parameters?.trim()) {
      warnings.push(
        `${pos} ('${name}'): type range without 'parameters' defaults to start=0 end=10 step=1. Pass e.g. "start=1 end=5 step=1".`
      );
    }
    if (q.constraint_message && !q.constraint) {
      warnings.push(`${pos} ('${name}'): 'constraint_message' has no effect without a 'constraint'.`);
    }
    if (q.required && type === "note") {
      warnings.push(`${pos} ('${name}'): a note cannot be required — the flag is ignored.`);
    }
  });

  for (const open of stack) {
    problems.push(
      `question #${open.index + 1} ('${open.name}'): '${open.type}' is never closed. Add a matching '${
        open.type === "begin_group" ? "end_group" : "end_repeat"
      }' row.`
    );
  }

  // Cross-references: a ${name} pointing at nothing silently disables the rule.
  const REF_RE = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  questions.forEach((q, i) => {
    for (const [field, expr] of [
      ["relevant", q.relevant],
      ["constraint", q.constraint],
      ["calculation", q.calculation],
      ["default", q.default],
    ] as const) {
      if (!expr) continue;
      for (const match of expr.matchAll(REF_RE)) {
        const ref = match[1];
        // `.` and the question's own name are legitimate inside constraints.
        if (ref !== q.name && !declaredNames.has(ref)) {
          warnings.push(
            `question #${i + 1} ('${q.name}'): ${field} references \${${ref}}, which is not a question in this form. The rule will never fire.`
          );
        }
      }
    }
  });

  if (problems.length) {
    throw new FormSpecError(
      `The form specification has ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"),
      problems
    );
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Content generation
// ---------------------------------------------------------------------------

/**
 * Translates the simplified question list into Kobo's XLSForm-style `content`
 * JSON (the `survey` / `choices` sheets as arrays of row objects).
 *
 * Supports the full set of columns the tools expose: nesting via
 * begin_group/begin_repeat, skip logic (`relevant`), validation
 * (`constraint`), calculations, appearance hints and multilingual labels.
 */
export function buildFormContent(
  questions: QuestionSpec[],
  options: { description?: string; settings?: Record<string, unknown> } = {}
): FormContent {
  const plan = planTranslations(questions);
  const survey: Array<Record<string, unknown>> = [];
  const choices: Array<Record<string, unknown>> = [];
  const translatedColumns = new Set<string>();
  const emittedLists = new Set<string>();

  for (const q of questions) {
    const type = normaliseType(q.type);
    const row: Record<string, unknown> = { name: q.name };

    // Kobo accepts `select_one <list>` in the type cell; that spelling round-trips
    // through older exports too, so it is what we emit.
    if (SELECT_TYPES.has(type)) {
      const listName = q.choices_list_name?.trim() || `${q.name}_list`;
      row["type"] = `${type} ${listName}`;

      // Two questions may deliberately share one list; emit its rows only once.
      if (!emittedLists.has(listName)) {
        emittedLists.add(listName);
        for (const choice of q.choices ?? []) {
          const choiceRow: Record<string, unknown> = { list_name: listName, name: choice.name };
          const label = expand(choice.label, plan);
          if (label) {
            choiceRow["label"] = label;
            translatedColumns.add("label");
          }
          choices.push(choiceRow);
        }
      }
    } else {
      row["type"] = type;
    }

    for (const [column, value] of [
      ["label", q.label],
      ["hint", q.hint],
      ["constraint_message", q.constraint_message],
      ["required_message", q.required_message],
    ] as const) {
      const expanded = expand(value, plan);
      if (expanded) {
        row[column] = expanded;
        translatedColumns.add(column);
      }
    }

    if (q.required) row["required"] = true;
    if (q.relevant?.trim()) row["relevant"] = q.relevant.trim();
    if (q.constraint?.trim()) row["constraint"] = q.constraint.trim();
    if (q.calculation?.trim()) row["calculation"] = q.calculation.trim();
    if (q.default !== undefined && String(q.default).trim() !== "") row["default"] = q.default;
    if (q.appearance?.trim()) row["appearance"] = q.appearance.trim();
    if (q.read_only) row["read_only"] = true;
    if (q.parameters?.trim()) row["parameters"] = q.parameters.trim();
    if (q.repeat_count?.trim()) row["repeat_count"] = q.repeat_count.trim();

    survey.push(row);
  }

  const settings: Record<string, unknown> = { ...(options.settings ?? {}) };
  if (options.description) settings["description"] = options.description;

  const content: FormContent = { survey, choices, settings };

  // Only declare translations for a genuinely multilingual form: a monolingual
  // one round-trips fine with bare single-element arrays, and declaring a null
  // language needlessly shows a language picker in the Kobo editor.
  if (plan.multilingual) {
    content.translations = plan.languages;
    content.translated = [...translatedColumns];
  }

  return content;
}

/**
 * Renders a question list as an indented outline — used to show the model what
 * a form actually looks like without dumping the raw XLSForm JSON.
 */
export function outlineQuestions(
  questions: Array<{
    name?: string;
    type?: string;
    label?: string;
    required?: boolean;
    relevant?: string;
    constraint?: string;
  }>
): string[] {
  const lines: string[] = [];
  let depth = 0;

  for (const q of questions) {
    const type = normaliseType(q.type ?? "");
    if (type in CLOSING_TYPES) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const pad = "  ".repeat(depth + 1);
    const flags = [
      q.required ? "*required*" : "",
      q.relevant ? `_if ${q.relevant}_` : "",
      q.constraint ? `_check ${q.constraint}_` : "",
    ]
      .filter(Boolean)
      .join(" ");

    if (OPENING_TYPES.has(type)) {
      lines.push(`${pad}${type === "begin_repeat" ? "🔁" : "▸"} **${q.label ?? q.name}** (${q.name})${flags ? " " + flags : ""}`);
      depth += 1;
      continue;
    }
    lines.push(`${pad}- \`${q.name}\` (${type}): ${q.label ?? ""}${flags ? " " + flags : ""}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Reading and editing existing content
// ---------------------------------------------------------------------------

/**
 * Reads one translatable cell out of existing Kobo content. Labels are stored
 * as arrays parallel to `content.translations`; older or monolingual forms
 * store a plain string. Falls back to the first populated translation so a
 * partially translated form never renders blank.
 */
export function pickTranslated(value: unknown, index = 0): string | undefined {
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

/**
 * Writes a translatable cell back into existing content, matching the shape
 * already in use: an array of the right length for a multilingual form, a
 * bare single-element array otherwise.
 */
export function setTranslated(
  row: Record<string, unknown>,
  column: string,
  value: TranslatableText,
  translations: Array<string | null>
): void {
  if (typeof value === "string") {
    row[column] = translations.map(() => value);
    return;
  }
  const fallback = Object.values(value).find((v) => typeof v === "string" && v.trim());
  row[column] = translations.map((lang) => {
    const own = lang ? value[lang] : undefined;
    return typeof own === "string" && own.trim() ? own : fallback ?? "";
  });
}

/**
 * Resolves the index of a language within a form's translation list, accepting
 * either the full Kobo label ("Français (fr)") or a bare code ("fr").
 */
export function languageIndex(translations: Array<string | null>, language?: string): number {
  if (!language) return 0;
  const found = translations.findIndex(
    (t) => typeof t === "string" && t.toLowerCase().includes(language.toLowerCase())
  );
  return found >= 0 ? found : 0;
}

/**
 * Finds the choice list backing a select question, handling both spellings
 * Kobo uses: `{type: "select_one x"}` and `{type, select_from_list_name}`.
 */
export function listNameOf(row: Record<string, unknown>): string | undefined {
  const explicit = row["select_from_list_name"];
  if (typeof explicit === "string" && explicit) return explicit;
  const parts = String(row["type"] ?? "").trim().split(/\s+/);
  return parts.length > 1 && parts[0].startsWith("select_") ? parts[1] : undefined;
}

/**
 * Returns the index range a question occupies. A plain question is a single
 * row; a group or repeat spans everything up to its matching close, so removing
 * one removes its whole contents.
 */
export function spanOf(survey: Array<Record<string, unknown>>, index: number): [number, number] {
  const type = normaliseType(String(survey[index]?.["type"] ?? ""));
  if (!OPENING_TYPES.has(type)) return [index, index];

  let depth = 0;
  for (let i = index; i < survey.length; i++) {
    const t = normaliseType(String(survey[i]["type"] ?? ""));
    if (OPENING_TYPES.has(t)) depth++;
    else if (t in CLOSING_TYPES) {
      depth--;
      if (depth === 0) return [index, i];
    }
  }
  return [index, survey.length - 1];
}
