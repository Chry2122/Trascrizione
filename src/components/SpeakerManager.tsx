"use client";

import { useId, useMemo, useState } from "react";
import { Replace, Undo2, Users } from "lucide-react";
import {
  countSpeakerTurns,
  extractSpeakerLabels,
  hasSpeakerNames,
  replaceSpeakerLabels,
} from "@/lib/speakers";

type SpeakerManagerProps = {
  text: string;
  onTextChange: (next: string) => void;
  disabled?: boolean;
};

type LastReplacement = {
  original: string;
  replaced: string;
};

export function SpeakerManager({
  text,
  onTextChange,
  disabled = false,
}: SpeakerManagerProps) {
  const baseId = useId();
  const [names, setNames] = useState<Record<string, string>>({});
  const [lastReplacement, setLastReplacement] =
    useState<LastReplacement | null>(null);

  const labels = useMemo(() => extractSpeakerLabels(text), [text]);
  const turns = useMemo(() => countSpeakerTurns(text), [text]);

  const activeNames = useMemo(() => {
    const result: Record<string, string> = {};
    for (const label of labels) result[label] = names[label] ?? "";
    return result;
  }, [labels, names]);

  const canUndo = lastReplacement !== null && lastReplacement.replaced === text;
  const canReplace = !disabled && hasSpeakerNames(activeNames);

  if (labels.length === 0 && !canUndo) return null;

  function handleReplace() {
    if (!canReplace) return;
    const replaced = replaceSpeakerLabels(text, activeNames);
    if (replaced === text) return;
    setLastReplacement({ original: text, replaced });
    onTextChange(replaced);
  }

  function handleUndo() {
    if (!canUndo || !lastReplacement) return;
    setLastReplacement(null);
    onTextChange(lastReplacement.original);
  }

  return (
    <section
      aria-labelledby={`${baseId}-title`}
      className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <Users
          className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600"
          aria-hidden
        />
        <div className="space-y-1">
          <h3
            id={`${baseId}-title`}
            className="text-base font-semibold text-zinc-900 dark:text-zinc-100"
          >
            Gestione Parlanti
          </h3>
          <p className="text-zinc-600 dark:text-zinc-400">
            {labels.length > 0
              ? "Assegna un nome a ciascuna voce rilevata e premi \u201CSostituisci\u201D per aggiornare la trascrizione. Le voci lasciate vuote restano invariate."
              : "Sostituzione completata. Puoi annullarla per ripristinare le etichette originali."}
          </p>
        </div>
      </div>

      {labels.length > 0 && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            handleReplace();
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {labels.map((label, index) => {
              const inputId = `${baseId}-speaker-${index}`;
              const count = turns[label] ?? 0;
              return (
                <div
                  key={label}
                  className="space-y-1.5 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800"
                >
                  <label
                    htmlFor={inputId}
                    className="flex items-center justify-between gap-2 font-medium text-zinc-800 dark:text-zinc-200"
                  >
                    <span>{label}</span>
                    <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
                      {count === 1 ? "1 intervento" : `${count} interventi`}
                    </span>
                  </label>
                  <input
                    id={inputId}
                    type="text"
                    value={activeNames[label]}
                    onChange={(event) => {
                      const value = event.target.value;
                      setNames((prev) => ({ ...prev, [label]: value }));
                    }}
                    placeholder="Nome del parlante"
                    disabled={disabled}
                    autoComplete="off"
                    className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={!canReplace}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Replace className="h-4 w-4" aria-hidden />
              Sostituisci
            </button>
            {canUndo && (
              <UndoButton onClick={handleUndo} disabled={disabled} />
            )}
          </div>
        </form>
      )}

      {labels.length === 0 && canUndo && (
        <div className="flex flex-wrap items-center gap-2">
          <UndoButton onClick={handleUndo} disabled={disabled} />
        </div>
      )}
    </section>
  );
}

function UndoButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
    >
      <Undo2 className="h-4 w-4" aria-hidden />
      Annulla sostituzione
    </button>
  );
}
