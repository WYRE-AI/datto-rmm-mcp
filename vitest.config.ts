import { configDefaults, defineConfig } from "vitest/config";

// Without this file vitest falls back to vite.config.ts, whose `root: "ui"`
// exists only to build the MCP Apps card bundle — tests live at the repo
// root, so pin vitest to the defaults here.
//
// dist/ must be excluded explicitly: `npm run build` compiles the
// src/__tests__ suites into dist/__tests__/*.test.js, and when tests run
// after a build (as the reusable release workflow does) vitest collects BOTH
// copies. The two s2s-guard-ordering copies then race to bind the fixed
// TEST_PORT (47006) → intermittent EADDRINUSE / ECONNRESET failures.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
});
