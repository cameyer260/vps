/**
 * Dashboard read-only mode extension.
 *
 * Loaded into dashboard-started agent containers by `jarvis rpc` via
 * `pi -e /home/dev/.pi/agent/dashboard-readonly.ts`. Enforces read-only in the
 * harness, never in the conversation (same pattern as Claude Code plan mode /
 * opencode permissions): the model is not told to "behave read-only"; blocked
 * actions come back as tool results with a reason and it self-corrects.
 *
 * - `PI_DASHBOARD_READONLY=1` in the container env → starts read-only
 *   (notes agents are launched this way).
 * - `/read-only on|off` toggles it mid-session, same container, same
 *   conversation. The chat UI invokes it via RPC `prompt`.
 *
 * Enforcement:
 * - `edit`/`write` tools are removed from the active set (read/grep/find/ls
 *   and bash stay available).
 * - bash commands are screened against a denylist of mutating patterns
 *   (redirects, rm/mv/sed -i/tee, mutating git subcommands, ...).
 *
 * Bash screening is a policy layer, not a security boundary — the hard
 * guarantee is container isolation (single project mount, no host access).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ_WRITE_TOOLS = new Set(["edit", "write"]);

const startsReadOnly = process.env.PI_DASHBOARD_READONLY === "1";

/** Quoted segments are stripped before pattern matching. */
function stripQuoted(command: string): string {
  return command.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, " ");
}

const DENY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(rm|rmdir|unlink|shred)\b/, "deletes files"],
  [/\bmv\b/, "moves or renames files"],
  [/\btee\b/, "writes files"],
  [/\bsed\b[^|;&]*\s(--in-place|-[a-zA-Z]*i[a-zA-Z]*)\b/, "edits files in place"],
  [/\bdd\b/, "writes raw files"],
  [/\btruncate\b/, "truncates files"],
  [/\b(touch|mkdir|mkfifo|ln|install|chmod|chown|chattr)\b/, "creates or changes files"],
  [/\bcp\b|\bscp\b|\brsync\b/, "copies files"],
  [/\bfind\b[^|;&]*-delete\b/, "deletes files (find -delete)"],
  [
    /\bgit\s+(add|commit|push|pull|merge|rebase|reset|restore|checkout|switch|clean|rm|mv|stash|cherry-pick|revert|apply|am|gc|filter-branch)\b/,
    "mutates the git repository",
  ],
  [
    /\b(npm|pnpm|yarn|pip3?|apt|apt-get|brew|gem|cargo)\s+(install|remove|uninstall|add|upgrade|purge)\b/,
    "installs or removes packages",
  ],
  [/\bwget\b/, "downloads files"],
  [/\bcurl\b[^|;&]*\s(-o|--output|-O|--create-dirs|--upload-file)\b/, "downloads or uploads files"],
];

/** Returns a human-readable reason when the command looks mutating, else null. */
function mutatingReason(command: string): string | null {
  const stripped = stripQuoted(command);
  // fd duplication (2>&1) and heredoc markers are not output redirections
  const withoutFdDup = stripped.replace(/\d*>&\d+/g, " ");
  const withoutHeredoc = withoutFdDup.replace(/<<-?\s*\S+/g, " ");
  if (/>>/.test(withoutHeredoc)) return "appends to a file (redirect)";
  if (/>/.test(withoutHeredoc)) return "writes to a file (redirect)";
  for (const [pattern, reason] of DENY_PATTERNS) {
    if (pattern.test(stripped)) return reason;
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  let originalTools: string[] = [];
  let readOnly = false;

  const apply = (on: boolean) => {
    readOnly = on;
    if (on) {
      const active = pi.getActiveTools();
      pi.setActiveTools(active.filter((t) => !READ_WRITE_TOOLS.has(t)));
    } else if (originalTools.length > 0) {
      pi.setActiveTools(originalTools);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    // Action methods can't run during extension loading — capture the full
    // toolset here so /read-only off can restore it.
    if (originalTools.length === 0) originalTools = pi.getActiveTools();
    if (startsReadOnly) {
      apply(true);
      ctx.ui.notify("read-only mode is ON (/read-only off to disable)", "info");
    }
  });

  pi.on("tool_call", async (event) => {
    if (!readOnly) return;
    if (READ_WRITE_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason:
          "read-only mode is on: file editing tools are disabled. The user can turn it off with /read-only off.",
      };
    }
    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown } | undefined)?.command ?? "");
      const reason = mutatingReason(command);
      if (reason) {
        return {
          block: true,
          reason: `read-only mode: this command was blocked because it ${reason}. Do not retry it; adapt (read-only analysis only) or tell the user to run /read-only off if writing is required.`,
        };
      }
    }
  });

  pi.registerCommand("read-only", {
    description: "Toggle read-only mode (usage: /read-only on|off)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg !== "on" && arg !== "off") {
        ctx.ui.notify("usage: /read-only on|off", "warning");
        return;
      }
      apply(arg === "on");
      ctx.ui.notify(`read-only mode ${arg}`, arg === "on" ? "info" : "warning");
    },
  });
}
