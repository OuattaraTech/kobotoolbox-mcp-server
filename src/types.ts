export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export interface KoboAssetSummary {
  uid: string;
  name: string;
  asset_type: string;
  deployment_status: string; // "deployed" | "draft" | "archived"
  date_created: string;
  date_modified: string;
  owner__username?: string;
  /** The v2 assets endpoint reports the count under this name. */
  deployment__submission_count?: number;
  deployment__last_submission_time?: string | null;
  submission_count?: number;
}

/** Enketo URLs Kobo publishes once a form is deployed. */
export interface KoboDeploymentLinks {
  /** Online-only form. */
  url?: string;
  /** Offline-capable form — the one to hand to field teams. */
  offline_url?: string;
  /** Submits and closes; suited to one-response-per-person links. */
  single_url?: string;
  /** Single submission, usable only once. */
  single_once_url?: string;
  preview_url?: string;
  iframe_url?: string;
  single_iframe_url?: string;
  single_once_iframe_url?: string;
}

export interface KoboAssetDetail extends KoboAssetSummary {
  content?: {
    survey?: Array<Record<string, unknown>>;
    choices?: Array<Record<string, unknown>>;
    settings?: Record<string, unknown>;
    translations?: Array<string | null>;
    translated?: string[];
  };
  deployment__submission_count?: number;
  deployment__active?: boolean;
  deployment__links?: KoboDeploymentLinks;
  version_id?: string;
  deployed_version_id?: string;
  has_deployment?: boolean;
  data?: string; // URL to submissions endpoint
}

export interface KoboPaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface KoboExport {
  uid: string;
  url: string;
  status: "created" | "processing" | "complete" | "error";
  result?: string; // download URL when complete
  messages?: Record<string, unknown>;
  data: {
    type: string;
    fields?: string[];
    lang?: string;
    group_sep?: string;
    hierarchy_in_labels?: boolean;
    fields_from_all_versions?: boolean;
  };
  date_created: string;
}

/** One permission assignment on an asset. */
export interface KoboPermissionAssignment {
  url: string;
  user: string;
  permission: string;
  label?: string;
}

/**
 * A string shown to respondents. Either one piece of text, or a map of
 * language name to text for a multilingual form, e.g.
 * `{ "Français (fr)": "Nom", "English (en)": "Name" }`.
 */
export type TranslatableText = string | Record<string, string>;

export interface ChoiceSpec {
  name: string;
  label: TranslatableText;
}

/**
 * Simplified question spec exposed to the model for form creation, translated
 * internally into Kobo's XLSForm-style `content` JSON by `formBuilder`.
 *
 * The list is flat and XLSForm-faithful: nesting is expressed by
 * `begin_group` / `end_group` and `begin_repeat` / `end_repeat` rows rather
 * than by nested objects.
 */
export interface QuestionSpec {
  type: string;
  name: string;
  label?: TranslatableText;
  hint?: TranslatableText;
  required?: boolean;
  required_message?: TranslatableText;
  choices?: ChoiceSpec[];
  /** Share one choice list between questions instead of generating `<name>_list`. */
  choices_list_name?: string;
  /** Skip logic: the question shows only when this XPath expression is true. */
  relevant?: string;
  /** Validation rule the answer must satisfy, e.g. `. >= 0 and . <= 120`. */
  constraint?: string;
  constraint_message?: TranslatableText;
  /** Expression for `calculate` questions. */
  calculation?: string;
  /** Pre-filled answer. */
  default?: string;
  /** Widget hint, e.g. `minimal`, `likert`, `horizontal`, `year`. */
  appearance?: string;
  read_only?: boolean;
  /** Extra settings, e.g. `start=1 end=5 step=1` for a range. */
  parameters?: string;
  /** For `begin_repeat`: expression fixing how many times it repeats. */
  repeat_count?: string;
}

/** Kobo's XLSForm-style asset content. */
export interface FormContent {
  survey: Array<Record<string, unknown>>;
  choices: Array<Record<string, unknown>>;
  settings: Record<string, unknown>;
  translations?: Array<string | null>;
  translated?: string[];
}

/** Validation status codes Kobo accepts on a submission. */
export const VALIDATION_STATUSES = [
  "validation_status_not_approved",
  "validation_status_approved",
  "validation_status_on_hold",
] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];
