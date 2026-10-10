import type { ModelInfo } from "@/lib/ai-model";

const baseClassName =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium";

/** Shows which model produced a result; `ai === null` means no model was needed. */
export function ModelBadge({
  ai,
  emptyLabel = "Nessun modello AI (corrispondenza esatta)",
  emptyTitle = "I testi coincidono: nessun modello di intelligenza artificiale è stato necessario.",
}: {
  ai: ModelInfo | null | undefined;
  emptyLabel?: string;
  emptyTitle?: string;
}) {
  if (!ai) {
    return (
      <span
        title={emptyTitle}
        className={`${baseClassName} border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300`}
      >
        <span aria-hidden>✓</span>
        {emptyLabel}
      </span>
    );
  }

  return (
    <span
      title={`Modello: ${ai.model}\nChiamate: ${ai.calls}`}
      className={`${baseClassName} border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200`}
    >
      {ai.model}
    </span>
  );
}
