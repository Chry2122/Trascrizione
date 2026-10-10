import OpenAI, { AuthenticationError, RateLimitError } from "openai";
import { NextResponse } from "next/server";

const PLACEHOLDER_KEY = "your_openai_api_key_here";

export function createOpenAIClient(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === PLACEHOLDER_KEY) return null;
  // Never retry automatically: every OpenAI call must map to exactly one user click.
  return new OpenAI({ apiKey, maxRetries: 0 });
}

export function missingApiKeyResponse() {
  return NextResponse.json(
    {
      error:
        "OPENAI_API_KEY non configurata. Inserisci la tua chiave reale in .env.local e riavvia il server.",
    },
    { status: 500 },
  );
}

export function describeOpenAIError(error: unknown): string {
  if (error instanceof AuthenticationError) return "API key OpenAI non valida. Controlla OPENAI_API_KEY.";
  if (error instanceof RateLimitError) {
    return "Limite di richieste o credito OpenAI esaurito. Riprova più tardi.";
  }
  return error instanceof Error ? error.message : "Errore sconosciuto.";
}

export function openAIErrorResponse(error: unknown, context: string) {
  if (error instanceof AuthenticationError) {
    return NextResponse.json(
      { error: "API key OpenAI non valida. Controlla OPENAI_API_KEY." },
      { status: 401 },
    );
  }
  if (error instanceof RateLimitError) {
    return NextResponse.json(
      { error: "Limite di richieste o credito OpenAI esaurito. Riprova più tardi." },
      { status: 429 },
    );
  }
  const message = error instanceof Error ? error.message : "Errore sconosciuto.";
  return NextResponse.json({ error: `${context}: ${message}` }, { status: 502 });
}
