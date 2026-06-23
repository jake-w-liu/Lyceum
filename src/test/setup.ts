// Vitest global setup. Adds jest-dom matchers (toBeInTheDocument, etc.).
import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver; components that observe element size (EditorArea,
// TerminalView) construct one on mount. A no-op stub lets them render — tests
// that need a specific size assert via other means.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
