#!/usr/bin/env node
/**
 * Regenerate the mock-VPS fixtures under dashboard/testdata/mock/.
 *
 * Idempotent (`mkdir -p`, safe to rerun; runs on every `dev:mock` boot) and
 * regenerates EVERYTHING: absolute paths differ per machine, so fixtures are
 * generated, never hand-written. The sessions fixtures stamp the absolute
 * project dir because `listSessions` compares `header.cwd` to `projectDir()`
 * output exactly, and the start route only accepts resume paths under the
 * sessions dir ending `.jsonl`.
 *
 * Everything is local-file git (bare remote in the fixtures dir), so notes
 * commit+push works fully offline.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mockDir = path.join(dashboardDir, "testdata/mock");
const projectsDir = path.join(mockDir, "projects");
const alphaDir = path.join(projectsDir, "alpha");
const betaDir = path.join(projectsDir, "beta");
const sessionsDir = path.join(mockDir, "sessions");
const skillsDir = path.join(mockDir, "skills");
const remoteDir = path.join(mockDir, "notes-remote.git");
const notesDir = path.join(mockDir, "notes");

function sh(cmd, args, cwd) {
  execFileSync(cmd, args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
}

function git(args, cwd) {
  sh("git", args, cwd);
}

/** Local-only identity so seeding never depends on the host ~/.gitconfig. */
function stampIdentity(repoDir) {
  git(["config", "user.name", "Mock Dev"], repoDir);
  git(["config", "user.email", "mock@example.test"], repoDir);
  git(["config", "commit.gpgsign", "false"], repoDir);
}

function commitAll(repoDir, message) {
  git(["add", "-A"], repoDir);
  git(
    ["-c", "user.name=Mock Dev", "-c", "user.email=mock@example.test", "-c", "commit.gpgsign=false",
      "commit", "-m", message],
    repoDir,
  );
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeBin(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(bytes));
}

// Minimal PNG header bytes (binary fixture for the IDE "not shown" path).
const PIXEL_PNG = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0xff, 0xd8, 0x00, 0x10, 0x4a, 0x46,
];

// ---- clean rebuild (idempotent: rerunning leaves a working state) ------------

fs.rmSync(mockDir, { recursive: true, force: true });
for (const d of [alphaDir, betaDir, sessionsDir, skillsDir, notesDir]) {
  fs.mkdirSync(d, { recursive: true });
}

// ---- projects/alpha (plain dir) ----------------------------------------------

write(
  path.join(alphaDir, "README.md"),
  "# Mock Alpha\n\nPlain fixture project for offline dashboard testing.\n",
);
// IDE backend fixtures: nested code/text dirs, an extensionless Dockerfile,
// a dotfile (.gitignore — shown in the tree, not hidden), a binary (refused
// with the `binary: true` signal), and an oversize log (reads refuse it with
// 413; search skips it).
write(path.join(alphaDir, "src/app.js"), "console.log(\"alpha app\");\n");
write(
  path.join(alphaDir, "src/lib/helpers.py"),
  "def hello():\n    return \"alpha\"\n",
);
write(
  path.join(alphaDir, "docs/guide.md"),
  "# Alpha Guide\n\nMock nested markdown for the IDE file tree.\n",
);
write(
  path.join(alphaDir, "Dockerfile"),
  "FROM node:22-slim\nWORKDIR /app\nCMD [\"node\", \"src/app.js\"]\n",
);
write(path.join(alphaDir, ".gitignore"), "node_modules/\n*.log\n");
writeBin(path.join(alphaDir, "assets/pixel.png"), PIXEL_PNG);
write(path.join(alphaDir, "big.log"), "x".repeat((2 << 20) + 512 * 1024));

// ---- projects/beta (git repo with one dirty file + one ignored dir) ----------------------------

git(["init", "-b", "main"], betaDir);
stampIdentity(betaDir);
write(path.join(betaDir, "app.js"), "console.log(\"mock beta\");\n");
write(path.join(betaDir, "README.md"), "# Mock Beta\n\nGit fixture project for offline dashboard testing.\n");
write(
  path.join(betaDir, "src/main.go"),
  "package main\n\nfunc main() {}\n",
);
write(path.join(betaDir, "src/nested/deep.json"), '{\n  "depth": "nested"\n}\n');
// Ignored fixture: committed .gitignore keeps dist/ untracked, so the tree
// marks it `ignored` (greyed out) instead of hiding it.
write(path.join(betaDir, ".gitignore"), "dist/\n*.local\n");
write(path.join(betaDir, "dist/bundle.js"), "console.log(\"mock ignored bundle\");\n");
writeBin(path.join(betaDir, "assets/icon.png"), PIXEL_PNG);
commitAll(betaDir, "seed mock beta");
// Leave one unstaged modification: the git-status UI shows a dirty tree.
fs.appendFileSync(path.join(betaDir, "app.js"), "console.log(\"uncommitted change\");\n");

// ---- notes (clone of a local bare remote) -------------------------------------

git(["init", "--bare", remoteDir], mockDir);
git(["init", "-b", "main"], notesDir);
stampIdentity(notesDir);
git(["remote", "add", "origin", remoteDir], notesDir);
write(path.join(notesDir, "welcome.md"), "# Welcome\n\nMock notes vault for offline dashboard testing.\n");
write(path.join(notesDir, "ideas.md"), "# Ideas\n\n- stream tokens one by one\n- rename agents\n");
write(path.join(notesDir, "todo.md"), "# Todo\n\n- [ ] verify mock harness\n");
write(path.join(notesDir, "scores.csv"), "name,score\nada,10\ngrace,9\n");
commitAll(notesDir, "seed mock notes");
git(["push", "-u", "origin", "main"], notesDir);

// ---- sessions (header cwd must equal the absolute fixture project dir) --------

function sessionSubdir(cwd) {
  return `--${cwd.replace(/\//g, "-")}--`;
}

function writeSession(cwd, fileBase, headerId, name, turns) {
  const lines = [
    JSON.stringify({ type: "session", id: headerId, cwd, timestamp: new Date().toISOString() }),
    JSON.stringify({ type: "session_info", name }),
  ];
  for (const [id, role, text] of turns) {
    const content =
      role === "assistant" ? [{ type: "text", text }] : text;
    lines.push(JSON.stringify({ type: "message", id, message: { role, content } }));
  }
  const subdir = path.join(sessionsDir, sessionSubdir(cwd));
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(subdir, fileBase), lines.join("\n") + "\n");
}

writeSession(alphaDir, "20260909T000000_sess-alpha-1.jsonl", "sess-alpha-1", "alpha kickoff", [
  ["hist-a1", "user", "Where should I start in this repo?"],
  ["hist-a2", "assistant", "Start with README.md — this is the mock Alpha project."],
]);

writeSession(betaDir, "20260909T000000_sess-beta-1.jsonl", "sess-beta-1", "beta exploration", [
  ["hist-b1", "user", "What is dirty in the tree?"],
  ["hist-b2", "assistant", "app.js has uncommitted changes (mock fixture)."],
]);

// Notes sessions back the GC conversation list's Past section (same session
// source the modal resumes through — phase 7). Header cwd must equal the
// absolute notes fixture dir, like the project sessions above.
writeSession(notesDir, "20260908T000000_sess-notes-1.jsonl", "sess-notes-1", "grocery ideas", [
  ["hist-n1", "user", "What should I cook this week?"],
  ["hist-n2", "assistant", "Pasta on Monday, tacos on Thursday (mock fixture)."],
]);

writeSession(notesDir, "20260909T000000_sess-notes-2.jsonl", "sess-notes-2", "book notes", [
  ["hist-n3", "user", "Remind me what I thought of Dune."],
  ["hist-n4", "assistant", "You liked the worldbuilding, not the pacing (mock fixture)."],
]);

// ---- skills --------------------------------------------------------------------

write(
  path.join(skillsDir, "mock-search", "SKILL.md"),
  `---\nname: mock-search\ndescription: Mock web-search skill for offline dashboard testing\n---\n\n# mock-search\n\nPretends to search the web. Fixture only.\n`,
);
write(
  path.join(skillsDir, "mock-notes", "SKILL.md"),
  `---\nname: mock-notes\ndescription: Mock notes helper skill for offline dashboard testing\n---\n\n# mock-notes\n\nPretends to help with notes. Fixture only.\n`,
);

// ---- models.json ---------------------------------------------------------------

write(
  path.join(mockDir, "models.json"),
  JSON.stringify(
    [
      { provider: "openrouter", id: "mock-sonnet", name: "Mock Sonnet", contextWindow: 200000 },
      { provider: "openrouter", id: "mock-haiku", name: "Mock Haiku", contextWindow: 100000 },
      { provider: "openrouter", id: "mock-opus", name: "Mock Opus", contextWindow: 200000 },
    ],
    null,
    2,
  ) + "\n",
);

// ---- scenarios.json --------------------------------------------------------------

const history = (userId, userText, asstId, asstText) => [
  { type: "message", id: userId, message: { role: "user", content: userText } },
  {
    type: "message",
    id: asstId,
    message: { role: "assistant", content: [{ type: "text", text: asstText }] },
  },
];

const scenarios = {
  "sidebar-full": {
    defaultGranularity: "word",
    agents: [
      {
        project: "alpha",
        name: "alpha chat",
        origin: "dashboard",
        granularity: "word",
        history: history(
          "hist-s1",
          "What is this project?",
          "hist-s2",
          "This is the mock Alpha project for offline dashboard testing.",
        ),
      },
      { project: "alpha", name: "alpha side quest", readOnly: true },
      { project: "beta", name: "beta chat", origin: "dashboard" },
    ],
  },
  "chat-streaming": {
    defaultGranularity: "char",
    agents: [
      {
        project: "alpha",
        name: "stream test",
        origin: "dashboard",
        granularity: "char",
        history: history(
          "hist-c1",
          "Hello, stream test",
          "hist-c2",
          "History is preloaded — new prompts stream char by char.",
        ),
      },
    ],
  },
  "notes-editor": {
    defaultGranularity: "word",
    agents: [{ project: "notes", name: "notes chat", origin: "dashboard" }],
  },
  // General Chat frontend (phase 7): a read-only notes agent with preloaded
  // history (toggle starts ON via the GC spawn default) plus the seeded
  // notes sessions above for the Past section.
  "gc-chat": {
    defaultGranularity: "word",
    agents: [
      {
        project: "notes",
        name: "gc chat",
        origin: "dashboard",
        readOnly: true,
        generalChat: true,
        granularity: "word",
        history: history(
          "hist-g1",
          "What is in my notes?",
          "hist-g2",
          "Welcome, ideas, and todo — this is the mock notes vault.",
        ),
      },
    ],
  },
  empty: { defaultGranularity: "word", agents: [] },
};

write(path.join(mockDir, "scenarios.json"), JSON.stringify(scenarios, null, 2) + "\n");

console.log(`mock-seed: fixtures regenerated at ${mockDir}`);
console.log(`mock-seed: scenarios: ${Object.keys(scenarios).join(", ")}`);
