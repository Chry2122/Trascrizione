"use client";

import { AlertCircle, RotateCcw } from "lucide-react";
import { catchError, type ErrorInfo } from "next/error";

function PanelErrorFallback(props: { title: string }, { error, reset }: ErrorInfo) {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
    >
      <p className="flex items-start gap-2 font-medium">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        La sezione &quot;{props.title}&quot; ha avuto un errore imprevisto.
      </p>
      <p className="text-xs opacity-80">{error instanceof Error ? error.message : String(error)}</p>
      <p className="text-xs">
        Le trascrizioni già avviate continuano sul server: premi &quot;Riprova&quot; per
        ricaricare la sezione.
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 px-2.5 py-1.5 text-xs font-medium transition hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900/40"
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
        Riprova
      </button>
    </div>
  );
}

/** Keeps a crash inside one tab from blanking the whole page. */
export const PanelErrorBoundary = catchError(PanelErrorFallback);
