import { z } from "zod";
import { VALIDATION_STATUSES } from "../types.js";

export const ResponseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

/** Text shown to respondents: one string, or {language: text} for a multilingual form. */
export const TranslatableTextSchema = z
  .union([z.string(), z.record(z.string(), z.string())])
  .describe(
    "Text shown to respondents. Either a plain string, or a map of language to text for a multilingual form, e.g. {\"Français (fr)\": \"Nom\", \"English (en)\": \"Name\"}"
  );

export const QuestionChoiceSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Internal code stored in the data, no spaces or quotes (e.g. 'cacao', '1000_2500')"),
  label: TranslatableTextSchema.describe("Label shown to the person filling the form (e.g. 'Cacao')"),
});

/**
 * Every XLSForm type Kobo accepts. Note `phonenumber` (one word) — the
 * `phone_number` spelling makes the Kobo API answer with an opaque HTTP 500.
 */
export const QUESTION_TYPES = [
  // Data
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
  // Metadata captured automatically by the device
  "start",
  "end",
  "today",
  "deviceid",
  "phonenumber",
  "username",
  "audit",
  // Structure
  "begin_group",
  "end_group",
  "begin_repeat",
  "end_repeat",
] as const;

export const QuestionSpecSchema = z
  .object({
    type: z
      .enum(QUESTION_TYPES)
      .describe(
        "XLSForm question type. Structure: use 'begin_group'/'end_group' to split the form into sections (rendered as separate screens with appearance 'field-list'), and 'begin_repeat'/'end_repeat' for data that repeats (e.g. one row per dish). Choice questions: 'select_one' / 'select_multiple'. Read-only text: 'note'. GPS: 'geopoint'. Phone number: 'phonenumber' (NOT 'phone_number'). Computed value: 'calculate' (needs 'calculation'). Interview metadata: 'start', 'end', 'today', 'deviceid'."
      ),
    name: z
      .string()
      .min(1)
      .regex(
        /^[a-zA-Z_][a-zA-Z0-9_]*$/,
        "Must start with a letter/underscore and contain only letters, numbers, underscores"
      )
      .describe("Internal field name, unique across the whole form, no spaces or accents (e.g. 'farmer_name')"),
    label: TranslatableTextSchema.optional().describe(
      "Question text shown to respondents. Required for everything except 'calculate', 'end_group', 'end_repeat' and the metadata types."
    ),
    required: z.boolean().default(false).describe("Whether an answer is mandatory"),
    required_message: TranslatableTextSchema.optional().describe(
      "Message shown when a required answer is missing"
    ),
    hint: TranslatableTextSchema.optional().describe("Optional helper text shown below the question"),
    choices: z
      .array(QuestionChoiceSchema)
      .optional()
      .describe("Required for select_one / select_multiple / rank: the list of options"),
    choices_list_name: z
      .string()
      .optional()
      .describe(
        "Reuse one choice list across several questions. Give the same value (and the 'choices' array once) to share it; omit to auto-generate '<name>_list'."
      ),
    relevant: z
      .string()
      .optional()
      .describe(
        "Skip logic — the question appears only when this expression is true. Reference other questions with ${name}, e.g. \"${type_etablissement} = 'autre'\" or \"selected(${services}, 'livraison')\"."
      ),
    constraint: z
      .string()
      .optional()
      .describe(
        "Validation rule the answer must satisfy; '.' is the answer itself, e.g. \". >= 1950 and . <= 2026\"."
      ),
    constraint_message: TranslatableTextSchema.optional().describe(
      "Message shown when the constraint fails, e.g. 'Entre 1950 et 2026'"
    ),
    calculation: z
      .string()
      .optional()
      .describe("Expression for 'calculate' questions, e.g. \"${prix} * ${quantite}\""),
    default: z.string().optional().describe("Pre-filled answer"),
    appearance: z
      .string()
      .optional()
      .describe(
        "Widget style. Useful values: 'minimal' (dropdown), 'horizontal', 'likert', 'year', 'month-year' (dates), 'multiline' (text), 'field-list' (show a whole group on one screen), 'signature'/'draw' (image)."
      ),
    read_only: z.boolean().optional().describe("Show the answer but prevent editing"),
    parameters: z
      .string()
      .optional()
      .describe("Extra type settings, e.g. 'start=1 end=5 step=1' for a range, 'max-pixels=1024' for an image"),
    repeat_count: z
      .string()
      .optional()
      .describe("For 'begin_repeat': an expression fixing the number of repetitions"),
  })
  .strict();

const QuestionsArraySchema = z
  .array(QuestionSpecSchema)
  .min(1)
  .max(500)
  .describe(
    "Ordered, flat list of questions. Nesting is expressed with begin_group/end_group and begin_repeat/end_repeat rows, which must be balanced."
  );

export const CreateFormInputSchema = z
  .object({
    name: z.string().min(1).max(255).describe("Title of the form/project (e.g. 'Suivi des parcelles de cacao')"),
    description: z.string().max(1000).optional().describe("Optional short description of the form's purpose"),
    questions: QuestionsArraySchema,
    deploy: z
      .boolean()
      .default(true)
      .describe("If true, immediately deploy the form so it can start collecting submissions"),
  })
  .strict();

export const UpdateFormInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form to update (from kobo_list_forms)"),
    questions: QuestionsArraySchema.describe(
      "FULL replacement list of questions — any question left out is deleted from the form."
    ),
    redeploy: z
      .boolean()
      .default(true)
      .describe("If true, redeploy the form after updating so the new version goes live"),
    confirm_replace: z
      .boolean()
      .default(false)
      .describe(
        "Required (true) when the form already has submissions: replacing the structure can orphan collected data."
      ),
  })
  .strict();

export const PatchFormInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form to patch"),
    set_label: z
      .array(
        z.object({
          name: z.string().min(1).describe("Name of the existing question to relabel"),
          label: TranslatableTextSchema.describe("New label"),
        })
      )
      .optional()
      .describe("Change question labels in place"),
    set_hint: z
      .array(z.object({ name: z.string().min(1), hint: TranslatableTextSchema }))
      .optional()
      .describe("Change question hints in place"),
    set_required: z
      .array(z.object({ name: z.string().min(1), required: z.boolean() }))
      .optional()
      .describe("Toggle whether questions are mandatory"),
    set_relevant: z
      .array(z.object({ name: z.string().min(1), relevant: z.string() }))
      .optional()
      .describe("Set or replace skip logic on existing questions. Pass an empty string to clear it."),
    set_constraint: z
      .array(
        z.object({
          name: z.string().min(1),
          constraint: z.string(),
          constraint_message: TranslatableTextSchema.optional(),
        })
      )
      .optional()
      .describe("Set or replace a validation rule. Pass an empty constraint to clear it."),
    add_choices: z
      .array(z.object({ name: z.string().min(1), choices: z.array(QuestionChoiceSchema).min(1) }))
      .optional()
      .describe("Append options to an existing select question's choice list"),
    remove_questions: z
      .array(z.string().min(1))
      .optional()
      .describe("Names of questions to delete. Removing a group also removes everything inside it."),
    redeploy: z.boolean().default(true).describe("Redeploy so the change goes live"),
  })
  .strict();

export const ListFormsInputSchema = z
  .object({
    search: z.string().optional().describe("Optional text to filter forms by name"),
    limit: z.number().int().min(1).max(100).default(30).describe("Maximum number of forms to return"),
    offset: z.number().int().min(0).default(0).describe("Number of forms to skip, for pagination"),
    response_format: ResponseFormatSchema,
  })
  .strict();

export const GetFormInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form (from kobo_list_forms)"),
    language: z
      .string()
      .optional()
      .describe("For a multilingual form, which language's labels to show (e.g. 'fr'). Defaults to the first."),
    response_format: ResponseFormatSchema,
  })
  .strict();

export const DeployFormInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form to deploy"),
  })
  .strict();

export const ArchiveFormInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the deployed form"),
    active: z
      .boolean()
      .describe(
        "false to archive (stop accepting submissions, keeping every response), true to reactivate a previously archived form"
      ),
  })
  .strict();

export const CloneFormInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form to copy"),
    name: z.string().min(1).max(255).optional().describe("Name for the copy (default: '<original> (copie)')"),
    deploy: z.boolean().default(false).describe("Deploy the copy immediately"),
  })
  .strict();

export const DeleteFormInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form to permanently delete"),
    confirm: z
      .literal(true)
      .describe("Must be explicitly set to true to confirm this irreversible deletion"),
    confirm_submission_count: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Required when the form has submissions: pass the exact number reported by kobo_list_forms, to prove the data loss is intended."
      ),
  })
  .strict();

export const FormVersionsInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form"),
    rollback_to: z
      .string()
      .optional()
      .describe("Version uid to redeploy. Omit to only list the version history."),
    limit: z.number().int().min(1).max(100).default(30).describe("How many versions to list"),
    response_format: ResponseFormatSchema,
  })
  .strict();

export const GetCollectLinksInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the deployed form"),
    include_qr: z
      .boolean()
      .default(false)
      .describe("Also return a QR code image of the offline collect link, to print on a flyer or a table card"),
    response_format: ResponseFormatSchema,
  })
  .strict();

export const SetSharingInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form"),
    anonymous_submissions: z
      .boolean()
      .optional()
      .describe(
        "true makes the Enketo collect link usable by anyone without a Kobo account — this is what turns a deployed form into a genuinely public link. false revokes it."
      ),
    share_with: z
      .array(
        z.object({
          username: z.string().min(1).describe("Kobo username of the collaborator"),
          role: z
            .enum(["view", "edit", "manage"])
            .describe(
              "view = see the form and its data; edit = also add and change submissions; manage = full control including sharing"
            ),
        })
      )
      .optional()
      .describe("Grant collaborators access to the form"),
    revoke_from: z
      .array(z.string().min(1))
      .optional()
      .describe("Kobo usernames whose access should be removed entirely"),
    response_format: ResponseFormatSchema,
  })
  .strict();

export const ExportXlsformInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form to download as XLSForm"),
    output_path: z
      .string()
      .optional()
      .describe("Where to write the .xlsx (default: the server's output directory)"),
  })
  .strict();

export const ImportXlsformInputSchema = z
  .object({
    file_path: z.string().min(1).describe("Path to the XLSForm .xlsx file on disk"),
    name: z.string().min(1).max(255).optional().describe("Name for the imported form (default: the file name)"),
    uid: z
      .string()
      .optional()
      .describe("Asset uid to overwrite with this file. Omit to create a new form."),
    deploy: z.boolean().default(false).describe("Deploy once the import finishes"),
  })
  .strict();

export const ListSubmissionsInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form (from kobo_list_forms)"),
    limit: z.number().int().min(1).max(100).default(30).describe("Maximum number of submissions to return"),
    offset: z.number().int().min(0).default(0).describe("Number of submissions to skip, for pagination"),
    query: z
      .string()
      .optional()
      .describe("Optional Mongo-style filter query, e.g. '{\"farmer_name\":\"Kouassi\"}'"),
    response_format: ResponseFormatSchema,
  })
  .strict();

export const GetSubmissionInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form"),
    submission_id: z.string().min(1).describe("Submission id (from kobo_list_submissions)"),
    response_format: ResponseFormatSchema,
  })
  .strict();

export const DeleteSubmissionInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form"),
    submission_ids: z
      .array(z.string().min(1))
      .min(1)
      .describe("Ids of the submissions to permanently delete"),
    confirm: z.literal(true).describe("Must be true — deleted submissions cannot be recovered"),
  })
  .strict();

export const ValidateSubmissionsInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form"),
    submission_ids: z.array(z.string().min(1)).min(1).describe("Ids of the submissions to mark"),
    status: z
      .enum(VALIDATION_STATUSES)
      .describe("Validation status to apply, as shown in Kobo's data table"),
  })
  .strict();

export const DownloadAttachmentsInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form"),
    submission_ids: z
      .array(z.string().min(1))
      .optional()
      .describe("Limit to these submissions. Omit to fetch attachments from all of them."),
    output_dir: z
      .string()
      .optional()
      .describe("Directory to write the files into (default: <output dir>/<form>_attachments)"),
    max_files: z.number().int().min(1).max(2000).default(200).describe("Safety cap on how many files to pull"),
  })
  .strict();

export const SubmitDataInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the deployed form to submit to"),
    answers: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .describe(
        "Answers keyed by the question's submission path, exactly as kobo_get_form reports it. A question inside a group is 'group_name/question_name'. select_multiple values are space-separated codes, e.g. 'especes mobile_money'."
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(1)
      .describe("Submit the same answers this many times — for load-testing a form, not for real data"),
  })
  .strict();

export const ExportSubmissionsInputSchema = z
  .object({
    uid: z.string().min(1).describe("Asset uid of the form to export submissions from"),
    format: z.enum(["xlsx", "csv"]).default("xlsx").describe("Export file format"),
    language: z
      .string()
      .optional()
      .describe("Label language for the column headers on a multilingual form (default: the stored codes)"),
  })
  .strict();
