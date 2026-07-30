import { describe, expect, it, vi } from "vitest";
import { createClipboardPasteQueue } from "./clipboardPasteQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createClipboardPasteQueue", () => {
  it("reads immediately and delivers rapid pastes in keypress order", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const readText = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const pasted: string[] = [];
    const queue = createClipboardPasteQueue({
      readText,
      paste: (text) => pasted.push(text),
      onError: vi.fn(),
    });

    const firstPaste = queue.enqueue();
    const secondPaste = queue.enqueue();
    expect(readText).toHaveBeenCalledTimes(2);

    second.resolve("second");
    await Promise.resolve();
    expect(pasted).toEqual([]);
    first.resolve("first");
    await Promise.all([firstPaste, secondPaste]);

    expect(pasted).toEqual(["first", "second"]);
  });

  it("recovers after a failed clipboard read", async () => {
    const error = new Error("clipboard unavailable");
    const onError = vi.fn();
    const paste = vi.fn();
    const queue = createClipboardPasteQueue({
      readText: vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce("recovered"),
      paste,
      onError,
    });

    await queue.enqueue();
    await queue.enqueue();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error);
    expect(paste).toHaveBeenCalledOnce();
    expect(paste).toHaveBeenCalledWith("recovered");
  });

  it("drops a pending delivery after disposal", async () => {
    const read = deferred<string>();
    const paste = vi.fn();
    const queue = createClipboardPasteQueue({
      readText: () => read.promise,
      paste,
      onError: vi.fn(),
    });

    const pending = queue.enqueue();
    queue.dispose();
    read.resolve("stale");
    await pending;
    await queue.enqueue();

    expect(paste).not.toHaveBeenCalled();
  });
});
