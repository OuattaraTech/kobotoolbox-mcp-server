import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from "axios";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";
import {
  KOBO_BASE_URL,
  KOBO_API_TOKEN,
  MAX_FETCH_ROWS,
  FETCH_PAGE_SIZE,
  RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
} from "../constants.js";
import {
  KoboAssetDetail,
  KoboAssetSummary,
  KoboPaginatedResponse,
  KoboExport,
  KoboPermissionAssignment,
  KoboDeploymentLinks,
  QuestionSpec,
  ValidationStatus,
} from "../types.js";
import { buildFormContent } from "./formBuilder.js";

export { buildFormContent };

export class KoboApiError extends Error {
  constructor(message: string, public status?: number, public details?: unknown) {
    super(message);
    this.name = "KoboApiError";
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Kobo throttles bursts and its app servers return sporadic 5xx under load.
 * Retrying is safe for reads and for any request the server never began
 * processing (429, connection errors); writes are deliberately not retried on
 * 5xx, since a create that half-succeeded would otherwise be duplicated.
 */
function isRetryable(error: AxiosError, method: string): boolean {
  if (error.code === "ECONNABORTED" || error.code === "ECONNRESET" || error.code === "ETIMEDOUT") return true;
  const status = error.response?.status;
  if (status === 429) return true;
  const idempotent = method === "get" || method === "head" || method === "options";
  return idempotent && !!status && status >= 500 && status < 600;
}

/** Honours Retry-After when Kobo sends it, otherwise backs off exponentially. */
function retryDelay(error: AxiosError, attempt: number): number {
  const header = error.response?.headers?.["retry-after"];
  if (header) {
    const seconds = Number(Array.isArray(header) ? header[0] : header);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30000);
  }
  return RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
}

function buildClient(timeout = 30000): AxiosInstance {
  if (!KOBO_API_TOKEN) {
    throw new KoboApiError(
      "Missing KOBO_API_TOKEN environment variable. Set it to your Kobo API token (Account Settings > Security > API key)."
    );
  }
  const client = axios.create({
    baseURL: `${KOBO_BASE_URL}/api/v2/`,
    headers: {
      Authorization: `Token ${KOBO_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout,
  });

  client.interceptors.response.use(undefined, async (error: AxiosError) => {
    const config = error.config as (AxiosRequestConfig & { __retryCount?: number }) | undefined;
    if (!config) throw error;
    const attempt = config.__retryCount ?? 0;
    if (attempt >= RETRY_ATTEMPTS || !isRetryable(error, (config.method ?? "get").toLowerCase())) {
      throw error;
    }
    config.__retryCount = attempt + 1;
    await sleep(retryDelay(error, attempt));
    return client.request(config);
  });

  return client;
}

/**
 * Kobo answers some malformed payloads with a full Django HTML error page.
 * Dumping that into the model's context is useless, so it is recognised and
 * replaced by guidance pointing at the usual cause.
 */
function summariseBody(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") {
    if (/<!doctype html>|<html/i.test(data)) return "";
    return data.slice(0, 500);
  }
  if (data instanceof Buffer) return "";
  try {
    return JSON.stringify(data).slice(0, 500);
  } catch {
    return "";
  }
}

function handleError(error: unknown, context: string): never {
  if (axios.isAxiosError(error)) {
    const err = error as AxiosError<any>;
    const status = err.response?.status;
    const body = summariseBody(err.response?.data);
    let message = `${context}: `;

    if (status === 401 || status === 403) {
      message +=
        "authentication failed. Check that KOBO_API_TOKEN is valid and that this account has access to the resource.";
    } else if (status === 404) {
      message += "resource not found. Double-check the uid you passed.";
    } else if (status === 400) {
      message += `Kobo rejected the request as invalid${body ? ` — ${body}` : "."}`;
    } else if (status === 429) {
      message += "Kobo is rate-limiting this token. Wait a moment and retry with fewer rows or a smaller page size.";
    } else if (status && status >= 500) {
      // The single most common cause, and the one that cost real debugging time.
      message +=
        `the Kobo server returned HTTP ${status} without a usable message. ` +
        "This almost always means the form content was malformed — most often an XLSForm type Kobo does not know " +
        "(use 'phonenumber', not 'phone_number'), an unbalanced begin_group/end_group, or a duplicate question name. " +
        "Validate the question list, then retry." +
        (body ? ` Server said: ${body}` : "");
    } else if (err.code === "ECONNABORTED") {
      message += "the request timed out. Try again or narrow the request.";
    } else {
      message += `${err.message}${body ? ` — ${body}` : ""}`;
    }
    throw new KoboApiError(message, status, err.response?.data);
  }
  throw new KoboApiError(`${context}: ${(error as Error).message}`);
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export async function listAssets(params: {
  q?: string;
  limit?: number;
  offset?: number;
  assetType?: string;
}): Promise<KoboPaginatedResponse<KoboAssetSummary>> {
  const client = buildClient();
  try {
    const query: Record<string, string | number> = {
      limit: params.limit ?? 30,
      offset: params.offset ?? 0,
    };
    const filters: string[] = [];
    if (params.assetType) filters.push(`asset_type:${params.assetType}`);
    if (params.q) filters.push(params.q);
    if (filters.length) query["q"] = filters.join(" AND ");

    const res = await client.get<KoboPaginatedResponse<KoboAssetSummary>>("assets/", { params: query });
    return res.data;
  } catch (error) {
    handleError(error, "Failed to list forms");
  }
}

export async function getAsset(uid: string): Promise<KoboAssetDetail> {
  const client = buildClient();
  try {
    const res = await client.get<KoboAssetDetail>(`assets/${uid}/`);
    return res.data;
  } catch (error) {
    handleError(error, `Failed to get form ${uid}`);
  }
}

export async function createAsset(params: {
  name: string;
  questions: QuestionSpec[];
  description?: string;
}): Promise<KoboAssetDetail> {
  const client = buildClient();
  try {
    const content = buildFormContent(params.questions, { description: params.description });
    const res = await client.post<KoboAssetDetail>("assets/", {
      name: params.name,
      asset_type: "survey",
      content,
    });
    return res.data;
  } catch (error) {
    handleError(error, "Failed to create form");
  }
}

export async function updateAssetContent(
  uid: string,
  questions: QuestionSpec[],
  options: { description?: string } = {}
): Promise<KoboAssetDetail> {
  const client = buildClient();
  try {
    const content = buildFormContent(questions, options);
    const res = await client.patch<KoboAssetDetail>(`assets/${uid}/`, { content });
    return res.data;
  } catch (error) {
    handleError(error, `Failed to update form ${uid}`);
  }
}

/** Writes back an already-assembled `content` object (used by the patch tool). */
export async function putAssetContent(uid: string, content: unknown): Promise<KoboAssetDetail> {
  const client = buildClient();
  try {
    const res = await client.patch<KoboAssetDetail>(`assets/${uid}/`, { content });
    return res.data;
  } catch (error) {
    handleError(error, `Failed to update form ${uid}`);
  }
}

export async function deployAsset(uid: string): Promise<KoboAssetDetail> {
  const client = buildClient();
  try {
    const asset = await client.get<KoboAssetDetail>(`assets/${uid}/`);
    const activeVersion = (asset.data as any).version_id;
    const alreadyDeployed = Boolean((asset.data as any).has_deployment);

    const payload = { active: true, ...(activeVersion ? { version_id: activeVersion } : {}) };
    // A first deployment is a POST; re-deploying an existing one is a PATCH.
    if (alreadyDeployed) {
      await client.patch(`assets/${uid}/deployment/`, payload);
    } else {
      await client.post(`assets/${uid}/deployment/`, payload);
    }

    const updated = await client.get<KoboAssetDetail>(`assets/${uid}/`);
    return updated.data;
  } catch (error) {
    handleError(error, `Failed to deploy form ${uid}`);
  }
}

/**
 * Archives (active=false) or reactivates a deployed form. Archiving stops new
 * submissions while keeping every response — the non-destructive alternative
 * to deleting a form that has finished collecting.
 */
export async function setDeploymentActive(uid: string, active: boolean): Promise<KoboAssetDetail> {
  const client = buildClient();
  try {
    await client.patch(`assets/${uid}/deployment/`, { active });
    const updated = await client.get<KoboAssetDetail>(`assets/${uid}/`);
    return updated.data;
  } catch (error) {
    handleError(error, `Failed to ${active ? "reactivate" : "archive"} form ${uid}`);
  }
}

export async function cloneAsset(uid: string, name?: string): Promise<KoboAssetDetail> {
  const client = buildClient();
  try {
    const res = await client.post<KoboAssetDetail>("assets/", {
      clone_from: uid,
      asset_type: "survey",
      ...(name ? { name } : {}),
    });
    return res.data;
  } catch (error) {
    handleError(error, `Failed to clone form ${uid}`);
  }
}

export async function deleteAsset(uid: string): Promise<void> {
  const client = buildClient();
  try {
    await client.delete(`assets/${uid}/`);
  } catch (error) {
    handleError(error, `Failed to delete form ${uid}`);
  }
}

export interface KoboVersion {
  uid: string;
  version_number?: string;
  content_hash?: string;
  date_deployed?: string | null;
  date_modified?: string;
}

export async function listVersions(uid: string, limit = 30): Promise<KoboVersion[]> {
  const client = buildClient();
  try {
    const res = await client.get<KoboPaginatedResponse<KoboVersion>>(`assets/${uid}/versions/`, {
      params: { limit },
    });
    return res.data.results ?? [];
  } catch (error) {
    handleError(error, `Failed to list versions of form ${uid}`);
  }
}

/**
 * Redeploys a specific past version — the way back from a change that broke a
 * live form. Kobo keeps every deployed version, so this is a real rollback
 * rather than a re-upload.
 */
export async function deployVersion(uid: string, versionId: string): Promise<KoboAssetDetail> {
  const client = buildClient();
  try {
    await client.patch(`assets/${uid}/deployment/`, { active: true, version_id: versionId });
    const updated = await client.get<KoboAssetDetail>(`assets/${uid}/`);
    return updated.data;
  } catch (error) {
    handleError(error, `Failed to roll form ${uid} back to version ${versionId}`);
  }
}

export function collectLinks(asset: KoboAssetDetail): KoboDeploymentLinks {
  return asset.deployment__links ?? {};
}

// ---------------------------------------------------------------------------
// XLSForm import / export
// ---------------------------------------------------------------------------

/** Downloads the form as a real XLSForm workbook — the sector's exchange format. */
export async function downloadXlsform(uid: string): Promise<Buffer> {
  try {
    const res = await axios.get(`${KOBO_BASE_URL}/api/v2/assets/${uid}/`, {
      params: { format: "xls" },
      headers: { Authorization: `Token ${KOBO_API_TOKEN}` },
      responseType: "arraybuffer",
      timeout: 60000,
    });
    return Buffer.from(res.data);
  } catch (error) {
    handleError(error, `Failed to download XLSForm for ${uid}`);
  }
}

export interface ImportResult {
  uid: string;
  status: string;
  messages?: Record<string, unknown>;
  assetUid?: string;
}

/**
 * Uploads an XLSForm workbook. Kobo processes imports asynchronously, so this
 * polls the import task until it settles and reports the resulting asset.
 */
export async function importXlsform(params: {
  fileBuffer: Buffer;
  fileName: string;
  name?: string;
  destinationUid?: string;
}): Promise<ImportResult> {
  const client = buildClient(120000);
  try {
    const body: Record<string, unknown> = {
      base64Encoded: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${params.fileBuffer.toString(
        "base64"
      )}`,
      name: params.name ?? params.fileName.replace(/\.xlsx?$/i, ""),
      assetUid: params.destinationUid,
      destination: params.destinationUid
        ? `${KOBO_BASE_URL}/api/v2/assets/${params.destinationUid}/`
        : undefined,
      library: false,
    };
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];

    const res = await client.post<any>("imports/", body);
    let task = res.data;

    // Poll the import task: it starts as "created"/"processing".
    const deadline = Date.now() + 90000;
    while (["created", "processing"].includes(String(task?.status)) && Date.now() < deadline) {
      await sleep(2000);
      const poll = await client.get<any>(`imports/${task.uid}/`);
      task = poll.data;
    }

    if (String(task?.status) === "error") {
      const detail = task?.messages?.error ?? task?.messages ?? "no detail";
      throw new KoboApiError(
        `Kobo rejected the XLSForm: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500)}`
      );
    }

    const assetUid =
      task?.messages?.created?.[0]?.uid ??
      task?.messages?.updated?.[0]?.uid ??
      params.destinationUid ??
      undefined;

    return { uid: task?.uid, status: String(task?.status ?? "unknown"), messages: task?.messages, assetUid };
  } catch (error) {
    if (error instanceof KoboApiError) throw error;
    handleError(error, "Failed to import XLSForm");
  }
}

// ---------------------------------------------------------------------------
// Permissions and sharing
// ---------------------------------------------------------------------------

/** Kobo's role bundles, ordered from least to most privileged. */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  view: ["view_asset", "view_submissions"],
  edit: ["view_asset", "view_submissions", "add_submissions", "change_submissions", "change_asset"],
  manage: [
    "view_asset",
    "view_submissions",
    "add_submissions",
    "change_submissions",
    "delete_submissions",
    "validate_submissions",
    "change_asset",
    "manage_asset",
  ],
};

export async function listPermissions(uid: string): Promise<KoboPermissionAssignment[]> {
  const client = buildClient();
  try {
    const res = await client.get<KoboPermissionAssignment[] | KoboPaginatedResponse<KoboPermissionAssignment>>(
      `assets/${uid}/permission-assignments/`
    );
    const data = res.data as any;
    return Array.isArray(data) ? data : data.results ?? [];
  } catch (error) {
    handleError(error, `Failed to read permissions for ${uid}`);
  }
}

/** Strips the query string Kobo sometimes leaves on hyperlinked fields. */
export function urlTail(url: string): string {
  return url.split("?")[0].replace(/\/$/, "").split("/").pop() ?? "";
}

export async function assignPermission(uid: string, username: string, codename: string): Promise<void> {
  const client = buildClient();
  try {
    await client.post(`assets/${uid}/permission-assignments/`, {
      user: `${KOBO_BASE_URL}/api/v2/users/${username}/`,
      permission: `${KOBO_BASE_URL}/api/v2/permissions/${codename}/`,
    });
  } catch (error) {
    // Re-granting an existing permission is a no-op, not a failure.
    if (axios.isAxiosError(error) && error.response?.status === 400) {
      const body = JSON.stringify(error.response.data ?? "");
      if (/already|unique|exists/i.test(body)) return;
    }
    handleError(error, `Failed to grant '${codename}' to ${username} on ${uid}`);
  }
}

export async function revokePermissionAssignment(uid: string, assignmentUrl: string): Promise<void> {
  const client = buildClient();
  try {
    await client.delete(assignmentUrl.replace(`${KOBO_BASE_URL}/api/v2/`, ""));
  } catch (error) {
    // Implied permissions disappear with their parent; a 404 here is benign.
    if (axios.isAxiosError(error) && error.response?.status === 404) return;
    handleError(error, `Failed to revoke a permission on ${uid}`);
  }
}

/** Removes every permission a given username holds on the asset. */
export async function revokeUser(uid: string, username: string): Promise<number> {
  const assignments = await listPermissions(uid);
  const mine = assignments.filter((a) => urlTail(a.user) === username);
  for (const assignment of mine) {
    await revokePermissionAssignment(uid, assignment.url);
  }
  return mine.length;
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

export async function listSubmissions(
  uid: string,
  params: { limit?: number; offset?: number; query?: string }
): Promise<KoboPaginatedResponse<Record<string, unknown>>> {
  const client = buildClient();
  try {
    const res = await client.get<any>(`assets/${uid}/data/`, {
      params: {
        limit: params.limit ?? 30,
        start: params.offset ?? 0,
        ...(params.query ? { query: params.query } : {}),
      },
    });
    return res.data;
  } catch (error) {
    handleError(error, `Failed to list submissions for form ${uid}`);
  }
}

export async function getSubmission(uid: string, submissionId: string): Promise<Record<string, unknown>> {
  const client = buildClient();
  try {
    const res = await client.get(`assets/${uid}/data/${submissionId}/`);
    return res.data;
  } catch (error) {
    handleError(error, `Failed to get submission ${submissionId} for form ${uid}`);
  }
}

export async function deleteSubmissions(uid: string, submissionIds: string[]): Promise<number> {
  const client = buildClient(60000);
  try {
    await client.delete(`assets/${uid}/data/bulk/`, {
      data: { payload: { submission_ids: submissionIds.map(String) } },
    });
    return submissionIds.length;
  } catch (error) {
    handleError(error, `Failed to delete submissions on form ${uid}`);
  }
}

export async function setValidationStatus(
  uid: string,
  submissionIds: string[],
  status: ValidationStatus
): Promise<number> {
  const client = buildClient(60000);
  try {
    const res = await client.patch<any>(`assets/${uid}/data/validation_statuses/`, {
      payload: {
        submission_ids: submissionIds.map(String),
        "validation_status.uid": status,
      },
    });
    return res.data?.successes ?? submissionIds.length;
  } catch (error) {
    handleError(error, `Failed to set validation status on form ${uid}`);
  }
}

export interface AttachmentRef {
  submissionId: string;
  uid: string;
  filename: string;
  basename: string;
  mimetype: string;
  downloadUrl: string;
}

/** Collects every attachment reference carried by a set of submissions. */
export function collectAttachments(rows: Array<Record<string, any>>): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  for (const row of rows) {
    const list = row["_attachments"];
    if (!Array.isArray(list)) continue;
    for (const att of list) {
      if (!att || att.is_deleted || !att.download_url) continue;
      refs.push({
        submissionId: String(row["_id"] ?? ""),
        uid: String(att.uid ?? ""),
        filename: String(att.filename ?? ""),
        basename: String(att.media_file_basename ?? att.filename ?? "attachment").split("/").pop()!,
        mimetype: String(att.mimetype ?? "application/octet-stream"),
        downloadUrl: String(att.download_url),
      });
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export async function createExport(
  uid: string,
  params: { format?: "xlsx" | "csv"; lang?: string }
): Promise<KoboExport> {
  const client = buildClient();
  try {
    const res = await client.post<KoboExport>(`assets/${uid}/exports/`, {
      type: params.format === "csv" ? "csv" : "xls",
      lang: params.lang ?? "_default",
      fields_from_all_versions: true,
      hierarchy_in_labels: true,
      group_sep: "/",
    });
    return res.data;
  } catch (error) {
    handleError(error, `Failed to create export for form ${uid}`);
  }
}

export async function getExport(uid: string, exportUid: string): Promise<KoboExport> {
  const client = buildClient();
  try {
    const res = await client.get<KoboExport>(`assets/${uid}/exports/${exportUid}/`);
    return res.data;
  } catch (error) {
    handleError(error, `Failed to get export status for form ${uid}`);
  }
}

/** Polls an export until it's complete (or errors/times out) and returns the download URL. */
export async function waitForExport(
  uid: string,
  exportUid: string,
  { pollIntervalMs = 2500, timeoutMs = 90000 }: { pollIntervalMs?: number; timeoutMs?: number } = {}
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const exp = await getExport(uid, exportUid);
    if (exp.status === "complete" && exp.result) return exp.result;
    if (exp.status === "error") {
      const detail = exp.messages ? JSON.stringify(exp.messages).slice(0, 300) : "no detail";
      throw new KoboApiError(`Export failed on the Kobo server for form ${uid}: ${detail}`);
    }
    await sleep(pollIntervalMs);
  }
  throw new KoboApiError(
    `Export for form ${uid} did not complete within ${Math.round(timeoutMs / 1000)}s. It may still finish — check again shortly.`
  );
}

/** Downloads a file from a Kobo URL (e.g. an export result) as a Buffer. */
export async function downloadFile(url: string): Promise<Buffer> {
  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Token ${KOBO_API_TOKEN}` },
      responseType: "arraybuffer",
      timeout: 60000,
    });
    return Buffer.from(res.data);
  } catch (error) {
    handleError(error, "Failed to download file from Kobo");
  }
}

/** Downloads an attachment to disk, returning the bytes written. */
export async function downloadAttachmentTo(ref: AttachmentRef, destination: string): Promise<number> {
  const buffer = await downloadFile(ref.downloadUrl);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, buffer);
  return buffer.length;
}

/**
 * Pulls every submission for a form by walking the paginated data endpoint.
 * Unlike listSubmissions (capped at one page), this is what analysis runs on.
 */
export async function fetchAllSubmissions(
  uid: string,
  params: { query?: string; maxRows?: number; sort?: string; allowUnbounded?: boolean } = {}
): Promise<{ rows: Array<Record<string, unknown>>; total: number; truncated: boolean }> {
  const client = buildClient();
  const ceiling = params.allowUnbounded ? Number.POSITIVE_INFINITY : MAX_FETCH_ROWS;
  const maxRows = Math.min(params.maxRows ?? MAX_FETCH_ROWS, ceiling);
  const rows: Array<Record<string, unknown>> = [];
  let total = 0;
  let start = 0;

  try {
    while (rows.length < maxRows) {
      const pageSize = Math.min(FETCH_PAGE_SIZE, maxRows - rows.length);
      const res = await client.get<any>(`assets/${uid}/data/`, {
        params: {
          start,
          limit: pageSize,
          ...(params.query ? { query: params.query } : {}),
          ...(params.sort ? { sort: params.sort } : {}),
        },
        timeout: 120000,
      });

      const body = res.data;
      const page: Array<Record<string, unknown>> = body?.results ?? (Array.isArray(body) ? body : []);
      total = typeof body?.count === "number" ? body.count : total;

      if (!page.length) break;
      rows.push(...page);
      start += page.length;

      // No count field (some deployments) — stop when a short page comes back.
      if (page.length < pageSize) break;
    }
  } catch (error) {
    handleError(error, `Failed to fetch submissions for form ${uid}`);
  }

  if (!total) total = rows.length;
  return { rows, total, truncated: rows.length < total };
}

// ---------------------------------------------------------------------------
// Submitting data
// ---------------------------------------------------------------------------

/**
 * Kobo splits its API across two hosts: the KPI host (kf.*) for assets, and the
 * KoboCAT host (kc.*) which owns the OpenRosa submission endpoint. The asset
 * itself advertises the KoboCAT origin in its download links, which is more
 * reliable than guessing from the base URL on self-hosted instances.
 */
export function kobocatOrigin(asset?: KoboAssetDetail): string {
  if (process.env.KOBO_KC_URL) return process.env.KOBO_KC_URL.replace(/\/$/, "");

  const links = (asset as any)?.deployment__data_download_links ?? {};
  for (const value of Object.values(links)) {
    if (typeof value === "string" && value.startsWith("http")) {
      try {
        return new URL(value).origin;
      } catch {
        /* keep looking */
      }
    }
  }
  // Fall back to the naming convention of the hosted servers.
  return KOBO_BASE_URL.replace("//kf.", "//kc.").replace("//eu.", "//kc-eu.");
}

function escapeXml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Turns a flat answer map into the nested XForm instance Kobo expects.
 * Keys use the submission path, so `sec_a/nom` nests `nom` inside `sec_a` —
 * the same spelling that comes back out of the data endpoint.
 */
export function buildInstanceXml(
  rootName: string,
  version: string | undefined,
  answers: Record<string, unknown>,
  instanceId: string
): string {
  type Node = { children: Map<string, Node>; value?: unknown };
  const root: Node = { children: new Map() };

  for (const [path, value] of Object.entries(answers)) {
    if (value === undefined || value === null || value === "") continue;
    let node = root;
    for (const segment of path.split("/").filter(Boolean)) {
      if (!node.children.has(segment)) node.children.set(segment, { children: new Map() });
      node = node.children.get(segment)!;
    }
    node.value = value;
  }

  const render = (node: Node): string => {
    if (!node.children.size) return escapeXml(node.value ?? "");
    let out = "";
    for (const [name, child] of node.children) {
      out += `<${name}>${render(child)}</${name}>`;
    }
    return out;
  };

  const versionAttr = version ? ` version="${escapeXml(version)}"` : "";
  return (
    `<?xml version="1.0" ?>` +
    `<${rootName} id="${escapeXml(rootName)}"${versionAttr}>` +
    render(root) +
    `<meta><instanceID>uuid:${instanceId}</instanceID></meta>` +
    `</${rootName}>`
  );
}

/**
 * Submits one response through the OpenRosa endpoint — the supported path since
 * Kobo removed its V1 JSON submission API.
 */
export async function submitData(
  uid: string,
  answers: Record<string, unknown>
): Promise<{ instanceId: string; message: string }> {
  const asset = await getAsset(uid);
  if (!(asset as any).has_deployment || !asset.deployment__active) {
    throw new KoboApiError(
      `Form ${uid} is ${asset.deployment_status} — a form must be deployed and active before it can accept submissions.`
    );
  }

  const instanceId = randomUUID();
  const xml = buildInstanceXml(uid, asset.deployed_version_id ?? asset.version_id, answers, instanceId);

  const form = new FormData();
  form.append("xml_submission_file", new Blob([xml], { type: "text/xml" }), "submission.xml");

  try {
    const res = await axios.post(`${kobocatOrigin(asset)}/submission`, form, {
      headers: { Authorization: `Token ${KOBO_API_TOKEN}` },
      timeout: 60000,
    });
    return { instanceId, message: `HTTP ${res.status} — submission accepted.` };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 400) {
      throw new KoboApiError(
        `Kobo rejected the submission. The most common cause is a field name that does not exist in the form — ` +
          `answer keys must match the submission paths shown by kobo_get_form (a question inside a group is 'group_name/question_name').`,
        400
      );
    }
    handleError(error, `Failed to submit data to form ${uid}`);
  }
}
