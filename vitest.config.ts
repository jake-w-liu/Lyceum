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
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
