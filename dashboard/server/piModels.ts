import { execFile } from "node:child_process";
import { config } from "./config.js";

/**
 * "All models" source for the model picker: the full provider catalog pi
 * knows about, far wider than an agent's configured scope
 * (get_available_models). Runs the pi CLI and caches the result — the
 * catalog only changes on pi updates / provider catalog refreshes.
 *
 * The dashboard runtime image ships the pi CLI for this (see Dockerfile);
 * when the binary is missing the route fails and the picker stays on the
 * scoped list.
 */

export interface AllModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
}

let cache: { at: number; models: AllModel[] } | null = null;
const TTL_MS = 60 * 60 * 1000;

/** Parse `pi --list-models` table rows. Columns:
 *  provider  model  context  max-out  thinking  images */
export function parseModelTable(output: string): AllModel[] {
  const models: AllModel[] = [];
  const row = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(yes|no)\s+(yes|no)\s*$/;
  for (const line of output.split("\n")) {
    if (!line.trim() || /^provider\s+model/i.test(line)) continue;
    const m = row.exec(line.trim());
    if (!m) continue;
    const [, provider, id, context, , thinking] = m;
    models.push({
      provider: provider!,
      id: id!,
      contextWindow: parseSize(context!),
      reasoning: thinking === "yes",
    });
  }
  return models;
}

function parseSize(s: string): number | undefined {
  const m = /^([\d.]+)([KMBT])?$/i.exec(s);
  if (!m) return undefined;
  const n = parseFloat(m[1]!);
  if (Number.isNaN(n)) return undefined;
  const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return Math.round(n * (m[2] ? mult[m[2].toUpperCase()] ?? 1 : 1));
}

export async function listAllModels(): Promise<AllModel[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.models;
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      config.piBin,
      ["--list-models"],
      { timeout: 90_000, maxBuffer: 16 << 20 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`pi --list-models failed: ${String(stderr || err.message).trim().slice(-300)}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
  const models = parseModelTable(output);
  if (models.length === 0) throw new Error("pi --list-models returned no models");
  cache = { at: Date.now(), models };
  return models;
}
