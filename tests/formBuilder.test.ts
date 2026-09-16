import { describe, it, expect } from "vitest";
import {
  buildFormContent,
  validateQuestions,
  normaliseType,
  planTranslations,
  pickTranslated,
  setTranslated,
  languageIndex,
  listNameOf,
  spanOf,
  outlineQuestions,
  FormSpecError,
} from "../src/services/formBuilder.js";
import { QuestionSpec } from "../src/types.js";

const q = (over: Partial<QuestionSpec> & Pick<QuestionSpec, "type" | "name">): QuestionSpec => ({
  label: "L",
  ...over,
});

describe("normaliseType", () => {
  it("rewrites phone_number, the spelling that made Kobo answer HTTP 500", () => {
    expect(normaliseType("phone_number")).toBe("phonenumber");
  });

  it("accepts the canonical spellings unchanged", () => {
    expect(normaliseType("phonenumber")).toBe("phonenumber");
    expect(normaliseType("select_one")).toBe("select_one");
  });

  it("normalises the other common near-misses", () => {
    expect(normaliseType("dateTime")).toBe("datetime");
    expect(normaliseType("select_many")).toBe("select_multiple");
    expect(normaliseType("gps")).toBe("geopoint");
  });
});

describe("validateQuestions", () => {
  it("accepts a well-formed list", () => {
    expect(
      validateQuestions([
        q({ type: "text", name: "nom" }),
        q({ type: "select_one", name: "c", choices: [{ name: "a", label: "A" }] }),
      ])
    ).toEqual([]);
  });

  it("rejects an unknown type instead of letting Kobo 500", () => {
    expect(() => validateQuestions([q({ type: "telephone" as any, name: "t" })])).toThrow(FormSpecError);
  });

  it("rejects duplicate names", () => {
    expect(() =>
      validateQuestions([q({ type: "text", name: "dup" }), q({ type: "integer", name: "dup" })])
    ).toThrow(/duplicate name 'dup'/);
  });

  it("rejects an unclosed group and names the offending row", () => {
    expect(() =>
      validateQuestions([q({ type: "begin_group", name: "g" }), q({ type: "text", name: "x" })])
    ).toThrow(/'begin_group' is never closed/);
  });

  it("rejects interleaved group and repeat", () => {
    expect(() =>
      validateQuestions([
        q({ type: "begin_group", name: "g" }),
        q({ type: "begin_repeat", name: "r" }),
        q({ type: "end_group", name: "g" }),
        q({ type: "end_repeat", name: "r" }),
      ])
    ).toThrow(/cannot interleave/);
  });

  it("rejects a select without choices", () => {
    expect(() => validateQuestions([q({ type: "select_one", name: "s" })])).toThrow(/requires a 'choices' array/);
  });

  it("rejects a choice code containing a space", () => {
    expect(() =>
      validateQuestions([q({ type: "select_one", name: "s", choices: [{ name: "de 1000", label: "A" }] })])
    ).toThrow(/contains a space or quote/);
  });

  it("allows a choice code starting with a digit — Kobo accepts these", () => {
    expect(
      validateQuestions([q({ type: "select_one", name: "s", choices: [{ name: "1000_2500", label: "A" }] })])
    ).toEqual([]);
  });

  it("requires a label on a normal question but not on metadata or calculate", () => {
    expect(() => validateQuestions([{ type: "text", name: "x" } as QuestionSpec])).toThrow(/missing 'label'/);
    expect(validateQuestions([{ type: "today", name: "d" } as QuestionSpec])).toEqual([]);
    expect(
      validateQuestions([{ type: "calculate", name: "c", calculation: "1+1" } as QuestionSpec])
    ).toEqual([]);
  });

  it("requires a calculation on calculate questions", () => {
    expect(() => validateQuestions([{ type: "calculate", name: "c" } as QuestionSpec])).toThrow(
      /requires a 'calculation'/
    );
  });

  it("rejects a reserved name", () => {
    expect(() => validateQuestions([q({ type: "text", name: "today" })])).toThrow(/reserved/);
  });

  it("warns, without failing, when skip logic points at a missing question", () => {
    const warnings = validateQuestions([q({ type: "text", name: "x", relevant: "${nope} = '1'" })]);
    expect(warnings.join(" ")).toMatch(/\$\{nope\}.*not a question/);
  });

  it("reports every problem at once rather than stopping at the first", () => {
    try {
      validateQuestions([q({ type: "bogus" as any, name: "a" }), q({ type: "select_one", name: "b" })]);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FormSpecError).problems.length).toBe(2);
    }
  });
});

describe("buildFormContent", () => {
  it("emits the select list name in the type cell and the choices sheet", () => {
    const content = buildFormContent([
      q({ type: "select_one", name: "couleur", choices: [{ name: "r", label: "Rouge" }] }),
    ]);
    expect(content.survey[0].type).toBe("select_one couleur_list");
    expect(content.choices).toEqual([{ list_name: "couleur_list", name: "r", label: ["Rouge"] }]);
  });

  it("carries skip logic, constraints and appearance through to the survey sheet", () => {
    const content = buildFormContent([
      q({
        type: "integer",
        name: "annee",
        relevant: "${type} = 'autre'",
        constraint: ". >= 1950",
        constraint_message: "Trop ancien",
        appearance: "year",
        required: true,
      }),
    ]);
    const row = content.survey[0];
    expect(row.relevant).toBe("${type} = 'autre'");
    expect(row.constraint).toBe(". >= 1950");
    expect(row.constraint_message).toEqual(["Trop ancien"]);
    expect(row.appearance).toBe("year");
    expect(row.required).toBe(true);
  });

  it("keeps group and repeat rows so sections survive the round trip", () => {
    const content = buildFormContent([
      q({ type: "begin_group", name: "sec" }),
      q({ type: "text", name: "x" }),
      q({ type: "end_group", name: "sec" }),
    ]);
    expect(content.survey.map((r) => r.type)).toEqual(["begin_group", "text", "end_group"]);
  });

  it("stays monolingual — and declares no translations — for plain string labels", () => {
    const content = buildFormContent([q({ type: "text", name: "x", label: "Nom" })]);
    expect(content.survey[0].label).toEqual(["Nom"]);
    expect(content.translations).toBeUndefined();
    expect(content.translated).toBeUndefined();
  });

  it("builds parallel label arrays for a multilingual form", () => {
    const content = buildFormContent([
      q({
        type: "text",
        name: "x",
        label: { "Français (fr)": "Nom", "English (en)": "Name" },
        hint: { "Français (fr)": "Indice" },
      }),
    ]);
    expect(content.translations).toEqual(["Français (fr)", "English (en)"]);
    expect(content.survey[0].label).toEqual(["Nom", "Name"]);
    // A missing translation falls back rather than rendering blank.
    expect(content.survey[0].hint).toEqual(["Indice", "Indice"]);
    expect(content.translated).toContain("label");
  });

  it("emits a shared choice list only once", () => {
    const shared = [{ name: "o", label: "Oui" }];
    const content = buildFormContent([
      q({ type: "select_one", name: "a", choices: shared, choices_list_name: "ouinon" }),
      q({ type: "select_one", name: "b", choices: shared, choices_list_name: "ouinon" }),
    ]);
    expect(content.choices).toHaveLength(1);
    expect(content.survey[1].type).toBe("select_one ouinon");
  });

  it("maps phone_number onto the spelling Kobo accepts", () => {
    const content = buildFormContent([q({ type: "phone_number" as any, name: "tel" })]);
    expect(content.survey[0].type).toBe("phonenumber");
  });

  it("puts the description into settings", () => {
    const content = buildFormContent([q({ type: "text", name: "x" })], { description: "Étude" });
    expect(content.settings).toEqual({ description: "Étude" });
  });
});

describe("translation helpers", () => {
  it("plans a monolingual form as a single unnamed language", () => {
    expect(planTranslations([q({ type: "text", name: "x", label: "A" })])).toEqual({
      languages: [null],
      multilingual: false,
    });
  });

  it("reads a label back out of stored content", () => {
    expect(pickTranslated(["Nom", "Name"], 1)).toBe("Name");
    expect(pickTranslated("Nom")).toBe("Nom");
    // An empty primary translation falls back to a populated one.
    expect(pickTranslated(["", "Name"], 0)).toBe("Name");
    expect(pickTranslated(null)).toBeUndefined();
  });

  it("writes a label back in the shape already in use", () => {
    const row: Record<string, unknown> = {};
    setTranslated(row, "label", { "Français (fr)": "Nom" }, ["Français (fr)", "English (en)"]);
    expect(row.label).toEqual(["Nom", "Nom"]);
  });

  it("resolves a language by bare code or full Kobo label", () => {
    const translations = ["Français (fr)", "English (en)"];
    expect(languageIndex(translations, "en")).toBe(1);
    expect(languageIndex(translations, "English (en)")).toBe(1);
    expect(languageIndex(translations, "wolof")).toBe(0);
    expect(languageIndex(translations)).toBe(0);
  });
});

describe("content editing helpers", () => {
  it("finds the choice list under both spellings Kobo uses", () => {
    expect(listNameOf({ type: "select_one colours" })).toBe("colours");
    expect(listNameOf({ type: "select_multiple", select_from_list_name: "colours" })).toBe("colours");
    expect(listNameOf({ type: "text" })).toBeUndefined();
  });

  it("spans a whole group so removing it removes its contents", () => {
    const survey = [
      { type: "text", name: "before" },
      { type: "begin_group", name: "g" },
      { type: "text", name: "inner" },
      { type: "begin_group", name: "nested" },
      { type: "text", name: "deep" },
      { type: "end_group", name: "nested" },
      { type: "end_group", name: "g" },
    ];
    expect(spanOf(survey, 1)).toEqual([1, 6]);
    expect(spanOf(survey, 0)).toEqual([0, 0]);
  });

  it("indents the outline by nesting depth", () => {
    const lines = outlineQuestions([
      { type: "begin_group", name: "g", label: "Section" },
      { type: "text", name: "x", label: "Q", required: true },
      { type: "end_group", name: "g" },
      { type: "text", name: "y", label: "Après" },
    ]);
    expect(lines[0]).toMatch(/^ {2}▸ \*\*Section\*\*/);
    expect(lines[1]).toMatch(/^ {4}- `x`/);
    expect(lines[1]).toContain("*required*");
    expect(lines[2]).toMatch(/^ {2}- `y`/);
  });
});
