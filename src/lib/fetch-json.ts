export const CONNECTION_ERROR_MESSAGE =
  "Errore di connessione o timeout del server. Controlla la connessione e riprova.";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Turns network failures, timeouts and unexpected errors into a message for the user. */
export function describeRequestError(error: unknown, fallback = CONNECTION_ERROR_MESSAGE): string {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return CONNECTION_ERROR_MESSAGE;
  }
  // fetch() rejects with a TypeError ("Failed to fetch") when the server is unreachable.
  if (error instanceof TypeError) return CONNECTION_ERROR_MESSAGE;
  return error instanceof Error && error.message ? error.message : fallback;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * fetch() with a timeout that always resolves to the parsed JSON body or throws an Error
 * with a readable message, also when the server answers with an HTML error page.
 */
export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const response = await fetch(url, { ...init, signal });
  const data = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (!response.ok) {
    const message =
      data && typeof data.error === "string" && data.error
        ? data.error
        : response.status >= 500
          ? `${CONNECTION_ERROR_MESSAGE} (HTTP ${response.status})`
          : `Richiesta non riuscita (HTTP ${response.status}).`;
    throw new HttpError(message, response.status);
  }
  if (data === null) throw new HttpError("Risposta del server non valida.", response.status);
  return data;
}
