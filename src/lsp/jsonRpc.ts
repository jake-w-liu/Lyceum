// Transport-agnostic JSON-RPC 2.0 client for the generic LSP layer (M9).

export interface JsonRpcTransport {
  send: (message: string) => void;
}

export interface RpcClient {
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  notify: (method: string, params?: unknown) => void;
  onNotification: (method: string, handler: (params: unknown) => void) => void;
  handleMessage: (raw: string) => void;
  dispose: (reason?: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface IncomingMessage {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

// Non-initialize requests are timed out so an un-answered request can't leak a
// pending entry forever. `initialize` is exempt because a cold language server
// (e.g. Julia precompiling) can legitimately take minutes; server death is
// handled separately by dispose() via the exit event.
const REQUEST_TIMEOUT_MS = 60_000;

export function createRpcClient(transport: JsonRpcTransport): RpcClient {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const handlers = new Map<string, Array<(params: unknown) => void>>();

  function settle(id: number, entry: Pending): void {
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
  }

  function request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (method !== "initialize") {
        entry.timer = setTimeout(() => {
          if (pending.delete(id)) {
            reject(new Error(`LSP request timed out: ${method}`));
          }
        }, REQUEST_TIMEOUT_MS);
      }
      pending.set(id, entry);
      transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  function notify(method: string, params?: unknown): void {
    transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  function onNotification(
    method: string,
    handler: (params: unknown) => void,
  ): void {
    const list = handlers.get(method);
    if (list) list.push(handler);
    else handlers.set(method, [handler]);
  }

  function handleMessage(raw: string): void {
    let message: IncomingMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    const hasId = message.id !== undefined && message.id !== null;

    // Server -> client *request* (has both id and method): it expects a
    // response. Dropping it (the old behavior) hangs servers that send
    // registerCapability / configuration / progress-create. Answer with a
    // neutral result so the server proceeds.
    if (hasId && typeof message.method === "string") {
      transport.send(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null }),
      );
      return;
    }

    // Response to one of our requests.
    if (hasId && typeof message.id === "number") {
      const entry = pending.get(message.id);
      if (entry) {
        settle(message.id, entry);
        if (message.error) {
          entry.reject(new Error(message.error.message ?? "RPC error"));
        } else {
          entry.resolve(message.result);
        }
      }
      return;
    }

    // Notification (method, no id).
    if (typeof message.method === "string") {
      const list = handlers.get(message.method);
      if (list) for (const handler of list) handler(message.params);
    }
  }

  function dispose(reason?: string): void {
    const error = new Error(reason ?? "disposed");
    for (const [, entry] of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  return { request, notify, onNotification, handleMessage, dispose };
}
