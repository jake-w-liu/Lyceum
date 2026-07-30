export interface ClipboardPasteQueue {
  enqueue: () => Promise<void>;
  dispose: () => void;
}

interface ClipboardPasteQueueOptions {
  readText: () => Promise<string>;
  paste: (text: string) => void;
  onError: (error: unknown) => void;
}

type ReadOutcome =
  | { ok: true; text: string }
  | { ok: false; error: unknown };

/**
 * Read the clipboard at keypress time while delivering rapid paste requests in
 * keypress order. Clipboard IPC can resolve out of order, and reversing two
 * adjacent pastes would corrupt shell input.
 */
export function createClipboardPasteQueue({
  readText,
  paste,
  onError,
}: ClipboardPasteQueueOptions): ClipboardPasteQueue {
  let disposed = false;
  let deliveryTail = Promise.resolve();

  return {
    enqueue: () => {
      if (disposed) return Promise.resolve();

      let read: Promise<string>;
      try {
        read = readText();
      } catch (error) {
        read = Promise.reject(error);
      }
      // Attach a rejection handler immediately. A previous delivery may still
      // be pending, so waiting to `await read` could otherwise produce an
      // unhandled rejection before this request reaches the front of the queue.
      const outcome: Promise<ReadOutcome> = read.then(
        (text) => ({ ok: true, text }),
        (error) => ({ ok: false, error }),
      );

      const delivery = deliveryTail.then(async () => {
        const result = await outcome;
        if (!result.ok) throw result.error;
        if (!disposed) paste(result.text);
      });
      // Report failures but keep the tail fulfilled so one clipboard error
      // cannot permanently poison every later Cmd/Ctrl+V request.
      deliveryTail = delivery.catch(onError);
      return deliveryTail;
    },
    dispose: () => {
      disposed = true;
    },
  };
}
