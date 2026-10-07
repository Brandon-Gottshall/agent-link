// Minimal guardrails (design doc PR B8), not a style linter. Each rule guards
// a failure mode this server can hit:
//   - stdout carries the MCP stdio protocol, so a console call or a direct
//     process.stdout write in src/ corrupts the transport. Diagnostics go
//     through src/shared/log.js (stderr plus the log file).
//   - a silent catch hides failures: an empty catch block must log or carry a
//     comment saying why ignoring the error is safe (no-empty accepts a
//     comment as the block's content).
// scripts/ and tests/ are CLIs that print by design, so they get only the
// generic rules.

const genericRules = {
  "no-empty": ["error", { allowEmptyCatch: false }],
  eqeqeq: "error",
  "prefer-const": "error"
};

export default [
  {
    // dist/ is the esbuild bundle (vendored code); wf-runs/ holds WF reports.
    ignores: ["dist/", "wf-runs/"]
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error"
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module"
    }
  },
  {
    files: ["src/**/*.js"],
    rules: {
      ...genericRules,
      "no-console": "error",
      // no-restricted-properties matches one member level, so this bans
      // process.stdout itself: process.stdout.write, and also aliasing it to
      // write later.
      "no-restricted-properties": ["error", {
        object: "process",
        property: "stdout",
        message: "stdout is the MCP protocol stream. Log through src/shared/log.js."
      }]
    }
  },
  {
    // The hooks run as their own processes, and their stdout is the hook
    // protocol: the Claude hook writes exactly one JSON object there, the
    // Codex prompt hook one JSON object or nothing.
    files: ["src/claude/notify-hook.js", "src/codex/prompt-hook.js"],
    rules: {
      "no-restricted-properties": "off"
    }
  },
  {
    files: ["scripts/**/*.{js,mjs}", "tests/**/*.js", "eslint.config.js"],
    rules: genericRules
  }
];
