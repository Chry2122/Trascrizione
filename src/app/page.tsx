"use client";

import { AudioLines, FileCheck2, FileText } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { BulkTranscriptionPanel } from "@/components/BulkTranscriptionPanel";
import { CleanAudioPanel } from "@/components/CleanAudioPanel";
import { VerifyTranscriptPanel } from "@/components/VerifyTranscriptPanel";

const TABS = [
  {
    id: "transcription",
    label: "Trascrizione",
    description:
      "Trascrivi uno o più file audio o video con OpenAI Whisper, anche registrazioni di molte ore.",
    icon: FileText,
    Panel: BulkTranscriptionPanel,
  },
  {
    id: "clean",
    label: "Pulizia Audio",
    description: "Rimuovi il rumore di fondo e scarica l'audio pulito in formato .wav.",
    icon: AudioLines,
    Panel: CleanAudioPanel,
  },
  {
    id: "verify",
    label: "Verifica Trascrizione",
    description:
      "Confronta una trascrizione esistente con l'audio: viene corretta solo se contiene errori.",
    icon: FileCheck2,
    Panel: VerifyTranscriptPanel,
  },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>("transcription");

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = TABS.findIndex((tab) => tab.id === activeTab);
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const next = TABS[(index + offset + TABS.length) % TABS.length];
    setActiveTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="space-y-2 text-center sm:text-left">
        <p className="text-sm font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
          OpenAI Whisper · ffmpeg
        </p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Trascrizione e Pulizia Audio
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Trascrivi i tuoi file, ripulisci l&apos;audio dal rumore di fondo o verifica una
          trascrizione esistente.
        </p>
      </header>

      <div
        role="tablist"
        aria-label="Funzionalità"
        onKeyDown={onTabKeyDown}
        className="grid grid-cols-3 gap-1 rounded-xl border border-zinc-200 bg-zinc-100 p-1 dark:border-zinc-800 dark:bg-zinc-900"
      >
        {TABS.map(({ id, label, icon: Icon }) => {
          const selected = activeTab === id;
          return (
            <button
              key={id}
              id={`tab-${id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`panel-${id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveTab(id)}
              className={`inline-flex flex-col items-center justify-center gap-1 rounded-lg px-2 py-2.5 text-center text-xs font-medium transition sm:flex-row sm:gap-2 sm:px-3 sm:text-sm ${
                selected
                  ? "bg-white text-emerald-700 shadow-sm dark:bg-zinc-950 dark:text-emerald-300"
                  : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </button>
          );
        })}
      </div>

      {TABS.map(({ id, description, Panel }) => (
        <section
          key={id}
          id={`panel-${id}`}
          role="tabpanel"
          aria-labelledby={`tab-${id}`}
          hidden={activeTab !== id}
          className="space-y-4"
        >
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{description}</p>
          <Panel />
        </section>
      ))}
    </main>
  );
}
