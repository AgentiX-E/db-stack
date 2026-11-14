// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Global ignores
    ignores: [
      'dist/',
      'node_modules/',
      '**/__tests__/**',
      '**/*.test.ts',
      '*.config.*',
      'memory/',
      'test-worker.ts',
      'raft-core-worker.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // ── Strictness: defaults with targeted relaxations ────────────
      '@typescript-eslint/no-explicit-any': 'off',        // Too many legacy casts; would require major refactor
      '@typescript-eslint/no-unused-vars': 'off',       // TS compiler already flags real unused vars;
                                                          // false positives from type-only imports & catch patterns
      '@typescript-eslint/no-require-imports': 'off',     // CommonJS modules are used
      '@typescript-eslint/no-var-requires': 'off',        // Same as above
      '@typescript-eslint/ban-ts-comment': 'off',         // Allow @ts-ignore for third-party lib compat
      '@typescript-eslint/no-empty-function': 'off',      // Empty handlers exist for safety
      'no-empty': 'off',                                  // Same as above
      'no-constant-condition': ['warn', { checkLoops: false }],  // Allow `while (true)` for retry loops
      'no-case-declarations': 'off',                      // Switch cases with block scoping are fine
      'no-control-regex': 'off',                          // Allow control chars in regex (protocol parsing)
      'prefer-const': 'error',                            // Enforce const when possible
      'no-var': 'error',                                  // No var declarations
      'eqeqeq': ['error', 'always'],                      // Strict equality
      'no-throw-literal': 'error',                        // Only throw Error objects
      'no-new-wrappers': 'error',                         // No String(), Number(), Boolean() as constructors
      'no-useless-rename': 'error',                       // Clean imports
      'object-shorthand': 'error',                        // { x: x } → { x }
      // Disabled rules (intentional code patterns)
      '@typescript-eslint/no-duplicate-enum-values': 'off',  // Backward-compat enum aliases
      'no-async-promise-executor': 'off',                    // Promise executors with async are used for cleanup
      'no-useless-catch': 'off',                             // Catch wrappers for context/logging
      'preserve-caught-error': 'off',                        // Throw without cause is acceptable in simple rethrows
      'no-useless-assignment': 'off',                        // Variables assigned but only used for side effects
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      // Stricter rules for production code (tests are ignored above)
      'no-console': 'off',        // Logger is used instead of console
    },
  },
);
