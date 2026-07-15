import { describe, expect, it, vi } from "vitest";
import type {
  PDFPageProxy,
  TextContent,
  TextItem,
} from "pdfjs-dist/types/src/display/api";

import { readPdfTextContent } from "./pdfTextContent";

describe("readPdfTextContent", () => {
  it("aggregates streamed items, styles, and the first available language", async () => {
    const chunks: TextContent[] = [
      {
        items: [textItem("first")],
        styles: {
          f1: {
            ascent: 0.8,
            descent: -0.2,
            vertical: false,
            fontFamily: "serif",
          },
        },
        lang: null,
      },
      {
        items: [textItem("second")],
        styles: {
          f2: {
            ascent: 0.75,
            descent: -0.25,
            vertical: false,
            fontFamily: "sans-serif",
          },
        },
        lang: "en",
      },
    ];
    const streamTextContent = vi.fn(
      () =>
        new ReadableStream<TextContent>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
    );
    const page = { streamTextContent } as unknown as PDFPageProxy;

    const content = await readPdfTextContent(page, {
      includeMarkedContent: true,
      disableNormalization: true,
    });

    expect(streamTextContent).toHaveBeenCalledWith({
      includeMarkedContent: true,
      disableNormalization: true,
    });
    expect(content.items.map((item) => "str" in item && item.str)).toEqual([
      "first",
      "second",
    ]);
    expect(content.styles).toEqual({
      f1: {
        ascent: 0.8,
        descent: -0.2,
        vertical: false,
        fontFamily: "serif",
      },
      f2: {
        ascent: 0.75,
        descent: -0.25,
        vertical: false,
        fontFamily: "sans-serif",
      },
    });
    expect(content.lang).toBe("en");
  });

  it("releases the reader lock when streaming fails", async () => {
    const failure = new Error("stream failed");
    const releaseLock = vi.fn();
    const page = {
      streamTextContent: () => ({
        getReader: () => ({
          read: () => Promise.reject(failure),
          releaseLock,
        }),
      }),
    } as unknown as PDFPageProxy;

    await expect(readPdfTextContent(page)).rejects.toBe(failure);
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});

function textItem(str: string): TextItem {
  return {
    str,
    dir: "ltr",
    transform: [1, 0, 0, 1, 0, 0],
    width: str.length,
    height: 1,
    fontName: "f1",
    hasEOL: false,
  };
}
