// Presentational SVG icon component. Renders a single, original line glyph
// sized by `size`, colored via currentColor.
import type { ReactNode } from "react";

export type IconName =
  | "explorer"
  | "search"
  | "settings"
  | "terminal"
  | "problems"
  | "output"
  | "run"
  | "build"
  | "edit"
  | "preview"
  | "undo"
  | "redo"
  | "close"
  | "close-all"
  | "folder"
  | "folder-open"
  | "file"
  | "file-code"
  | "markdown"
  | "image"
  | "pdf"
  | "dock-right"
  | "dock-bottom"
  | "chevron-up"
  | "chevron-down";

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
    case "run":
      return <path d="M8 5v14l11-7z" />;
    case "build":
      return (
        <>
          <path d="M14 4l6 6" />
          <path d="M13 9l2-2 2 2-2 2z" />
          <path d="M4 20l8.5-8.5" />
          <path d="M7 17l2 2" />
        </>
      );
    case "edit":
      // Pencil: rename / switch back to editing.
      return (
        <>
          <path d="M5 19l1.2-4.2L15.5 5.5l3 3L9.2 17.8z" />
          <path d="M14 7l3 3" />
        </>
      );
    case "preview":
      return (
        <>
          <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      );
    case "undo":
      return (
        <>
          <path d="M9 7H4v5" />
          <path d="M4 12c2-4 6-6 10-4 3 1.5 5 4 5 8" />
        </>
      );
    case "redo":
      return (
        <>
          <path d="M15 7h5v5" />
          <path d="M20 12c-2-4-6-6-10-4-3 1.5-5 4-5 8" />
        </>
      );
    case "close":
      return (
        <>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </>
      );
    case "close-all":
      return (
        <>
          <path d="M4 4h11v11H4z" />
          <path d="M8 8h12v12H8z" />
          <line x1="11.5" y1="11.5" x2="16.5" y2="16.5" />
          <line x1="16.5" y1="11.5" x2="11.5" y2="16.5" />
        </>
      );
    case "folder":
      return <path d="M3 6.5h6l2 2h10V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />;
    case "folder-open":
      return (
        <>
          <path d="M3 6.5h6l2 2h10v2" />
          <path d="M3 8.5h18l-2.2 9.2a1 1 0 0 1-1 .8H5a1 1 0 0 1-1-1z" />
        </>
      );
    case "file":
      return (
        <>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4" />
        </>
      );
    case "file-code":
      return (
        <>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4" />
          <path d="M10.5 12l-1.8 1.8 1.8 1.8" />
          <path d="M13.5 12l1.8 1.8-1.8 1.8" />
        </>
      );
    case "markdown":
      return (
        <>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4" />
          <line x1="8.5" y1="13" x2="15.5" y2="13" />
          <line x1="8.5" y1="16" x2="13" y2="16" />
        </>
      );
    case "image":
      return (
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="8.5" cy="10" r="1.5" />
          <path d="M21 16l-5-5-8 8" />
        </>
      );
    case "pdf":
      return (
        <>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4" />
          <rect x="8.5" y="13" width="7" height="4.5" rx="1" />
        </>
      );
    case "dock-right":
      return (
        <>
          <rect x="3" y="5" width="18" height="14" rx="1.5" />
          <line x1="14" y1="5" x2="14" y2="19" />
        </>
      );
    case "dock-bottom":
      return (
        <>
          <rect x="3" y="5" width="18" height="14" rx="1.5" />
          <line x1="3" y1="14" x2="21" y2="14" />
        </>
      );
    case "chevron-up":
      return <path d="M6 14l6-6 6 6" />;
    case "chevron-down":
      return <path d="M6 10l6 6 6-6" />;
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
