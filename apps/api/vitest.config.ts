import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // One in-memory replica set is shared by the whole run and each file gets a
    // clean database, so money-path transactions are exercised for real without
    // paying the replica-set startup cost per file.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    globalSetup: ["test/global-setup.ts"],
  },
});
