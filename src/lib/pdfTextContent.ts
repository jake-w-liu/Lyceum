import type {
  getTextContentParameters,
  PDFPageProxy,
  TextContent,
} from "pdfjs-dist/types/src/display/api";

/**
 * Read a page's text stream without relying on ReadableStream async iteration,
 * which is absent in some macOS WKWebView releases supported by Lyceum.
 */
export async function readPdfTextContent(
  page: PDFPageProxy,
  params: getTextContentParameters = {},
): Promise<TextContent> {
  const stream = page.streamTextContent(
    params,
  ) as ReadableStream<TextContent>;
  const reader = stream.getReader();
  const content: TextContent = {
    items: [],
    styles: Object.create(null) as TextContent["styles"],
    lang: null,
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return content;
      if (!value) continue;
      content.lang ??= value.lang;
      Object.assign(content.styles, value.styles);
      content.items.push(...value.items);
    }
  } finally {
    reader.releaseLock();
  }
}
