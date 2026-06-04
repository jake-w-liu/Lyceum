// Presentational SVG icon component. Renders a single, original line glyph
// (or a filled glyph for "run") sized by `size`, colored via currentColor.
import type { ReactNode } from "react";

export type IconName =
  | "explorer"
  | "search"
  | "source-control"
  | "run"
  | "extensions"
  | "settings"
  | "terminal"
  | "problems"
  | "output"
  | "preview"
  | "close";

function glyph(name: IconName): ReactNode {
  switch (name) {
    case "explorer":
      return <path d="M3 6.5h6l2 2h10v9.5H3z" />;
    case "search":
      return (
        <>
          <circle cx="10.5" cy="10.5" r="6" />
          <line x1="15" y1="15" x2="20" y2="20" />
        </>
      );
    case "source-control":
      return (
        <>
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="6" cy="18" r="2.5" />
          <circle cx="18" cy="9" r="2.5" />
          <path d="M6 8.5v7" />
          <path d="M18 11.5v1.5a3 3 0 0 1-3 3H8.5" />
        </>
      );
    case "run":
      return <path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none" />;
    case "extensions":
      return (
        <>
          <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
          <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" />
          <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" />
          <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" />
        </>
      );
    case "settings":
      return (
        <>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
          <circle cx="9" cy="7" r="2" />
          <circle cx="15" cy="12" r="2" />
          <circle cx="8" cy="17" r="2" />
        </>
      );
    case "terminal":
      return (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 9l3 3-3 3" />
          <line x1="12" y1="16" x2="16" y2="16" />
        </>
      );
    case "problems":
      return (
        <>
          <path d="M12 4l9 16H3z" />
          <line x1="12" y1="10" x2="12" y2="14" />
          <line x1="12" y1="17" x2="12" y2="17.01" />
        </>
      );
    case "output":
      return (
        <>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </>
      );
    case "preview":
      return (
        <>
          <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      );
    case "close":
      return (
        <>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </>
      );
  }
}

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={className}
      stroke="currentColor"
      fill="none"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {glyph(name)}
    </svg>
  );
}
