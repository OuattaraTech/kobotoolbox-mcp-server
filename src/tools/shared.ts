import { KoboApiError } from "../services/koboClient.js";
import { FormSpecError } from "../services/formBuilder.js";
import { RenderError } from "../services/renderer.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { KoboDeploymentLinks } from "../types.js";

/** Turns any thrown value into the error shape MCP tools return. */
export function errorContent(error: unknown) {
  if (error instanceof FormSpecError) {
    // A spec problem is the model's to fix, so say so plainly and keep the
    // full list of problems rather than truncating to the first one.
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Error: ${error.message}\n\nFix the question list and call the tool again — nothing was sent to Kobo.`,
        },
      ],
    };
  }

  const message =
    error instanceof KoboApiError || error instanceof RenderError || error instanceof Error
      ? error.message
      : String(error);
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

/** Keeps tool output from swamping the model's context window. */
export function truncate(text: string, limit: number = CHARACTER_LIMIT): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n\n[...tronqué, ${text.length - limit} caractères supplémentaires]`;
}

/** Renders non-fatal validation warnings under a tool's main answer. */
export function warningBlock(warnings: string[]): string {
  if (!warnings.length) return "";
  return `\n\nWarnings (the form was still created):\n${warnings.map((w) => `  - ${w}`).join("\n")}`;
}

/** Renders the Enketo links of a deployed form, offline URL first. */
export function linksBlock(links: KoboDeploymentLinks): string {
  if (!links || !Object.keys(links).length) return "";
  const rows: Array<[string, string | undefined]> = [
    ["Offline (recommended for field work)", links.offline_url],
    ["Online", links.url],
    ["One response per visit", links.single_url],
    ["Preview (nothing is saved)", links.preview_url],
    ["Embed in a web page", links.iframe_url],
  ];
  const listed = rows.filter(([, url]) => !!url).map(([label, url]) => `  - ${label}: ${url}`);
  return listed.length ? `\n\nCollect links:\n${listed.join("\n")}` : "";
}
