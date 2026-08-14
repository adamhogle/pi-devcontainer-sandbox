import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Operation tests mock spawn; never call real podman
    testTimeout: 10_000,

    // Code coverage configuration
    coverage: {
      provider: "v8",
      // Source files to cover
      include: ["extensions/dev-container-sandbox/**/*.ts"],
      // Exclude test helpers and type declaration files
      exclude: ["**/*.d.ts"],
      // Report formats
      reporter: ["text", "text-summary", "lcov", "html"],
      // Output directory for HTML/lcov reports
      reportsDirectory: "./coverage",
      // Clean coverage output before each run
      clean: true,
      // Watermarks: green above these, red below (50% of threshold)
      // No hard threshold — track improvement over time
      watermarks: {
        statements: [60, 80],
        branches: [50, 70],
        functions: [60, 80],
        lines: [60, 80],
      },
    },
  },
});
