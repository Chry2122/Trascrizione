"use client";

import { Download, FileAudio, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorBanner } from "@/components/ErrorBanner";
import { FileDropzone } from "@/components/FileDropzone";
import {
  CLEAN_OUTPUT_FORMATS,
  type CleanOutputFormat,
  type CleanResult,
  type CleanStreamEvent,
} from "@/lib/clean-audio";
import { CLEAN_FORMATS, formatBytes, validateMediaFile } from "@/lib/media-validation";
import { createNdjsonParser } from "@/lib/ndjson-client";

// Above this size a WAV result becomes unwieldy (7 h of stereo WAV is about 4.4 GB).
const LARGE_FILE_BYTES = 200 * 1024 * 1024;

type Phase = "idle" | "uploading" | "processing";

function useObjectUrl() {
  const urlRef = useRef<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  const replace = useCallback((next: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = next;
    setUrl(next);
  }, []);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  return [url, replace] as const;
}

function discardResult(result: CleanResult | null) {
  if (result) void fetch(`/api/clean-audio/${result.id}`, { method: "DELETE" }).catch(() => undefined);
}

export function CleanAudioPanel() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [format, setFormat] = useState<CleanOutputFormat>("wav");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<CleanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [originalUrl, replaceOriginalUrl] = useObjectUrl();
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const originalAudioRef = useRef<HTMLAudioElement>(null);
  const cleanedAudioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => () => xhrRef.current?.abort(), []);

  const isBusy = phase !== "idle";

  const reset = () => {
    xhrRef.current?.abort();
    xhrRef.current = null;
    discardResult(result);
    setResult(null);
    setSelectedFile(null);
    setPhase("idle");
    setProgress(0);
    setError(null);
    replaceOriginalUrl(null);
  };

  const handleFile = (file: File) => {
    reset();
    const validationError = validateMediaFile(file, CLEAN_FORMATS);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSelectedFile(file);
    setFormat(file.size > LARGE_FILE_BYTES ? "flac" : "wav");
    replaceOriginalUrl(URL.createObjectURL(file));
  };

  const pauseOther = (other: HTMLAudioElement | null) => {
    if (other && !other.paused) other.pause();
  };

  const cleanAudio = () => {
    if (!selectedFile || isBusy) return;
    discardResult(result);
    setResult(null);
    setError(null);
    setPhase("uploading");
    setProgress(0);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    let received = 0;
    let finished = false;
    const parse = createNdjsonParser<CleanStreamEvent>((event) => {
      if (event.type === "progress") {
        setProgress(event.ratio);
      } else if (event.type === "done") {
        finished = true;
        setResult({ id: event.id, fileName: event.fileName, format: event.format, size: event.size });
      } else {
        finished = true;
        setError(event.error);
      }
    });

    const finish = () => {
      if (xhrRef.current !== xhr) return;
      xhrRef.current = null;
      setPhase("idle");
    };

    xhr.open("POST", "/api/clean-audio");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(selectedFile.name));
    xhr.setRequestHeader("x-output-format", format);
    if (selectedFile.type) xhr.setRequestHeader("content-type", selectedFile.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) setProgress(event.loaded / event.total);
    };
    xhr.upload.onload = () => {
      setPhase("processing");
      setProgress(0);
    };
    xhr.onprogress = () => {
      if (xhr.status !== 200) return;
      parse(xhr.responseText.slice(received));
      received = xhr.responseText.length;
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        parse(`${xhr.responseText.slice(received)}\n`);
        if (!finished) setError("L'elaborazione si è interrotta senza risultato. Riprova.");
      } else {
        let message = `Errore durante la pulizia dell'audio (HTTP ${xhr.status}).`;
        try {
          message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? message;
        } catch {
          // Non-JSON error page.
        }
        setError(message);
      }
      finish();
    };
    xhr.onerror = () => {
      setError("Connessione al server interrotta. Riprova più tardi.");
      finish();
    };
    xhr.onabort = finish;
    xhr.send(selectedFile);
  };

  const cancelCleaning = () => {
    xhrRef.current?.abort();
  };

  const cleanedUrl = result ? `/api/clean-audio/${result.id}` : null;

  return (
    <div className="space-y-6">
      <FileDropzone
        title="Carica il file da pulire"
        formats={CLEAN_FORMATS}
        disabled={isBusy}
        onFiles={(files) => handleFile(files[0])}
      />

      {error && <ErrorBanner message={error} />}

      {selectedFile && (
        <section className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <FileAudio className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />
              <div className="space-y-1">
                <p className="font-medium">{selectedFile.name}</p>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {formatBytes(selectedFile.size)} · Riduzione rumore di fondo e filtro voce
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 sm:shrink-0">
              {isBusy ? (
                <button
                  type="button"
                  onClick={cancelCleaning}
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  Interrompi
                </button>
              ) : (
                <button
                  type="button"
                  onClick={cleanAudio}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700"
                >
                  <Sparkles className="h-4 w-4" aria-hidden />
                  Pulisci Audio e Rimuovi Rumore
                </button>
              )}
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/40"
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
                Cancella
              </button>
            </div>
          </div>

          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Formato del file pulito</span>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as CleanOutputFormat)}
              disabled={isBusy}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950"
            >
              {CLEAN_OUTPUT_FORMATS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} — {option.hint}
                </option>
              ))}
            </select>
          </label>

          {isBusy && (
            <div
              role="status"
              className="space-y-2 rounded-xl bg-zinc-50 px-4 py-4 text-sm dark:bg-zinc-900/60"
            >
              <p className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-emerald-600" aria-hidden />
                {phase === "uploading"
                  ? `Caricamento del file… ${Math.round(progress * 100)}%`
                  : `Pulizia dell'audio in corso… ${Math.round(progress * 100)}%`}
              </p>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-[width]"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
            </div>
          )}

          <div className="grid gap-4 border-t border-zinc-200 pt-4 md:grid-cols-2 dark:border-zinc-800">
            <div className="space-y-2 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
              <p className="text-sm font-medium">Audio Originale</p>
              {originalUrl && (
                <audio
                  ref={originalAudioRef}
                  controls
                  preload="metadata"
                  src={originalUrl}
                  onPlay={() => pauseOther(cleanedAudioRef.current)}
                  className="w-full"
                >
                  Il tuo browser non supporta la riproduzione audio.
                </audio>
              )}
            </div>

            <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 dark:border-emerald-900/60 dark:bg-emerald-950/20">
              <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
                Audio Pulito Processato
              </p>
              {cleanedUrl && !isBusy ? (
                <audio
                  ref={cleanedAudioRef}
                  controls
                  preload="metadata"
                  src={cleanedUrl}
                  onPlay={() => pauseOther(originalAudioRef.current)}
                  className="w-full"
                >
                  Il tuo browser non supporta la riproduzione audio.
                </audio>
              ) : (
                <p className="flex h-[54px] items-center text-sm text-zinc-500">
                  {isBusy ? "Elaborazione in corso…" : "Avvia la pulizia per ascoltare il risultato."}
                </p>
              )}
            </div>
          </div>

          {result && cleanedUrl && !isBusy && (
            <a
              href={`${cleanedUrl}?download=1`}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              <Download className="h-4 w-4" aria-hidden />
              Scarica Audio Pulito (.{result.format}) · {formatBytes(result.size)}
            </a>
          )}
        </section>
      )}
    </div>
  );
}
