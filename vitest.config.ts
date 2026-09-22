import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    // Reset times render through the local time zone; pin it so assertions are
    // stable on every machine.
    env: { TZ: "UTC" },
  },
});
