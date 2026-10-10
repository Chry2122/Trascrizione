"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileAudio,
  FileText,
  Loader2,
  RotateCcw,
  ScanSearch,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorBanner } from "@/components/ErrorBanner";
import { FileDropzone } from "@/components/FileDropzone";
import { ModelBadge } from "@/components/ModelBadge";
import { baseNameOf, downloadTextFile } from "@/lib/download";
import {
  formatBytes,
  MAX_TRANSCRIPT_CHARS,
  validateMediaFile,
  VERIFY_FORMATS,
} from "@/lib/media-validation";
import { readNdjson } from "@/lib/ndjson-client";
import type {
  VerifyRequestBody,
  VerifyStreamEvent,
  VerifyTranscriptResult,
} from "@/lib/transcript-verification";
import { LANGUAGE_OPTIONS } from "@/lib/transcription-jobs/types";

const MAX_LISTED_ERRORS = 200;

const secondaryButton =
  "inline-flex items-center gap-2 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900";

type Status =
  | { phase: "idle" }
  | { phase: "uploading"; ratio: number }
  | { phase: "working"; label: string; ratio: number | null };

function statusFromEvent(event: Extract<VerifyStreamEvent, { type: "progress" }>): Status {
  switch (event.stage) {
    case "analyzing":
      return { phase: "working", label: `Analisi delle pause nell'audio… ${Math.round(event.ratio * 100)}%`, ratio: event.ratio };
    case "transcribing":
      return {
        phase: "working",
        label: `Trascrizione dell'audio: blocco ${event.done} di ${event.total}`,
        ratio: event.total > 0 ? event.done / event.total : null,
      };
    case "comparing":
      return event.total <= 1
        ? { phase: "working", label: "Confronto con la trascrizione fornita…", ratio: null }
        : {
            phase: "working",
            label: `Confronto delle differenze: gruppo ${event.done} di ${event.total}`,
            ratio: event.done / event.total,
          };
  }
}

function uploadAudio(
  file: File,
  onProgress: (ratio: number) => void,
  register: (xhr: XMLHttpRequest) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    register(xhr);
    xhr.open("POST", "/api/verify-transcript/upload");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    if (file.type) xhr.setRequestHeader("content-type", file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let data: { uploadId?: string; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // Non-JSON error page.
      }
      if (xhr.status === 201 && data.uploadId) resolve(data.uploadId);
      else reject(new Error(data.error ?? `Caricamento fallito (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Connessione al server interrotta durante il caricamento."));
    xhr.onabort = () => reject(new DOMException("Caricamento annullato.", "AbortError"));
    xhr.send(file);
  });
}

function discardUpload(uploadId: string | null) {
  if (uploadId) {
    void fetch(`/api/verify-transcript/upload/${uploadId}`, { method: "DELETE" }).catch(() => undefined);
  }
}

export function VerifyTranscriptPanel() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [language, setLanguage] = useState("it");
  const [providedTranscript, setProvidedTranscript] = useState("");
  const [status, setStatus] = useState<Status>({ phase: "idle" });
  const [result, setResult] = useState<VerifyTranscriptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const textFileRef = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      xhrRef.current?.abort();
    },
    [],
  );

  const isBusy = status.phase !== "idle";

  const cancelRequest = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    xhrRef.current?.abort();
    xhrRef.current = null;
    setStatus({ phase: "idle" });
  };

  const reset = () => {
    cancelRequest();
    discardUpload(uploadId);
    setUploadId(null);
    setSelectedFile(null);
    setProvidedTranscript("");
    setResult(null);
    setError(null);
    setCopied(false);
  };

  const handleFile = (file: File) => {
    cancelRequest();
    setResult(null);
    discardUpload(uploadId);
    setUploadId(null);
    const validationError = validateMediaFile(file, VERIFY_FORMATS);
    if (validationError) {
      setSelectedFile(null);
      setError(validationError);
      return;
    }
    setError(null);
    setSelectedFile(file);
  };

  const onTranscriptChange = (value: string) => {
    setProvidedTranscript(value);
    if (result) setResult(null);
  };

  const loadTextFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    if (text.length > MAX_TRANSCRIPT_CHARS) {
      setError(
        `Il file di testo supera il limite di ${MAX_TRANSCRIPT_CHARS.toLocaleString("it-IT")} caratteri.`,
      );
      return;
    }
    setError(null);
    onTranscriptChange(text);
  };

  const verify = async () => {
    if (!selectedFile || !providedTranscript.trim() || isBusy) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setResult(null);
    setCopied(false);

    try {
      let id = uploadId;
      if (!id) {
        setStatus({ phase: "uploading", ratio: 0 });
        id = await uploadAudio(
          selectedFile,
          (ratio) => setStatus({ phase: "uploading", ratio }),
          (xhr) => (xhrRef.current = xhr),
        );
        xhrRef.current = null;
        if (controller.signal.aborted) return;
        setUploadId(id);
      }

      setStatus({ phase: "working", label: "Preparazione…", ratio: null });
      const body: VerifyRequestBody = { uploadId: id, providedTranscript, language };
      const response = await fetch("/api/verify-transcript", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (response.status === 404) setUploadId(null);
        setError(data.error ?? "Errore durante la verifica della trascrizione.");
        return;
      }

      let finished = false;
      await readNdjson<VerifyStreamEvent>(response, (event) => {
        if (event.type === "progress") {
          setStatus(statusFromEvent(event));
        } else if (event.type === "result") {
          finished = true;
          setResult(event.result);
        } else {
          finished = true;
          setError(event.error);
        }
      });
      if (!finished) setError("La verifica si è interrotta senza risultato. Riprova.");
    } catch (verifyError: unknown) {
      if (controller.signal.aborted) return;
      const aborted = verifyError instanceof DOMException && verifyError.name === "AbortError";
      if (!aborted) {
        setError(
          verifyError instanceof Error ? verifyError.message : "Impossibile contattare il server.",
        );
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setStatus({ phase: "idle" });
      }
    }
  };

  const correctedTranscript = result && !result.isCorrect ? result.correctedTranscript : "";

  const copyCorrected = async () => {
    if (!correctedTranscript) return;
    try {
      await navigator.clipboard.writeText(correctedTranscript);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copia negli appunti non riuscita.");
    }
  };

  const downloadCorrected = () => {
    if (!correctedTranscript) return;
    const baseName = baseNameOf(selectedFile?.name, "trascrizione");
    downloadTextFile(correctedTranscript, `${baseName}-trascrizione-corretta.txt`);
  };

  const canVerify = Boolean(selectedFile) && providedTranscript.trim() !== "" && !isBusy;
  const hasState = Boolean(selectedFile || providedTranscript || result || error || isBusy);
  const progressRatio =
    status.phase === "uploading" ? status.ratio : status.phase === "working" ? status.ratio : null;

  return (
    <div className="space-y-6">
      <FileDropzone
        title="Carica l'audio da verificare"
        formats={VERIFY_FORMATS}
        disabled={isBusy}
        onFiles={(files) => handleFile(files[0])}
      />

      {selectedFile && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-start gap-3">
            <FileAudio className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />
            <div>
              <p className="font-medium">{selectedFile.name}</p>
              <p className="text-zinc-600 dark:text-zinc-400">{formatBytes(selectedFile.size)}</p>
            </div>
          </div>
          <label className="flex items-center gap-2">
            <span className="font-medium">Lingua dell&apos;audio</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={isBusy}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950"
            >
              {LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="provided-transcript" className="text-sm font-medium">
            Trascrizione da verificare
          </label>
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-500">
              {providedTranscript.length.toLocaleString("it-IT")} /{" "}
              {MAX_TRANSCRIPT_CHARS.toLocaleString("it-IT")}
            </span>
            <button
              type="button"
              onClick={() => textFileRef.current?.click()}
              disabled={isBusy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs font-medium transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              <FileText className="h-3.5 w-3.5" aria-hidden />
              Carica da file .txt
            </button>
            <input
              ref={textFileRef}
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              onChange={(e) => {
                void loadTextFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        </div>
        <textarea
          id="provided-transcript"
          value={providedTranscript}
          onChange={(e) => onTranscriptChange(e.target.value)}
          maxLength={MAX_TRANSCRIPT_CHARS}
          disabled={isBusy}
          placeholder="Incolla qui la trascrizione esistente da confrontare con l'audio, oppure caricala da un file .txt."
          className="min-h-48 w-full resize-y rounded-xl border border-zinc-200 bg-white p-4 text-sm leading-relaxed shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-950"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {isBusy ? (
          <button type="button" onClick={cancelRequest} className={secondaryButton}>
            Interrompi
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void verify()}
            disabled={!canVerify}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <ScanSearch className="h-4 w-4" aria-hidden />
            Verifica Trascrizione
          </button>
        )}
        <button
          type="button"
          onClick={reset}
          disabled={!hasState}
          className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/40"
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
          Cancella
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

      {isBusy && (
        <div
          role="status"
          className="space-y-2 rounded-xl border border-zinc-200 bg-white px-4 py-4 text-sm dark:border-zinc-800 dark:bg-zinc-950"
        >
          <p className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-600" aria-hidden />
            {status.phase === "uploading"
              ? `Caricamento dell'audio… ${Math.round(status.ratio * 100)}%`
              : status.phase === "working"
                ? status.label
                : ""}
          </p>
          {progressRatio !== null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div
                className="h-full rounded-full bg-emerald-500 transition-[width]"
                style={{ width: `${progressRatio * 100}%` }}
              />
            </div>
          )}
        </div>
      )}

      {result?.isCorrect && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="flex flex-1 flex-wrap items-center justify-between gap-2">
            <p>La trascrizione è corretta! Nessun errore rilevato.</p>
            <ModelBadge ai={result.ai} />
          </div>
        </div>
      )}

      {result && !result.isCorrect && (
        <section className="space-y-4 rounded-2xl border border-amber-200 bg-amber-50/60 p-5 dark:border-amber-900/60 dark:bg-amber-950/20">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <div className="flex-1 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold text-amber-900 dark:text-amber-200">
                  Discrepanze rilevate
                  {result.errors.length > 0 && ` (${result.errors.length.toLocaleString("it-IT")})`}
                </h2>
                <ModelBadge
                  ai={result.ai}
                  emptyLabel="Nessun modello AI (controlli automatici)"
                  emptyTitle="Le differenze sono state valutate con controlli automatici, senza modelli di intelligenza artificiale."
                />
              </div>
              {result.errors.length > 0 ? (
                <>
                  <ul className="max-h-96 list-disc space-y-1 overflow-y-auto pl-5 text-sm text-amber-900 dark:text-amber-100">
                    {result.errors.slice(0, MAX_LISTED_ERRORS).map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                  {result.errors.length > MAX_LISTED_ERRORS && (
                    <p className="text-xs text-amber-800 dark:text-amber-300">
                      Mostrate le prime {MAX_LISTED_ERRORS} discrepanze: tutte le correzioni sono
                      comunque applicate nel testo qui sotto.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-amber-900 dark:text-amber-100">
                  La trascrizione non corrisponde all&apos;audio.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-3 border-t border-amber-200 pt-4 dark:border-amber-900/60">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Trascrizione corretta</h3>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void copyCorrected()} className={secondaryButton}>
                  {copied ? (
                    <Check className="h-4 w-4 text-emerald-600" aria-hidden />
                  ) : (
                    <Copy className="h-4 w-4" aria-hidden />
                  )}
                  {copied ? "Copiato" : "Copia"}
                </button>
                <button type="button" onClick={downloadCorrected} className={secondaryButton}>
                  <Download className="h-4 w-4" aria-hidden />
                  Scarica .txt
                </button>
              </div>
            </div>
            <textarea
              readOnly
              value={result.correctedTranscript}
              aria-label="Trascrizione corretta"
              className="min-h-48 w-full resize-y rounded-xl border border-zinc-200 bg-white p-4 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
        </section>
      )}
    </div>
  );
}
