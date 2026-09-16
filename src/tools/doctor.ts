import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as kobo from "../services/koboClient.js";
import { checkRenderer, checkLibreOffice } from "../services/renderer.js";
import { KOBO_BASE_URL, KOBO_API_TOKEN, OUTPUT_DIR, PYTHON_BIN } from "../constants.js";
import { errorContent, truncate } from "./shared.js";

const DoctorInputSchema = z
  .object({
    response_format: z.enum(["markdown", "json"]).default("markdown"),
  })
  .strict();

/**
 * One place to answer "why isn't this working?", covering the things that
 * actually break in practice: a missing or wrong API token, an unreachable
 * server, a Python environment without the report renderer's dependencies, and
 * a LibreOffice that the PDF step cannot find.
 *
 * Checks flagged `optional` never fail the diagnosis: they gate one output
 * format, not the server, so they are reported as a limitation instead.
 */
export function registerDoctorTools(server: McpServer): void {
  server.registerTool(
    "kobo_doctor",
    {
      title: "Check the KoboToolbox MCP Server Setup",
      description: `Diagnose this server's configuration: the Kobo connection, the API token, the output directory and the Python report renderer.

Run it first when a tool fails for an unclear reason, or right after installing the server.

Returns: a pass/fail line per check, with the exact command to fix anything broken.`,
      inputSchema: DoctorInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof DoctorInputSchema>) => {
      try {
        const checks: Array<{ name: string; ok: boolean; detail: string; optional?: boolean }> = [];

        checks.push({
          name: "KOBO_BASE_URL",
          ok: true,
          detail: KOBO_BASE_URL,
        });

        if (!KOBO_API_TOKEN) {
          checks.push({
            name: "KOBO_API_TOKEN",
            ok: false,
            detail:
              "not set. Get one at <base url>/#/account/security (Account Settings > Security > API key) and put it in the .env file.",
          });
        } else {
          try {
            const forms = await kobo.listAssets({ limit: 1, assetType: "survey" });
            checks.push({
              name: "KOBO_API_TOKEN",
              ok: true,
              detail: `valid — ${forms.count} form(s) reachable.`,
            });
          } catch (error) {
            checks.push({ name: "KOBO_API_TOKEN", ok: false, detail: (error as Error).message });
          }
        }

        const renderer = await checkRenderer();
        checks.push({ name: `Python renderer (${PYTHON_BIN})`, ok: renderer.ok, detail: renderer.detail });

        // Only reached when Python itself works, since the check runs through it.
        if (renderer.ok) {
          const libreOffice = await checkLibreOffice();
          checks.push({
            name: "LibreOffice (PDF)",
            ok: libreOffice.ok,
            detail: libreOffice.detail,
            optional: true,
          });
        }

        checks.push({ name: "Output directory", ok: true, detail: OUTPUT_DIR });

        const allOk = checks.every((c) => c.ok || c.optional);
        const output = { ok: allOk, checks };

        if (params.response_format === "json") {
          return {
            content: [{ type: "text" as const, text: truncate(JSON.stringify(output, null, 2)) }],
            structuredContent: output,
          };
        }

        const lines = checks.map(
          (c) => `${c.ok ? "✓" : c.optional ? "!" : "✗"} **${c.name}** — ${c.detail}`
        );
        const limitations = checks.filter((c) => !c.ok && c.optional).length;
        const headline = !allOk
          ? "Some checks failed."
          : limitations
            ? "All required checks passed, with one limitation (marked !)."
            : "All checks passed.";
        const text = `${headline}\n\n${lines.join("\n")}`;
        return { content: [{ type: "text" as const, text: truncate(text) }], structuredContent: output };
      } catch (error) {
        return errorContent(error);
      }
    }
  );
}
