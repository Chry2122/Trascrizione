/** Incrementally splits newline-delimited JSON text into parsed events. */
export function createNdjsonParser<E>(onEvent: (event: E) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line) as E);
    }
  };
}

export async function readNdjson<E>(response: Response, onEvent: (event: E) => void): Promise<void> {
  if (!response.body) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const parse = createNdjsonParser(onEvent);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parse(value);
  }
  parse("\n");
}
