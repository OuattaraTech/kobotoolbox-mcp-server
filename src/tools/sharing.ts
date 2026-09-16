import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GetCollectLinksInputSchema, SetSharingInputSchema } from "../schemas/schemas.js";
import * as kobo from "../services/koboClient.js";
import QRCode from "qrcode";
import { errorContent, truncate, linksBlock } from "./shared.js";

const ANONYMOUS = "AnonymousUser";
/** What an anonymous visitor needs to open a form and submit to it. */
const ANONYMOUS_COLLECT = ["view_asset", "add_submissions"];

export function registerSharingTools(server: McpServer): void {
  server.registerTool(
    "kobo_get_collect_links",
    {
      title: "Get KoboToolbox Collect Links",
      description: `Get the shareable links of a deployed form — the actual deliverable once a form is built.

Returns every Enketo URL Kobo publishes:
  - offline: caches in the browser and works without a connection, syncing later. The one to give field teams.
  - online: plain web form
  - single: submits once and closes, for one-response-per-person links
  - preview: renders the form without saving anything, for internal review
  - iframe: to embed the form in a web page

It also reports whether the form is genuinely PUBLIC. A deployed form's link still asks for a Kobo login until anonymous submissions are enabled — use kobo_set_sharing for that.

Args:
  - uid (string): asset uid of the deployed form
  - include_qr (boolean, default false): also return a QR code image of the offline link, to print on a flyer, a poster or a table card
  - response_format ('markdown' | 'json')`,
      inputSchema: GetCollectLinksInputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof GetCollectLinksInputSchema>) => {
      try {
        const asset = await kobo.getAsset(params.uid);
        const links = kobo.collectLinks(asset);

        if (!Object.keys(links).length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Form "${asset.name}" has no collect links: it is ${asset.deployment_status}, not deployed. Deploy it first with kobo_deploy_form.`,
              },
            ],
          };
        }

        const assignments = await kobo.listPermissions(params.uid);
        const anonymous = assignments
          .filter((a) => kobo.urlTail(a.user) === ANONYMOUS)
          .map((a) => kobo.urlTail(a.permission));
        const isPublic = ANONYMOUS_COLLECT.every((p) => anonymous.includes(p));

        const output = {
          uid: asset.uid,
          name: asset.name,
          deployment_status: asset.deployment_status,
          is_public: isPublic,
          collect_links: links,
        };

        if (params.response_format === "json") {
          return {
            content: [{ type: "text" as const, text: truncate(JSON.stringify(output, null, 2)) }],
            structuredContent: output,
          };
        }

        const access = isPublic
          ? "🌍 **Public** — anyone with the link can submit, no Kobo account needed."
          : "🔒 **Not public** — the link asks for a Kobo login. Enable anonymous submissions with kobo_set_sharing (anonymous_submissions=true).";

        const content: Array<Record<string, unknown>> = [
          {
            type: "text" as const,
            text: `**${asset.name}** (uid: \`${asset.uid}\`) — ${asset.deployment_status}\n\n${access}${linksBlock(links)}`,
          },
        ];

        // A printed QR code is how a restaurant owner or a passer-by actually
        // reaches the form, so it is worth returning as a real image.
        const qrTarget = links.offline_url ?? links.url;
        if (params.include_qr && qrTarget) {
          const dataUrl = await QRCode.toDataURL(qrTarget, { width: 600, margin: 2 });
          content.push({
            type: "image" as const,
            data: dataUrl.split(",")[1],
            mimeType: "image/png",
          });
          content[0] = {
            ...content[0],
            text: `${content[0].text}\n\nQR code below points to: ${qrTarget}`,
          };
        }

        return { content: content as any, structuredContent: output };
      } catch (error) {
        return errorContent(error);
      }
    }
  );

  server.registerTool(
    "kobo_set_sharing",
    {
      title: "Set KoboToolbox Form Sharing",
      description: `Control who can fill in a form and who can work on it.

Two independent things:
  - anonymous_submissions: makes the collect link usable by ANYONE who has it, with no Kobo account. This is what turns a deployed form into a genuinely public link. It never lets the public read the responses already collected — only submit new ones.
  - share_with / revoke_from: give or remove named collaborators' access to the form and its data.

Roles:
  - view: see the form and read its submissions
  - edit: also add and change submissions, and edit the form
  - manage: full control, including sharing it further

Args:
  - uid (string): asset uid of the form
  - anonymous_submissions (boolean, optional): true to publish, false to revoke
  - share_with: [{username, role}]
  - revoke_from: [usernames] — removes every permission that user holds
  - response_format ('markdown' | 'json')

Returns: the resulting access list, and the collect links when the form becomes public.

Examples:
  - "Make my form publicly fillable" -> anonymous_submissions=true
  - "Let Awa edit the data" -> share_with=[{username:"awa", role:"edit"}]

Notes:
  - Publishing a form is outward-facing: anyone with the URL can then submit. Confirm with the user before enabling it unless they asked.`,
      inputSchema: SetSharingInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params: z.infer<typeof SetSharingInputSchema>) => {
      try {
        const asset = await kobo.getAsset(params.uid);
        const changes: string[] = [];

        if (params.anonymous_submissions === true) {
          if (!asset.deployment__links || !Object.keys(asset.deployment__links).length) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Error: form "${asset.name}" is ${asset.deployment_status}, so there is no collect link to publish. Deploy it first with kobo_deploy_form.`,
                },
              ],
            };
          }
          for (const codename of ANONYMOUS_COLLECT) {
            await kobo.assignPermission(params.uid, ANONYMOUS, codename);
          }
          changes.push("anonymous submissions enabled — the collect link is now public");
        } else if (params.anonymous_submissions === false) {
          const removed = await kobo.revokeUser(params.uid, ANONYMOUS);
          changes.push(
            removed
              ? "anonymous submissions revoked — the link now requires a Kobo login"
              : "anonymous submissions were already disabled"
          );
        }

        for (const { username, role } of params.share_with ?? []) {
          for (const codename of kobo.ROLE_PERMISSIONS[role]) {
            await kobo.assignPermission(params.uid, username, codename);
          }
          changes.push(`${username} granted '${role}' access`);
        }

        for (const username of params.revoke_from ?? []) {
          const removed = await kobo.revokeUser(params.uid, username);
          changes.push(
            removed ? `${username}'s access removed (${removed} permission(s))` : `${username} had no access`
          );
        }

        if (!changes.length) {
          changes.push("nothing changed — no sharing options were passed");
        }

        // Report the resulting state rather than assuming the writes stuck.
        const assignments = await kobo.listPermissions(params.uid);
        const byUser: Record<string, string[]> = {};
        for (const a of assignments) {
          (byUser[kobo.urlTail(a.user)] ||= []).push(kobo.urlTail(a.permission));
        }
        const isPublic = ANONYMOUS_COLLECT.every((p) => (byUser[ANONYMOUS] ?? []).includes(p));

        const output = {
          uid: params.uid,
          changes,
          is_public: isPublic,
          access: byUser,
          collect_links: isPublic ? kobo.collectLinks(asset) : {},
        };

        if (params.response_format === "json") {
          return {
            content: [{ type: "text" as const, text: truncate(JSON.stringify(output, null, 2)) }],
            structuredContent: output,
          };
        }

        const accessLines = Object.entries(byUser)
          .map(([user, perms]) => `  - ${user === ANONYMOUS ? "anyone with the link" : user}: ${perms.join(", ")}`)
          .join("\n");

        const text =
          `**${asset.name}** (uid: \`${asset.uid}\`)\n\nApplied:\n${changes.map((c) => `  - ${c}`).join("\n")}\n\nAccess now:\n${accessLines}` +
          (isPublic ? linksBlock(kobo.collectLinks(asset)) : "");

        return { content: [{ type: "text" as const, text: truncate(text) }], structuredContent: output };
      } catch (error) {
        return errorContent(error);
      }
    }
  );
}
