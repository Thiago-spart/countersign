import { defineConfig } from "vitest/config";

// R5: vitest 5 has no defineWorkspace; projects live in the root config.
// Each directory under packages/* and attacks is one project.
export default defineConfig({
  test: {
    projects: ["packages/*", "attacks"],
    passWithNoTests: true,
  },
});
