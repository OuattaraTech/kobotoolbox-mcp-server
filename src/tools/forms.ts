import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import {
  CreateFormInputSchema,
  UpdateFormInputSchema,
  PatchFormInputSchema,
  ListFormsInputSchema,
  GetFormInputSchema,
  DeployFormInputSchema,
  ArchiveFormInputSchema,
  CloneFormInputSchema,
  DeleteFormInputSchema,
  ExportXlsformInputSchema,
  ImportXlsformInputSchema,
  FormVersionsInputSchema,
} from "../schemas/schemas.js";
import * as kobo from "../services/koboClient.js";
import {
  validateQuestions,
  outlineQuestions,
  pickTranslated,
  setTranslated,
  languageIndex,
  listNameOf,
  spanOf,
  normaliseType,
} from "../services/formBuilder.js";
import { OUTPUT_DIR } from "../constants.js";
import { errorContent, truncate, warningBlock, linksBlock } from "./shared.js";

/** Flattens a stored survey into the shape the outline renderer expects. */
function describeSurvey(asset: any, language?: string) {
  const content = asset.content ?? {};
  const survey: Array<Record<string, any>> = Array.isArray(content.survey) ? content.survey : [];
  const translations: Array<string | null> = Array.isArray(content.translations) ? content.translations : [null];
  const index = languageIndex(translations, language);

  return {
    translations,
    index,
    rows: survey.map((row) => ({
      name: String(row["name"] ?? ""),
      type: normaliseType(String(row["type"] ?? "")),
      label: pickTranslated(row["label"], index),
      required: row["required"] === true || row["required"] === "true",
      relevant: typeof row["relevant"] === "string" ? row["relevant"] : undefined,
      constraint: typeof row["constraint"] === "string" ? row["constraint"] : undefined,
    })),
  };
}

export function registerFormTools(server: McpServer): void {
  server.registerTool(
    "kobo_list_forms",
    {
      title: "List KoboToolbox Forms",
      description: `List forms/projects (surveys) accessible with the configured API token.

Does NOT return submission data — use kobo_list_submissions for that.

Args:
  - search (string, optional): filter forms whose name contains this text
  - limit (number): max forms to return, 1-100 (default 30)
  - offset (number): pagination offset (default 0)
  - response_format ('markdown' | 'json')

Returns: form uid, name, deployment status, and submission count for each form.

Examples:
  - Use when: "What forms do I have on Kobo?" -> no params
  - Use when: "Find my cocoa tracking form" -> search="cocoa"`,
      inputSchema: ListFormsInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof ListFormsInputSchema>) => {
      try {
        const data = await kobo.listAssets({
          q: params.search ? `name__icontains:${params.search}` : undefined,
          limit: params.limit,
          offset: params.offset,
          assetType: "survey",
        });

        if (!data.results.length) {
          return { content: [{ type: "text" as const, text: "No forms found." }] };
        }

        const output = {
          total: data.count,
          count: data.results.length,
          offset: params.offset,
          forms: data.results.map((a) => ({
            uid: a.uid,
            name: a.name,
            deployment_status: a.deployment_status,
            submission_count: a.deployment__submission_count ?? a.submission_count ?? 0,
            last_submission: a.deployment__last_submission_time ?? null,
            date_modified: a.date_modified,
          })),
          has_more: data.next !== null,
        };

        if (params.response_format === "json") {
          return {
            content: [{ type: "text" as const, text: truncate(JSON.stringify(output, null, 2)) }],
            structuredContent: output,
          };
        }

        const lines = output.forms.map(
          (f) =>
            `- **${f.name}** (uid: \`${f.uid}\`) — ${f.deployment_status}, ${f.submission_count} submission(s)` +
            (f.last_submission ? `, last on ${f.last_submission.slice(0, 10)}` : "")
        );
        const text = `Found ${output.total} form(s), showing ${output.count}:\n\n${lines.join("\n")}${
          output.has_more ? "\n\n_More results available — increase offset to see more._" : ""
        }`;
        return { content: [{ type: "text" as const, text: truncate(text) }] };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_get_form",
    {
      title: "Get KoboToolbox Form Details",
      description: `Get full details of a single form: its question structure, section nesting, skip logic and validation rules.

Args:
  - uid (string): the form's asset uid (from kobo_list_forms)
  - language (string, optional): which language's labels to show on a multilingual form (e.g. 'fr')
  - response_format ('markdown' | 'json')

Returns: name, deployment status, submission count, available languages, and the question outline — groups and repeats shown as indented sections, with *required*, skip logic and constraints annotated.

Error Handling:
  - Returns "Error: ... not found" if the uid doesn't exist or isn't accessible with this token`,
      inputSchema: GetFormInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof GetFormInputSchema>) => {
      try {
        const asset = await kobo.getAsset(params.uid);
        const { rows, translations, index } = describeSurvey(asset, params.language);
        const languages = translations.filter((t): t is string => typeof t === "string");

        const output = {
          uid: asset.uid,
          name: asset.name,
          deployment_status: asset.deployment_status,
          submission_count: asset.deployment__submission_count ?? asset.submission_count ?? 0,
          languages,
          shown_language: translations[index] ?? null,
          questions: rows,
        };

        if (params.response_format === "json") {
          return {
            content: [{ type: "text" as const, text: truncate(JSON.stringify(output, null, 2)) }],
            structuredContent: output,
          };
        }

        const header =
          `**${output.name}** (uid: \`${output.uid}\`)\n` +
          `Status: ${output.deployment_status} — ${output.submission_count} submissions` +
          (languages.length ? `\nLanguages: ${languages.join(", ")} (showing ${output.shown_language})` : "");
        const text = `${header}\n\nStructure:\n${outlineQuestions(rows).join("\n")}`;
        return { content: [{ type: "text" as const, text: truncate(text) }] };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_create_form",
    {
      title: "Create KoboToolbox Form",
      description: `Create a new form (survey) from a list of questions, and optionally deploy it immediately so it can start collecting submissions.

The question list is FLAT: sections and repeats are expressed with begin_group/end_group and begin_repeat/end_repeat rows, which must be balanced.

Args:
  - name (string): form/project title
  - description (string, optional): short description
  - questions (array): ordered list of questions. Each has:
      - type: see the type enum. Use 'phonenumber' (NOT 'phone_number') for a phone field.
      - name: internal field name, unique across the whole form
      - label: question text (string, or {language: text} for a multilingual form)
      - required, hint, choices, relevant, constraint, constraint_message,
        calculation, default, appearance, read_only, parameters
  - deploy (boolean, default true): deploy immediately vs. leave as draft

Returns: the new form's uid, deployment status, and — once deployed — the public collect links.

Examples:
  - Sections and skip logic:
    questions=[
      {type:"begin_group",name:"identification",label:"Identification",appearance:"field-list"},
      {type:"text",name:"nom",label:"Nom de l'établissement",required:true},
      {type:"select_one",name:"categorie",label:"Catégorie",choices:[{name:"maquis",label:"Maquis"},{name:"autre",label:"Autre"}]},
      {type:"text",name:"categorie_autre",label:"Précisez",relevant:"\${categorie} = 'autre'"},
      {type:"integer",name:"annee",label:"Année",constraint:". >= 1950 and . <= 2030",constraint_message:"Année invalide"},
      {type:"end_group",name:"identification"}
    ]
  - Repeating data: begin_repeat "plats" ... end_repeat, one row per dish.
  - Don't use when: you want to change an existing form (use kobo_patch_form for a targeted edit, kobo_update_form to replace everything)

Error Handling:
  - The question list is validated locally first: unknown types, duplicate names, unbalanced groups, selects without choices and bad choice codes are reported precisely, before any request reaches Kobo.`,
      inputSchema: CreateFormInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof CreateFormInputSchema>) => {
      try {
        const warnings = validateQuestions(params.questions);

        let asset = await kobo.createAsset({
          name: params.name,
          description: params.description,
          questions: params.questions,
        });

        if (params.deploy) {
          asset = await kobo.deployAsset(asset.uid);
        }

        const links = kobo.collectLinks(asset);
        const output = {
          uid: asset.uid,
          name: asset.name,
          deployment_status: asset.deployment_status,
          question_count: params.questions.length,
          collect_links: links,
          warnings,
        };

        const text =
          `Form "${output.name}" created (uid: \`${output.uid}\`), status: ${output.deployment_status}, ${output.question_count} row(s).` +
          (params.deploy
            ? linksBlock(links) +
              "\n\nNote: the collect link still requires a Kobo login until you enable anonymous submissions with kobo_set_sharing."
            : "\n\nIt is currently a draft — use kobo_deploy_form to make it active.") +
          warningBlock(warnings);

        return { content: [{ type: "text" as const, text: truncate(text) }], structuredContent: output };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_update_form",
    {
      title: "Replace KoboToolbox Form Questions",
      description: `Replace the ENTIRE question list of an existing form with a new one.

Prefer kobo_patch_form for targeted edits (relabelling, adding choices, changing skip logic) — it leaves the rest of the form untouched and cannot accidentally drop questions.

Args:
  - uid (string): asset uid of the form to update
  - questions (array): FULL replacement list — any question left out is REMOVED from the form
  - redeploy (boolean, default true): redeploy so the new version goes live
  - confirm_replace (boolean): must be true when the form already has submissions

Notes:
  - Existing submissions are preserved, but answers to removed questions become orphaned and stop appearing in exports.
  - The question list is validated locally before anything is sent to Kobo.`,
      inputSchema: UpdateFormInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof UpdateFormInputSchema>) => {
      try {
        const warnings = validateQuestions(params.questions);
        const before = await kobo.getAsset(params.uid);
        const submissions = before.deployment__submission_count ?? before.submission_count ?? 0;

        if (submissions > 0 && !params.confirm_replace) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  `Error: form "${before.name}" already has ${submissions} submission(s). Replacing its full structure can orphan collected answers.\n\n` +
                  `Either use kobo_patch_form for a targeted change, or re-run with confirm_replace=true if replacing everything is intended.`,
              },
            ],
          };
        }

        // Report what the replacement drops, so the loss is never silent.
        const existing = describeSurvey(before).rows.filter(
          (r) => r.name && !["begin_group", "end_group", "begin_repeat", "end_repeat", "note"].includes(r.type)
        );
        const incoming = new Set(params.questions.map((q) => q.name));
        const removed = existing.filter((r) => !incoming.has(r.name)).map((r) => r.name);

        let asset = await kobo.updateAssetContent(params.uid, params.questions);
        if (params.redeploy) asset = await kobo.deployAsset(params.uid);

        const text =
          `Form "${asset.name}" (uid: \`${asset.uid}\`) updated with ${params.questions.length} row(s). Status: ${asset.deployment_status}.` +
          (removed.length
            ? `\n\n⚠ ${removed.length} question(s) no longer in the form: ${removed.slice(0, 20).join(", ")}${
                removed.length > 20 ? ", ..." : ""
              }. Existing answers to these are kept in the database but drop out of exports.`
            : "") +
          warningBlock(warnings);

        return {
          content: [{ type: "text" as const, text: truncate(text) }],
          structuredContent: { uid: asset.uid, removed_questions: removed, warnings },
        };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_patch_form",
    {
      title: "Patch KoboToolbox Form",
      description: `Make targeted changes to an existing form without resending the whole question list.

This is the safe way to fix a typo, add a choice, or attach skip logic to a form that is already collecting data — everything not named is left exactly as it is.

Args (all optional, combine freely):
  - uid (string): the form to patch
  - set_label: [{name, label}] — relabel existing questions
  - set_hint: [{name, hint}]
  - set_required: [{name, required}]
  - set_relevant: [{name, relevant}] — set skip logic; empty string clears it
  - set_constraint: [{name, constraint, constraint_message}] — empty constraint clears it
  - add_choices: [{name, choices:[{name,label}]}] — append options to a select question
  - remove_questions: [names] — delete questions; removing a group removes its contents
  - redeploy (boolean, default true)

Returns: a per-change report of what was applied and what could not be found.

Examples:
  - Fix one label: set_label=[{name:"nom_etablissement", label:"Nom de l'établissement"}]
  - Add skip logic after the fact: set_relevant=[{name:"type_autre", relevant:"\${type} = 'autre'"}]
  - Add a payment option: add_choices=[{name:"moyens_paiement", choices:[{name:"wave",label:"Wave"}]}]`,
      inputSchema: PatchFormInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof PatchFormInputSchema>) => {
      try {
        const asset = await kobo.getAsset(params.uid);
        const content = (asset.content ?? {}) as any;
        const survey: Array<Record<string, any>> = Array.isArray(content.survey) ? [...content.survey] : [];
        const choices: Array<Record<string, any>> = Array.isArray(content.choices) ? [...content.choices] : [];
        const translations: Array<string | null> = Array.isArray(content.translations)
          ? content.translations
          : [null];

        const applied: string[] = [];
        const missing: string[] = [];
        const findRow = (name: string) => survey.find((r) => String(r["name"] ?? "") === name);

        for (const { name, label } of params.set_label ?? []) {
          const row = findRow(name);
          if (!row) { missing.push(`set_label: '${name}'`); continue; }
          setTranslated(row, "label", label, translations);
          applied.push(`relabelled '${name}'`);
        }

        for (const { name, hint } of params.set_hint ?? []) {
          const row = findRow(name);
          if (!row) { missing.push(`set_hint: '${name}'`); continue; }
          setTranslated(row, "hint", hint, translations);
          applied.push(`hint set on '${name}'`);
        }

        for (const { name, required } of params.set_required ?? []) {
          const row = findRow(name);
          if (!row) { missing.push(`set_required: '${name}'`); continue; }
          if (required) row["required"] = true;
          else delete row["required"];
          applied.push(`'${name}' is now ${required ? "required" : "optional"}`);
        }

        for (const { name, relevant } of params.set_relevant ?? []) {
          const row = findRow(name);
          if (!row) { missing.push(`set_relevant: '${name}'`); continue; }
          if (relevant.trim()) row["relevant"] = relevant.trim();
          else delete row["relevant"];
          applied.push(`skip logic ${relevant.trim() ? "set on" : "cleared from"} '${name}'`);
        }

        for (const { name, constraint, constraint_message } of params.set_constraint ?? []) {
          const row = findRow(name);
          if (!row) { missing.push(`set_constraint: '${name}'`); continue; }
          if (constraint.trim()) {
            row["constraint"] = constraint.trim();
            if (constraint_message) setTranslated(row, "constraint_message", constraint_message, translations);
          } else {
            delete row["constraint"];
            delete row["constraint_message"];
          }
          applied.push(`constraint ${constraint.trim() ? "set on" : "cleared from"} '${name}'`);
        }

        for (const { name, choices: newChoices } of params.add_choices ?? []) {
          const row = findRow(name);
          if (!row) { missing.push(`add_choices: '${name}'`); continue; }
          const listName = listNameOf(row);
          if (!listName) { missing.push(`add_choices: '${name}' is not a choice question`); continue; }
          const existing = new Set(
            choices.filter((c) => c["list_name"] === listName).map((c) => String(c["name"]))
          );
          let added = 0;
          for (const choice of newChoices) {
            if (existing.has(choice.name)) continue;
            const choiceRow: Record<string, any> = { list_name: listName, name: choice.name };
            setTranslated(choiceRow, "label", choice.label, translations);
            choices.push(choiceRow);
            added++;
          }
          applied.push(`${added} choice(s) added to '${name}'`);
        }

        // Removal last, so the edits above still resolve by name.
        for (const name of params.remove_questions ?? []) {
          const index = survey.findIndex((r) => String(r["name"] ?? "") === name);
          if (index < 0) { missing.push(`remove_questions: '${name}'`); continue; }
          const [from, to] = spanOf(survey, index);
          const removed = survey.splice(from, to - from + 1);
          applied.push(`removed '${name}'${removed.length > 1 ? ` and its ${removed.length - 1} nested row(s)` : ""}`);
        }

        if (!applied.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Nothing to apply.${missing.length ? `\n\nNot found:\n${missing.map((m) => `  - ${m}`).join("\n")}` : ""}`,
              },
            ],
          };
        }

        let updated = await kobo.putAssetContent(params.uid, { ...content, survey, choices });
        if (params.redeploy) updated = await kobo.deployAsset(params.uid);

        const text =
          `Patched "${updated.name}" (uid: \`${updated.uid}\`). Status: ${updated.deployment_status}.\n\nApplied:\n` +
          applied.map((a) => `  - ${a}`).join("\n") +
          (missing.length ? `\n\nNot found (left untouched):\n${missing.map((m) => `  - ${m}`).join("\n")}` : "");

        return {
          content: [{ type: "text" as const, text: truncate(text) }],
          structuredContent: { uid: updated.uid, applied, missing },
        };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_deploy_form",
    {
      title: "Deploy KoboToolbox Form",
      description: `Deploy a draft form (or redeploy a changed one) so it becomes active and can collect submissions.

Args:
  - uid (string): asset uid of the form to deploy

Returns: the new deployment status and the collect links.

Note: deploying makes the form live but NOT public — the Enketo link still asks for a Kobo login until anonymous submissions are enabled with kobo_set_sharing.`,
      inputSchema: DeployFormInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof DeployFormInputSchema>) => {
      try {
        const asset = await kobo.deployAsset(params.uid);
        const links = kobo.collectLinks(asset);
        return {
          content: [
            {
              type: "text" as const,
              text: `Form "${asset.name}" (uid: \`${asset.uid}\`) is now ${asset.deployment_status}.${linksBlock(links)}`,
            },
          ],
          structuredContent: { uid: asset.uid, deployment_status: asset.deployment_status, collect_links: links },
        };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_archive_form",
    {
      title: "Archive or Reactivate a KoboToolbox Form",
      description: `Stop a form from accepting new submissions without deleting anything, or bring an archived form back.

This is the correct way to end a data collection round: every response is kept and stays exportable. Use it instead of kobo_delete_form, which destroys the data.

Args:
  - uid (string): asset uid of the deployed form
  - active (boolean): false to archive, true to reactivate

Returns: the resulting deployment status.`,
      inputSchema: ArchiveFormInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof ArchiveFormInputSchema>) => {
      try {
        const asset = await kobo.setDeploymentActive(params.uid, params.active);
        const text = params.active
          ? `Form "${asset.name}" is active again and accepting submissions (status: ${asset.deployment_status}).`
          : `Form "${asset.name}" is archived — it no longer accepts submissions, and its ${
              asset.deployment__submission_count ?? 0
            } existing response(s) are untouched (status: ${asset.deployment_status}).`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { uid: asset.uid, deployment_status: asset.deployment_status, active: params.active },
        };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_clone_form",
    {
      title: "Clone a KoboToolbox Form",
      description: `Copy an existing form's structure into a brand-new project, without its submissions.

Useful to reuse a questionnaire for a new round, region or season, or to experiment on a copy instead of a live form.

Args:
  - uid (string): asset uid of the form to copy
  - name (string, optional): name for the copy (default '<original> (copie)')
  - deploy (boolean, default false): deploy the copy immediately

Returns: the new form's uid and status.`,
      inputSchema: CloneFormInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof CloneFormInputSchema>) => {
      try {
        const source = await kobo.getAsset(params.uid);
        let clone = await kobo.cloneAsset(params.uid, params.name ?? `${source.name} (copie)`);
        if (params.deploy) clone = await kobo.deployAsset(clone.uid);

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Cloned "${source.name}" into "${clone.name}" (uid: \`${clone.uid}\`), status: ${clone.deployment_status}. ` +
                `The copy starts with zero submissions.${params.deploy ? linksBlock(kobo.collectLinks(clone)) : ""}`,
            },
          ],
          structuredContent: { uid: clone.uid, name: clone.name, deployment_status: clone.deployment_status },
        };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_export_xlsform",
    {
      title: "Download a Form as XLSForm",
      description: `Download a form as a real XLSForm .xlsx workbook — the standard exchange format for ODK/Kobo questionnaires.

Use it to hand the questionnaire to someone else, keep it under version control, edit it in Excel, or re-import it elsewhere with kobo_import_xlsform.

Args:
  - uid (string): asset uid of the form
  - output_path (string, optional): where to write the file

Returns: the path written and its size.`,
      inputSchema: ExportXlsformInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof ExportXlsformInputSchema>) => {
      try {
        const asset = await kobo.getAsset(params.uid);
        const buffer = await kobo.downloadXlsform(params.uid);
        const safeName = asset.name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) || asset.uid;
        const destination = params.output_path ?? path.join(OUTPUT_DIR, `${safeName}.xlsx`);

        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, buffer);

        return {
          content: [
            {
              type: "text" as const,
              text: `XLSForm written to ${destination} (${(buffer.length / 1024).toFixed(1)} KB).`,
            },
          ],
          structuredContent: { path: destination, size_bytes: buffer.length, uid: params.uid },
        };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_import_xlsform",
    {
      title: "Import an XLSForm",
      description: `Upload an XLSForm .xlsx workbook to Kobo, either as a new form or to overwrite an existing one.

Use it when a questionnaire already exists as a spreadsheet, or to round-trip a form edited in Excel.

Args:
  - file_path (string): path to the .xlsx on disk
  - name (string, optional): name for the imported form
  - uid (string, optional): asset uid to overwrite; omit to create a new form
  - deploy (boolean, default false): deploy once the import finishes

Returns: the resulting form uid and import status.

Error Handling:
  - Kobo validates the workbook server-side; a malformed XLSForm comes back with the specific row/column it rejected.`,
      inputSchema: ImportXlsformInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof ImportXlsformInputSchema>) => {
      try {
        let buffer: Buffer;
        try {
          buffer = await fs.readFile(params.file_path);
        } catch {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Error: cannot read file '${params.file_path}'.` }],
          };
        }

        const result = await kobo.importXlsform({
          fileBuffer: buffer,
          fileName: path.basename(params.file_path),
          name: params.name,
          destinationUid: params.uid,
        });

        let deployedNote = "";
        let links = {};
        if (params.deploy && result.assetUid) {
          const deployed = await kobo.deployAsset(result.assetUid);
          links = kobo.collectLinks(deployed);
          deployedNote = linksBlock(links);
        }

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Import ${result.status}. ${
                  result.assetUid ? `Form uid: \`${result.assetUid}\`.` : "Kobo did not report a resulting form uid."
                }${deployedNote}`,
            },
          ],
          structuredContent: { ...result, collect_links: links },
        };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_delete_form",
    {
      title: "Delete KoboToolbox Form",
      description: `Permanently delete a form AND ALL ITS SUBMISSIONS. THIS CANNOT BE UNDONE.

Args:
  - uid (string): asset uid of the form to delete
  - confirm (true): must be explicitly set to true
  - confirm_submission_count (number): required when the form has submissions — pass the exact count, to prove the data loss is intended

Don't use when: you just want to stop collecting data. Use kobo_archive_form instead — it keeps every response.`,
      inputSchema: DeleteFormInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof DeleteFormInputSchema>) => {
      try {
        const asset = await kobo.getAsset(params.uid);
        const submissions = asset.deployment__submission_count ?? asset.submission_count ?? 0;

        if (submissions > 0 && params.confirm_submission_count !== submissions) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  `Error: form "${asset.name}" holds ${submissions} submission(s), which deletion destroys permanently.\n\n` +
                  `If that is intended, re-run with confirm_submission_count=${submissions}. ` +
                  `To simply stop collection while keeping the data, use kobo_archive_form with active=false instead.`,
              },
            ],
          };
        }

        await kobo.deleteAsset(params.uid);
        return {
          content: [
            {
              type: "text" as const,
              text: `Form "${asset.name}" (${params.uid}) and its ${submissions} submission(s) were permanently deleted.`,
            },
          ],
        };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_form_versions",
    {
      title: "KoboToolbox Form Version History",
      description: `List a form's deployed versions, and roll back to one of them.

Kobo keeps every version that was ever deployed. This is the way back when a change breaks a live form: redeploying a past version restores the old structure without touching the submissions already collected.

Args:
  - uid (string): asset uid of the form
  - rollback_to (string, optional): version uid to redeploy. Omit to only list the history.
  - limit (number, default 30): how many versions to list
  - response_format ('markdown' | 'json')

Returns: the version history (newest first) with deployment dates, and the resulting status after a rollback.

Notes:
  - Rolling back changes the form structure only. Answers collected under the newer version stay in the database, but fields that no longer exist drop out of exports.`,
      inputSchema: FormVersionsInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof FormVersionsInputSchema>) => {
      try {
        let rolledBack: string | undefined;
        if (params.rollback_to) {
          const asset = await kobo.deployVersion(params.uid, params.rollback_to);
          rolledBack = `Rolled "${asset.name}" back to version ${params.rollback_to}. Status: ${asset.deployment_status}.`;
        }

        const versions = await kobo.listVersions(params.uid, params.limit);
        const output = { uid: params.uid, rolled_back_to: params.rollback_to ?? null, versions };

        if (params.response_format === "json") {
          return {
            content: [{ type: "text" as const, text: truncate(JSON.stringify(output, null, 2)) }],
            structuredContent: output,
          };
        }

        if (!versions.length) {
          return { content: [{ type: "text" as const, text: "This form has no deployed version yet." }] };
        }

        const lines = versions.map(
          (v) =>
            `  - v${v.version_number ?? "?"} \`${v.uid}\`` +
            (v.date_deployed ? ` — deployed ${v.date_deployed.slice(0, 10)}` : " — never deployed")
        );
        const text =
          (rolledBack ? `${rolledBack}\n\n` : "") +
          `Version history of form ${params.uid} (newest first):\n${lines.join("\n")}` +
          (rolledBack ? "" : "\n\nPass rollback_to=<version uid> to redeploy one of these.");

        return { content: [{ type: "text" as const, text: truncate(text) }], structuredContent: output };
      } catch (error) {
        return errorContent(error);
      }
    }
  );
}
