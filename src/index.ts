import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { NextFunction, Request, Response } from "express";
import crypto from "crypto";
import { registerFormTools } from "./tools/forms.js";
import { registerSubmissionTools } from "./tools/submissions.js";
import { registerExportTools } from "./tools/exports.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerSharingTools } from "./tools/sharing.js";
import { registerDoctorTools } from "./tools/doctor.js";
import { MCP_ACCESS_KEY, KOBO_API_TOKEN, KOBO_BASE_URL } from "./constants.js";

/**
 * Requires a "Authorization: Bearer <MCP_ACCESS_KEY>" header on every
 * request when MCP_ACCESS_KEY is configured. This keeps the /mcp endpoint
 * from being usable by anyone who finds or guesses the URL — it is NOT
 * per-user identity, just a shared team secret.
 */
function checkAccessKey(req: Request, res: Response, next: NextFunction): void {
  if (!MCP_ACCESS_KEY) {
    // No key configured: server is open. Fine for local testing, not recommended
    // for anything reachable on the public internet.
    next();
    return;
  }

  const header = req.header("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  const a = Buffer.from(provided);
  const b = Buffer.from(MCP_ACCESS_KEY);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!valid) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid access key." },
      id: null,
    });
    return;
  }
  next();
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: "kobotoolbox-mcp-server",
    version: "1.0.0",
  });

  registerFormTools(server);
  registerSharingTools(server);
  registerSubmissionTools(server);
  registerExportTools(server);
  registerAnalysisTools(server);
  registerDoctorTools(server);

  return server;
}

/**
 * Startup diagnostics go to stderr: stdout carries the JSON-RPC stream and any
 * stray byte there breaks the client connection.
 */
function warnOnConfig(): void {
  if (!KOBO_API_TOKEN) {
    console.error(
      `WARNING: KOBO_API_TOKEN is not set — every Kobo call will fail. Add it to the .env file (token from ${KOBO_BASE_URL}/#/account/security). Run the kobo_doctor tool for a full check.`
    );
  }
}

async function runStdio(): Promise<void> {
  warnOnConfig();
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("KoboToolbox MCP server running on stdio");
}

async function runHTTP(): Promise<void> {
  warnOnConfig();
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "kobotoolbox-mcp-server" });
  });

  if (!MCP_ACCESS_KEY) {
    console.error(
      "WARNING: MCP_ACCESS_KEY is not set — the /mcp endpoint is open to anyone who has the URL."
    );
  }

  app.post("/mcp", checkAccessKey, async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.error(`KoboToolbox MCP server running on http://0.0.0.0:${port}/mcp`);
  });
}

// Default to stdio: the common setup is a local MCP server in Claude Code,
// writing reports straight to disk. Set TRANSPORT=http to share it over HTTP.
const transport = process.env.TRANSPORT || "stdio";
if (transport === "http") {
  runHTTP().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
} else {
  runStdio().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
