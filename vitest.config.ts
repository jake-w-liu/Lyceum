import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vitest configuration. Kept separate from vite.config.ts so the Tauri dev
// server config stays untouched. Frontend unit/component tests run in jsdom.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // The suite lazy-imports real preview modules in several integration tests.
    // Unbounded worker fan-out can starve those transforms long enough to trip
    // Testing Library's default async-query deadline on otherwise idle code.
    // Four workers keeps CI/local runs deterministic without serializing 579+
    // tests onto one worker.
    maxWorkers: 4,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
