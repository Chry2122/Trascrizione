export type StreamErrorEvent = { type: "error"; error: string };

/**
 * Runs a long task while streaming its progress as newline-delimited JSON. The task is
 * aborted as soon as the client disconnects or cancels, so no work continues unattended.
 */
export function ndjsonResponse<E extends { type: string }>(
  request: Request,
  run: (send: (event: E) => void, signal: AbortSignal) => Promise<void>,
  describeError: (error: unknown) => string,
): Response {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort);
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(sink) {
      const send = (event: E | StreamErrorEvent) => {
        if (!closed) sink.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      void run(send, controller.signal)
        .catch((error: unknown) => {
          if (!controller.signal.aborted) send({ type: "error", error: describeError(error) });
        })
        .finally(() => {
          request.signal.removeEventListener("abort", abort);
          if (!closed) {
            closed = true;
            sink.close();
          }
        });
    },
    cancel() {
      closed = true;
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
