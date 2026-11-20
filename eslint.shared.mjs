// @ts-check
/**
 * Shared ESLint flat configuration for every package in the monorepo.
 *
 * One configuration for the whole workspace removes a class of drift we hit
 * repeatedly: each package carried a hand-written `eslint.config.js` that had
 * silently decayed into a two-rule stub without a TypeScript parser, so
 * `pnpm lint` was green while linting nothing but JSON-ish trivia. A single
 * exported factory means a rule change is a one-line change for all three
 * layers, and `turbo run lint` can no longer disagree with CI.
 *
 * Test code is linted too — just with the type-safety rules that exist for
 * production code relaxed, because fault-injection suites deliberately poke
 * private state and synthesise malformed frames.
 */

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/** Rules that are deliberately off for the whole workspace, with reasons. */
const sharedRelaxations = {
  // The public API is callback-driven and accepts opaque, engine-defined
  // payloads; `any` is the honest type at those boundaries.
  "@typescript-eslint/no-explicit-any": "off",
  // `tsc --noEmit` already flags genuinely unused locals, and the TS variant of
  // this rule produces false positives on declaration-merging and catch shapes.
  "@typescript-eslint/no-unused-vars": "off",
  // Third-party CJS interop (better-sqlite3, lmdb, zeromq) is required.
  "@typescript-eslint/no-require-imports": "off",
  // Empty handlers exist where an interface demands a method we intentionally
  // ignore (Noop sinks, optional lifecycle hooks).
  "@typescript-eslint/no-empty-function": "off",
  "no-empty": "off",
  // `while (true)` drives retry/accept loops.
  "no-constant-condition": ["warn", { checkLoops: false }],
  // Switch cases with lexical declarations are block-scoped on purpose.
  "no-case-declarations": "off",
  // Wire-protocol parsers legitimately match control characters.
  "no-control-regex": "off",
  // Async promise executors are used for cleanup chains.
  "no-async-promise-executor": "off",
  // Enum aliases preserve backwards compatibility.
  "@typescript-eslint/no-duplicate-enum-values": "off",
  // Simple rethrows without `cause` are intentional at adapter boundaries.
  "preserve-caught-error": "off",
};

/** Rules enforced for every package. */
const sharedStrictness = {
  "prefer-const": "error",
  "no-var": "error",
  eqeqeq: ["error", "always"],
  "no-throw-literal": "error",
  "no-new-wrappers": "error",
  "no-useless-rename": "error",
  "object-shorthand": "error",
};

/** Additional rules for tests: they may shadow, stub and log freely. */
const testRelaxations = {
  "@typescript-eslint/no-unused-expressions": "off",
  "no-console": "off",
};

/**
 * Build the ESLint configuration for a package.
 *
 * @param {object} [options]
 * @param {string} [options.tsconfigRootDir] Absolute path used to resolve
 *   `parserOptions`.
 * @returns {import('eslint').Linter.Config[]}
 */
export function createConfig(options = {}) {
  const tsconfigRootDir = options.tsconfigRootDir ?? process.cwd();

  return tseslint.config(
    {
      ignores: [
        "**/dist/**",
        "**/node_modules/**",
        "**/coverage/**",
        "**/.turbo/**",
        "**/.stryker-tmp/**",
        "**/data/**",
        "**/*.d.ts",
      ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ["**/*.ts", "**/*.mts"],
      languageOptions: {
        parserOptions: { tsconfigRootDir },
      },
      rules: { ...sharedRelaxations, ...sharedStrictness },
    },
    {
      files: [
        "**/__tests__/**/*.ts",
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/bench/**/*.ts",
      ],
      rules: testRelaxations,
    },
    {
      files: ["**/*.mjs", "**/*.js"],
      languageOptions: {
        ecmaVersion: 2023,
        sourceType: "module",
        // Node globals. Without them every `process`/`Buffer`/timer in a `.mjs`
        // harness or config file is reported as undefined — which is either noise
        // to be suppressed with a disable comment or, worse, a reason to leave the
        // file out of the lint run entirely. Enumerated rather than pulled from a
        // package so the list is visible in review.
        globals: {
          process: "readonly",
          Buffer: "readonly",
          console: "readonly",
          setTimeout: "readonly",
          clearTimeout: "readonly",
          setInterval: "readonly",
          clearInterval: "readonly",
          setImmediate: "readonly",
          URL: "readonly",
          TextEncoder: "readonly",
          TextDecoder: "readonly",
          __dirname: "readonly",
          __filename: "readonly",
        },
      },
      rules: {
        ...sharedStrictness,
        "no-console": "off",
      },
    },
    {
      files: ["**/*.ts", "**/*.mts"],
      rules: {
        // Production code logs through pino adapters, but CLI entry points and
        // benchmark harnesses legitimately write to stdout.
        "no-console": "off",
      },
    },
  );
}

export default createConfig();
