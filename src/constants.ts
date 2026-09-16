import dotenv from "dotenv";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

// Compiled to dist/constants.js, so the project root is one level up.
// Resolving the .env from here (rather than the working directory) keeps the
// server configurable no matter which directory the MCP client launches it from.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// quiet: dotenv otherwise prints a banner on stdout, which corrupts the
// JSON-RPC stream when the server runs over the stdio transport.
dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });

// Base URL of the Kobo server (kf.kobotoolbox.org for the global server,
// eu.kobotoolbox.org for the EU server, or a self-hosted instance).
export const KOBO_BASE_URL = (process.env.KOBO_BASE_URL || "https://kf.kobotoolbox.org").replace(/\/$/, "");

// API token: Account Settings -> Security -> API key on the Kobo server.
export const KOBO_API_TOKEN = process.env.KOBO_API_TOKEN || "";

// Optional shared secret that callers must present (as a Bearer token) to
// reach this server at all. Only relevant for the HTTP transport.
export const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY || "";

// Where generated deliverables (.xlsx / .docx / .pdf) are written on disk.
// Tilde is expanded so KOBO_OUTPUT_DIR=~/Documents/rapports works.
function resolveOutputDir(): string {
  const raw = process.env.KOBO_OUTPUT_DIR?.trim();
  if (!raw) return path.join(PROJECT_ROOT, "out");
  const expanded = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}
export const OUTPUT_DIR = resolveOutputDir();

// Python interpreter used to render reports. It must have pandas, xlsxwriter,
// python-docx and matplotlib available.
export const PYTHON_BIN = process.env.PYTHON_BIN || "python3";

// Character limit applied to formatted text responses to keep them
// manageable in the model's context window.
export const CHARACTER_LIMIT = 25000;

export const DEFAULT_PAGE_LIMIT = 30;
export const MAX_PAGE_LIMIT = 100;

// Hard ceiling on how many submissions a single fetch will pull from Kobo,
// to protect against accidentally dragging a 500k-row project into memory.
export const MAX_FETCH_ROWS = 50000;

// Page size used when paginating through the submissions endpoint.
export const FETCH_PAGE_SIZE = 2000;

// Retry policy for the Kobo API: it throttles bursts and its app servers return
// sporadic 5xx under load. Reads and throttled requests are retried; writes are
// not retried on 5xx, so a half-completed create is never duplicated.
export const RETRY_ATTEMPTS = Number(process.env.KOBO_RETRY_ATTEMPTS ?? 3);
export const RETRY_BASE_DELAY_MS = Number(process.env.KOBO_RETRY_BASE_DELAY_MS ?? 700);
