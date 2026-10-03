import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Backend-Logik läuft im Node-Kontext (kein DOM).
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
