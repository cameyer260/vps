import esbuild from "esbuild";

/**
 * docker-modem pulls in ssh2 (with native .node bindings) at module load, but
 * the dashboard only ever talks to the Docker daemon over a unix socket —
 * never ssh. Stub ssh2 out so the server bundles down to zero runtime deps.
 */
const stubSsh2 = {
  name: "stub-ssh2",
  setup(build) {
    build.onResolve({ filter: /^ssh2$|^cpu-features$/ }, (args) => ({
      path: args.path,
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: `module.exports = {};`,
      loader: "js",
      resolveDir: ".",
    }));
  },
};

await esbuild.build({
  entryPoints: ["server/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist-server/index.js",
  plugins: [stubSsh2],
  banner: {
    // CJS deps (ws, dockerode) use dynamic require of node builtins in ESM output
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});
