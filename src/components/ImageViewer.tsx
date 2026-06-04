// Lightweight raster image preview. Reads bytes through the same binary IPC path
// as PDFs and displays them through a Blob URL so large images avoid base64
// inflation. The Blob URL is revoked whenever the path changes or unmounts.

import { useEffect, useState } from "react";

import { imageMimeForPath } from "../lib/fileTypes";
import { readFileBytes } from "../lib/ipc";
import { baseName } from "../state/workspaceStore";

export function ImageViewer({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);

    (async () => {
      try {
        const bytes = await readFileBytes(path);
        const mime = imageMimeForPath(path) ?? "application/octet-stream";
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setUrl(objectUrl);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (error) {
    return (
      <div className="image-viewer">
        <div className="pdf-error">Failed to load image: {error}</div>
      </div>
    );
  }

  if (!url) {
    return <div className="pdf-message">Loading image…</div>;
  }

  return (
    <div className="image-viewer">
      <div className="image-canvas-wrap">
        <img
          className="image-preview"
          src={url}
          alt={baseName(path)}
          title={path}
          draggable={false}
        />
      </div>
    </div>
  );
}
