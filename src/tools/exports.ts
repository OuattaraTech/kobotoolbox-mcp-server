import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ExportSubmissionsInputSchema } from "../schemas/schemas.js";
import * as kobo from "../services/koboClient.js";
import { errorContent } from "./shared.js";

export function registerExportTools(server: McpServer): void {
  server.registerTool(
    "kobo_export_submissions_excel",
    {
      title: "Export KoboToolbox Submissions to Excel",
      description: `Generate a downloadable Excel (.xlsx) or CSV export of all submissions for a form, and return the file itself (base64-encoded) plus a direct download link.

This triggers a fresh export on the Kobo server, waits (up to ~90s) for it to finish, downloads the result, and returns it as an embedded file the calling app can save to disk.

Args:
  - uid (string): the form's asset uid (from kobo_list_forms)
  - format ('xlsx' | 'csv', default 'xlsx')
  - language (string, optional): label language for the column headers on a multilingual form

Returns: the file as an embedded resource (base64), its size, and a direct download URL as a fallback.

Examples:
  - Use when: "Give me an Excel file of all responses to my cocoa form" -> uid=..., format="xlsx"
  - Don't use when: you just want to read a few submissions in chat (use kobo_list_submissions instead — much faster)

Error Handling:
  - Returns "Error: ... did not complete within 90s" for very large forms — the export may still finish server-side; check the Kobo web UI's export history`,
      inputSchema: ExportSubmissionsInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: z.infer<typeof ExportSubmissionsInputSchema>) => {
      try {
        const asset = await kobo.getAsset(params.uid);
        const exportTask = await kobo.createExport(params.uid, {
          format: params.format,
          lang: params.language,
        });
        const downloadUrl = await kobo.waitForExport(params.uid, exportTask.uid);
        const fileBuffer = await kobo.downloadFile(downloadUrl);

        const mimeType =
          params.format === "csv"
            ? "text/csv"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        const safeName = asset.name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60);
        const fileName = `${safeName}.${params.format}`;
        const base64 = fileBuffer.toString("base64");

        return {
          content: [
            {
              type: "text" as const,
              text: `Export ready: ${fileName} (${(fileBuffer.length / 1024).toFixed(1)} KB). File content is attached as a base64-encoded resource — decode and save it as "${fileName}". Direct download URL (requires the same Kobo API token as an Authorization header): ${downloadUrl}`,
            },
            {
              type: "resource" as const,
              resource: {
                uri: `kobo-export://${params.uid}/${fileName}`,
                mimeType,
                blob: base64,
              },
            },
          ],
          structuredContent: {
            file_name: fileName,
            size_bytes: fileBuffer.length,
            download_url: downloadUrl,
            format: params.format,
          },
        };
      } catch (error) {
        return errorContent(error);
      }
    }
  );
}
