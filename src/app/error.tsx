"use client";

import { AlertCircle, RotateCcw } from "lucide-react";
import { useEffect } from "react";

export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-10 sm:px-6">
      <div
        role="alert"
        className="space-y-3 rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
      >
        <p className="flex items-start gap-2 font-medium">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Si è verificato un errore imprevisto nella pagina.
        </p>
        <p className="text-xs opacity-80">{error.message}</p>
        <button
          type="button"
          onClick={() => retry()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 px-2.5 py-1.5 text-xs font-medium transition hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900/40"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Riprova
        </button>
      </div>
    </main>
  );
}
