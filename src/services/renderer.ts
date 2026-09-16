import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { PYTHON_BIN } from "../constants.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Compiled to dist/services/renderer.js, so the script sits two levels up.
const SCRIPT_PATH = path.resolve(here, "..", "..", "scripts", "render_report.py");

export interface RenderedFile {
  format: string;
  path: string;
  size_bytes: number;
}

export interface RenderResult {
  files: RenderedFile[];
  warnings: string[];
}

export class RenderError extends Error {}

/**
 * Hands the report spec to the Python renderer (xlsxwriter/matplotlib/
 * python-docx do the things Node libraries cannot: native Excel charts and
 * real Word documents) and returns the paths it wrote.
 */
export async function renderReport(spec: Record<string, unknown>): Promise<RenderResult> {
  const specPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "kobo-report-")),
    "spec.json"
  );
  await fs.writeFile(specPath, JSON.stringify(spec), "utf-8");

  try {
    const { stdout, stderr, code } = await run(PYTHON_BIN, [SCRIPT_PATH, specPath]);

    if (code !== 0 && !stdout.trim()) {
      throw new RenderError(
        `Le moteur de rendu Python a échoué (code ${code}). ${stderr.trim().slice(-800) || "Aucun détail."}`
      );
    }

    // The script prints a single JSON object on its last non-empty line.
    const lastLine = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    let parsed: any;
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      throw new RenderError(
        `Réponse illisible du moteur de rendu. Sortie : ${stdout.trim().slice(-500)} ${stderr.trim().slice(-500)}`
      );
    }

    if (!parsed.ok) {
      throw new RenderError(`Génération impossible : ${parsed.error ?? "erreur inconnue"}`);
    }
    return { files: parsed.files ?? [], warnings: parsed.warnings ?? [] };
  } finally {
    await fs.rm(path.dirname(specPath), { recursive: true, force: true }).catch(() => {});
  }
}

function run(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        const hint =
          process.platform === "win32"
            ? `Sous Windows l'interpréteur s'appelle "python", pas "python3" : mettez PYTHON_BIN=python dans le .env, ou le chemin complet de python.exe.`
            : `Renseignez PYTHON_BIN avec le chemin complet d'un Python disposant de xlsxwriter, matplotlib et python-docx.`;
        reject(new RenderError(`Interpréteur Python introuvable ("${command}"). ${hint}`));
      } else if (err.code === "EINVAL" && process.platform === "win32") {
        // Node refuses to spawn .bat/.cmd wrappers without a shell, which is
        // what PYTHON_BIN often points at on Windows (Anaconda, py launcher).
        reject(
          new RenderError(
            `Windows refuse de lancer "${command}" directement. Faites pointer PYTHON_BIN sur le python.exe lui-même, pas sur un script .bat ou .cmd.`
          )
        );
      } else {
        reject(new RenderError(`Impossible de lancer le moteur de rendu : ${err.message}`));
      }
    });

    // Large exports and the LibreOffice PDF step can be slow; cap it anyway.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new RenderError("La génération du rapport a dépassé 10 minutes et a été interrompue."));
    }, 600000);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

/**
 * Verifies the Python side is usable, so a missing dependency is reported up
 * front instead of failing halfway through a report.
 *
 * xlsxwriter and matplotlib are imported at module level by the script and are
 * hard requirements; python-docx is imported lazily and only matters for Word
 * and PDF output, so it is reported as a limitation rather than a failure.
 */
export async function checkRenderer(): Promise<{ ok: boolean; detail: string; missing: string[] }> {
  const REQUIRED = ["xlsxwriter", "matplotlib"];
  const OPTIONAL = ["docx"];
  try {
    const { stdout, code } = await run(PYTHON_BIN, [
      "-c",
      "import json,importlib.util as u;" +
        `mods=${JSON.stringify([...REQUIRED, ...OPTIONAL])};` +
        "print(json.dumps({'missing':[m for m in mods if u.find_spec(m) is None]}))",
    ]);
    if (code !== 0) {
      return { ok: false, detail: `Python a renvoyé le code ${code}.`, missing: [...REQUIRED, ...OPTIONAL] };
    }

    const missing: string[] = JSON.parse(stdout.trim() || "{}").missing ?? [];
    const missingRequired = missing.filter((m) => REQUIRED.includes(m));
    const install = `${PYTHON_BIN} -m pip install -r requirements.txt`;

    if (missingRequired.length) {
      return {
        ok: false,
        detail: `Modules Python requis manquants : ${missingRequired.join(", ")}. Installez-les avec : ${install}`,
        missing,
      };
    }
    if (missing.length) {
      return {
        ok: true,
        detail: `Moteur de rendu prêt, mais python-docx est absent : les sorties Word et PDF échoueront. Correctif : ${install}`,
        missing,
      };
    }
    return { ok: true, detail: `Moteur de rendu prêt (${PYTHON_BIN}).`, missing: [] };
  } catch (error) {
    return { ok: false, detail: (error as Error).message, missing: [...REQUIRED, ...OPTIONAL] };
  }
}

/**
 * Asks the Python script whether it can find LibreOffice, which owns the
 * per-OS lookup. Only PDF output depends on it, so a false here is a
 * limitation to report rather than a broken install.
 */
export async function checkLibreOffice(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout, code } = await run(PYTHON_BIN, [SCRIPT_PATH, "--check-soffice"]);
    if (code !== 0) {
      return { ok: false, detail: `Vérification impossible : Python a renvoyé le code ${code}.` };
    }
    const parsed = JSON.parse(stdout.trim() || "{}");
    if (parsed.ok) {
      return { ok: true, detail: `LibreOffice trouvé (${parsed.path}) — export PDF disponible.` };
    }
    return {
      ok: false,
      detail: `introuvable : seul l'export PDF est concerné, les sorties xlsx et docx fonctionnent. Installez-le (${parsed.hint}) ou renseignez SOFFICE_BIN dans le .env avec le chemin complet du binaire.`,
    };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}
