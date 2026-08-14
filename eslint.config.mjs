// @ts-check

import tseslint from "typescript-eslint";

// eslint-disable-next-line @typescript-eslint/no-deprecated
export default tseslint.config(
  // Global ignore patterns
  {
    ignores: [
      "node_modules/",
      "coverage/",
      ".vitest/",
      "dist/",
    ],
  },

  // Strict TypeScript config
  ...tseslint.configs.strictTypeChecked,

  // Base config for all .ts files
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── Bug prevention ──────────────────────────────────────────────

      // No `any` — ever. Use `unknown` and narrow.
      "@typescript-eslint/no-explicit-any": "error",

      // No `require()` — use ESM imports
      "@typescript-eslint/no-require-imports": "error",

      // No unsound type assertions
      "@typescript-eslint/no-non-null-assertion": "error",

      // Prevent floating promises (unhandled async rejections)
      "@typescript-eslint/no-floating-promises": "error",

      // No throw of non-Error values
      "@typescript-eslint/only-throw-error": "error",

      // Strict boolean expressions (no implicit truthiness)
      "@typescript-eslint/strict-boolean-expressions": "error",

      // Templating: allow numbers, but not other non-strings
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true, allowNever: false },
      ],

      // No unused variables or parameters (allow `_` prefix)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Require explicit `return` type on public API functions
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],

      // No promises in places not expecting them (e.g. if conditions)
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],

      // No unsafe member access / call / assignment
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // Prefer `const` when not reassigned
      "prefer-const": "error",

      // No unused expressions (e.g. standalone string literals)
      "no-unused-expressions": "error",

      // Strict equality only (allow == null for null/undefined check)
      eqeqeq: ["error", "always", { null: "never" }],

      // Warn on console.log (use pi UI notify or structured logging)
      "no-console": "warn",

      // ── Style & consistency ─────────────────────────────────────────

      // Double quotes with escape avoidance
      quotes: ["error", "double", { avoidEscape: true }],

      // Semicolons required
      semi: ["error", "always"],

      // Enforce `import type` for type-only imports
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // No await on non-Promise return values
      "@typescript-eslint/await-thenable": "error",

      // Enforce `readonly` where possible in class properties
      "@typescript-eslint/prefer-readonly": "warn",

      // Prefer `as const` over literal types
      "@typescript-eslint/prefer-as-const": "error",
    },
  },

  // ── Overrides for test files and helpers ───────────────────────────
  {
    files: ["tests/**/*.test.ts", "tests/helpers/*.ts"],
    rules: {
      // Tests may use any for mock flexibility
      "@typescript-eslint/no-explicit-any": "off",

      // Tests may use require in vi.hoisted blocks
      "@typescript-eslint/no-require-imports": "off",

      // Allow non-null assertions in tests
      "@typescript-eslint/no-non-null-assertion": "off",

      // Unsafe operations on mocks are expected
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-floating-promises": "off",

      // Allow console in tests for debugging
      "no-console": "off",

      // Tests often don't need explicit return types
      "@typescript-eslint/explicit-function-return-type": "off",

      // Allow void expression shorthand in tests
      "@typescript-eslint/no-confusing-void-expression": "off",

      // Tests use stubs that may not match strict boolean checks
      "@typescript-eslint/strict-boolean-expressions": "off",
    },
  },
);
