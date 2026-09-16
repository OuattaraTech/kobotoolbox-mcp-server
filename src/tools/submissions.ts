import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import {
  ListSubmissionsInputSchema,
  GetSubmissionInputSchema,
  DeleteSubmissionInputSchema,
  ValidateSubmissionsInputSchema,
  DownloadAttachmentsInputSchema,
  SubmitDataInputSchema,
} from "../schemas/schemas.js";
import * as kobo from "../services/koboClient.js";
import { OUTPUT_DIR } from "../constants.js";
import { errorContent, truncate } from "./shared.js";

// Kobo prefixes metadata fields with underscores/dashes; keep only
// respondent-entered fields plus a few useful metadata ones for a compact view.
function simplifySubmission(sub: Record<string, unknown>): Record<string, unknown> {
  const keep: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sub)) {
    if (key === "_id" || key === "_submission_time" || key === "_uuid" || !key.startsWith("_")) {
      keep[key] = value;
    }
  }
  return keep;
}

export function registerSubmissionTools(server: McpServer): void {
  server.registerTool(
    "kobo_list_submissions",
    {
      title: "List KoboToolbox Form Submissions",
      description: `List submitted responses for a form, most recent first.

Args:
  - uid (string): the form's asset uid (from kobo_list_forms)
  - limit (number): max submissions to return, 1-100 (default 30)
  - offset (number): pagination offset (default 0)
  - query (string, optional): Mongo-style JSON filter, e.g. '{"crop_health":"poor"}'
  - response_format ('markdown' | 'json')

Returns: submission id, submission time, and answered fields for each submission.

Examples:
  - Use when: "Show me the latest 10 responses to my cocoa form" -> uid=..., limit=10
  - Use when: "Which submissions reported poor crop health?" -> query='{"crop_health":"poor"}'
  - Don't use when: you want a downloadable Excel file (use kobo_export_submissions_excel instead)`,
      inputSchema: ListSubmissionsInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof ListSubmissionsInputSchema>) => {
      try {
        const data = await kobo.listSubmissions(params.uid, {
          limit: params.limit,
          offset: params.offset,
          query: params.query,
        });
        const results = (data as any).results ?? (Array.isArray(data) ? data : []);
        const total = (data as any).count ?? results.length;

        if (!results.length) {
          return { content: [{ type: "text" as const, text: "No submissions found." }] };
        }

        const submissions = results.map(simplifySubmission);
        const output = {
          total,
          count: submissions.length,
          offset: params.offset,
          submissions,
          has_more: params.offset + submissions.length < total,
        };

        if (params.response_format === "json") {
          return {
            content: [{ type: "text" as const, text: truncate(JSON.stringify(output, null, 2)) }],
            structuredContent: output,
          };
        }

        const lines = submissions.map((s: any) => {
          const fields = Object.entries(s)
            .filter(([k]) => k !== "_id" && k !== "_submission_time")
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ");
          return `- #${s["_id"]} (${s["_submission_time"] || "?"}): ${fields}`;
        });
        const text = `${output.total} total submission(s), showing ${output.count}:\n\n${lines.join("\n")}${
          output.has_more ? "\n\n_More available — increase offset._" : ""
        }`;
        return { content: [{ type: "text" as const, text: truncate(text) }] };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_get_submission",
    {
      title: "Get a Single KoboToolbox Submission",
      description: `Get the full detail of one submission by its id.

Args:
  - uid (string): the form's asset uid
  - submission_id (string): the submission id (the "_id" field from kobo_list_submissions)
  - response_format ('markdown' | 'json')

Returns: every field and value recorded in that submission.`,
      inputSchema: GetSubmissionInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof GetSubmissionInputSchema>) => {
      try {
        const sub = await kobo.getSubmission(params.uid, params.submission_id);
        const simplified = simplifySubmission(sub);

        if (params.response_format === "json") {
          return {
            content: [{ type: "text" as const, text: truncate(JSON.stringify(simplified, null, 2)) }],
            structuredContent: simplified,
          };
        }

        const lines = Object.entries(simplified).map(([k, v]) => `- **${k}**: ${JSON.stringify(v)}`);
        return { content: [{ type: "text" as const, text: truncate(lines.join("\n")) }] };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_delete_submissions",
    {
      title: "Delete KoboToolbox Submissions",
      description: `Permanently delete specific submissions from a form. THIS CANNOT BE UNDONE.

Use it to remove test entries, duplicates, or a response a respondent asked to withdraw.

Args:
  - uid (string): asset uid of the form
  - submission_ids (array of strings): the "_id" values from kobo_list_submissions
  - confirm (true): must be explicitly set to true

Don't use when: you want to discard a whole form's data — that is kobo_delete_form. To merely flag bad rows while keeping them, use kobo_validate_submissions with 'not approved' instead.`,
      inputSchema: DeleteSubmissionInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof DeleteSubmissionInputSchema>) => {
      try {
        const count = await kobo.deleteSubmissions(params.uid, params.submission_ids);
        return {
          content: [
            {
              type: "text" as const,
              text: `Permanently deleted ${count} submission(s) from form ${params.uid}: ${params.submission_ids.join(", ")}.`,
            },
          ],
          structuredContent: { uid: params.uid, deleted: params.submission_ids },
        };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_validate_submissions",
    {
      title: "Set Validation Status on Submissions",
      description: `Mark submissions as approved, not approved, or on hold — Kobo's data-cleaning workflow.

This is the non-destructive way to handle suspect responses: the row stays in the database and in exports, carrying its status, instead of being deleted.

Args:
  - uid (string): asset uid of the form
  - submission_ids (array of strings): the "_id" values to mark
  - status: 'validation_status_approved' | 'validation_status_not_approved' | 'validation_status_on_hold'

Returns: how many submissions were updated.`,
      inputSchema: ValidateSubmissionsInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof ValidateSubmissionsInputSchema>) => {
      try {
        const updated = await kobo.setValidationStatus(params.uid, params.submission_ids, params.status);
        const label = params.status.replace("validation_status_", "").replace(/_/g, " ");
        return {
          content: [
            { type: "text" as const, text: `Marked ${updated} submission(s) as "${label}" on form ${params.uid}.` },
          ],
          structuredContent: { uid: params.uid, updated, status: params.status },
        };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_download_attachments",
    {
      title: "Download KoboToolbox Attachments",
      description: `Download the photos, audio, video and files attached to submissions.

A form with an 'image' question (a shopfront photo, a signed consent form, a damaged crop) stores its files on Kobo, and nothing in an Excel export contains them — only file names. This fetches the actual files to disk, organised one folder per submission.

Args:
  - uid (string): asset uid of the form
  - submission_ids (array, optional): limit to these submissions; omit for all
  - output_dir (string, optional): where to write (default: <output dir>/<form>_attachments)
  - max_files (number, default 200): safety cap

Returns: the directory written, the number of files and their total size.`,
      inputSchema: DownloadAttachmentsInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof DownloadAttachmentsInputSchema>) => {
      try {
        const asset = await kobo.getAsset(params.uid);
        const { rows } = await kobo.fetchAllSubmissions(params.uid);

        const wanted = params.submission_ids ? new Set(params.submission_ids.map(String)) : undefined;
        const selected = wanted ? rows.filter((r) => wanted.has(String((r as any)["_id"]))) : rows;

        const refs = kobo.collectAttachments(selected as Array<Record<string, any>>);
        if (!refs.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No attachments found on ${selected.length} submission(s) of "${asset.name}". Only image, audio, video and file questions produce them.`,
              },
            ],
          };
        }

        const safeName = asset.name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) || asset.uid;
        const destination = params.output_dir ?? path.join(OUTPUT_DIR, `${safeName}_attachments`);
        await fs.mkdir(destination, { recursive: true });

        const capped = refs.slice(0, params.max_files);
        let bytes = 0;
        const failures: string[] = [];

        for (const ref of capped) {
          const target = path.join(destination, ref.submissionId, ref.basename);
          try {
            bytes += await kobo.downloadAttachmentTo(ref, target);
          } catch (error) {
            failures.push(`${ref.basename}: ${(error as Error).message}`);
          }
        }

        const written = capped.length - failures.length;
        const text =
          `Downloaded ${written} attachment(s) (${(bytes / 1024 / 1024).toFixed(1)} MB) to ${destination}, ` +
          `one folder per submission id.` +
          (refs.length > capped.length
            ? `\n\n${refs.length - capped.length} more available — raise max_files to fetch them.`
            : "") +
          (failures.length ? `\n\nFailed:\n${failures.slice(0, 10).map((f) => `  - ${f}`).join("\n")}` : "");

        return {
          content: [{ type: "text" as const, text: truncate(text) }],
          structuredContent: {
            directory: destination,
            files_written: written,
            total_available: refs.length,
            bytes,
          },
        };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_submit_data",
    {
      title: "Submit Data to a KoboToolbox Form",
      description: `Send a response to a deployed form through the API, without going through the web form.

Use it to test a form end-to-end before sending enumerators out, or to migrate answers already collected on paper or in a spreadsheet.

Args:
  - uid (string): asset uid of the DEPLOYED form
  - answers (object): values keyed by the question's submission path, exactly as kobo_get_form reports it.
      A question inside a group is "group_name/question_name".
      select_multiple values are space-separated codes: "especes mobile_money".
      Dates are ISO: "2026-09-16". geopoint is "lat lon altitude accuracy".
  - count (number, default 1): submit the same answers several times, for load-testing only

Returns: the instance id Kobo assigned.

Notes:
  - Submitted rows are real data and count towards the form's submission total. Delete test rows with kobo_delete_submissions.
  - Attachments (photos, audio) cannot be sent this way — use the web form for those.

Error Handling:
  - A rejected submission almost always means a field name that does not exist in the form; check the exact paths with kobo_get_form.`,
      inputSchema: SubmitDataInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof SubmitDataInputSchema>) => {
      try {
        const ids: string[] = [];
        for (let i = 0; i < params.count; i++) {
          const { instanceId } = await kobo.submitData(params.uid, params.answers);
          ids.push(instanceId);
        }

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Submitted ${ids.length} response(s) to form ${params.uid}.\n\nInstance id(s): ${ids.join(", ")}\n\n` +
                `These are real submissions and appear in exports. Remove them with kobo_delete_submissions if they were tests.`,
            },
          ],
          structuredContent: { uid: params.uid, submitted: ids.length, instance_ids: ids },
        };
      } catch (error) {
        return errorContent(error);
      }
    }
  );
}
