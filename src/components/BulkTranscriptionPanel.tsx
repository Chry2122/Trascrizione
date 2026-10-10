"use client";

import {
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileAudio,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorBanner } from "@/components/ErrorBanner";
import { FileDropzone } from "@/components/FileDropzone";
import { SpeakerManager } from "@/components/SpeakerManager";
import { ModelBadge } from "@/components/ModelBadge";
import { baseNameOf, downloadTextFile } from "@/lib/download";
import { describeRequestError, fetchJson, HttpError } from "@/lib/fetch-json";
import { formatBytes, LONG_TRANSCRIBE_FORMATS, validateMediaFile } from "@/lib/media-validation";
import {
  ACTIVE_STATUSES,
  LANGUAGE_OPTIONS,
  type TranscriptionJob,
} from "@/lib/transcription-jobs/types";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 15_000;
const LOST_JOB_MESSAGE =
  "Il server non trova più questa trascrizione (server riavviato o istanza diversa). Caricala di nuovo.";

const secondaryButton =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs font-medium transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900";
const dangerButton =
  "inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-50 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/40";

type PendingFile = { key: string; file: File };
type Upload = { key: string; file: File; progress: number; error: string | null };
/** `lost` marks jobs this page knows about but the server no longer returns. */
type ClientJob = TranscriptionJob & { lost?: boolean };

function fileKey(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function uploadFile(
  file: File,
  options: { language: string; labelSpeakers: boolean },
  onProgress: (ratio: number) => void,
  register: (xhr: XMLHttpRequest) => void,
): Promise<TranscriptionJob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    register(xhr);
    xhr.open("POST", "/api/transcriptions");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    if (options.language) xhr.setRequestHeader("x-language", options.language);
    xhr.setRequestHeader("x-label-speakers", options.labelSpeakers ? "1" : "0");
    if (file.type) xhr.setRequestHeader("content-type", file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let data: { job?: TranscriptionJob; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // Non-JSON error page.
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.job) resolve(data.job);
      else if (data.error) reject(new Error(data.error));
      else if (xhr.status === 413) reject(new Error("Il server ha rifiutato il file perché troppo grande."));
      else if (xhr.status >= 500) reject(new Error(`Errore di connessione o timeout del server (HTTP ${xhr.status}).`));
      else reject(new Error(`Caricamento fallito (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Connessione al server interrotta durante il caricamento."));
    xhr.onabort = () => reject(new DOMException("Caricamento annullato.", "AbortError"));
    xhr.send(file);
  });
}

async function fetchJobs(): Promise<TranscriptionJob[]> {
  const data = await fetchJson<{ jobs?: TranscriptionJob[] }>(
    "/api/transcriptions",
    { cache: "no-store" },
    POLL_TIMEOUT_MS,
  );
  if (!Array.isArray(data.jobs)) throw new Error("Risposta del server non valida.");
  return data.jobs;
}

/**
 * Applies the server list without silently dropping jobs: a job the server no longer
 * returns (restart, another serverless instance) stays visible with an explanation.
 */
function mergeJobs(current: ClientJob[], latest: TranscriptionJob[], removed: Set<string>): ClientJob[] {
  const latestIds = new Set(latest.map((job) => job.id));
  const lost = current
    .filter((job) => !latestIds.has(job.id) && !removed.has(job.id))
    .map((job): ClientJob => (job.lost ? job : { ...job, status: "error", error: LOST_JOB_MESSAGE, lost: true }));
  return [...latest.filter((job) => !removed.has(job.id)), ...lost];
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

function jobProgress(job: TranscriptionJob): number {
  if (job.status === "done") return 1;
  if (job.status === "analyzing") return job.analysisProgress;
  if (job.status === "labeling") {
    return job.totalSegments > 0 ? job.labeledSegments / job.totalSegments : 0;
  }
  if (job.totalChunks > 0) return job.completedChunks / job.totalChunks;
  return 0;
}

function statusLabel(job: TranscriptionJob): string {
  switch (job.status) {
    case "queued":
      return "In coda";
    case "analyzing":
      return `Analisi delle pause… ${Math.round(job.analysisProgress * 100)}%`;
    case "transcribing":
      return `Trascrizione: blocco ${job.completedChunks} di ${job.totalChunks}`;
    case "labeling":
      return `Riconoscimento parlanti: segmento ${job.labeledSegments} di ${job.totalSegments}`;
    case "done":
      return "Completata";
    case "error":
      return "Non riuscita";
  }
}

export function BulkTranscriptionPanel() {
  const [language, setLanguage] = useState("it");
  const [labelSpeakers, setLabelSpeakers] = useState(true);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [jobs, setJobs] = useState<ClientJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const xhrRefs = useRef(new Map<string, XMLHttpRequest>());
  const uploadingRef = useRef(false);
  const removedIds = useRef(new Set<string>());

  // On failure the current list stays on screen: only the error message changes.
  const onRefreshError = useCallback((refreshError: unknown) => {
    setPollError(describeRequestError(refreshError));
  }, []);

  const applyJobs = useCallback((latest: TranscriptionJob[]) => {
    setJobs((current) => mergeJobs(current, latest, removedIds.current));
    setPollError(null);
  }, []);

  const refreshJobs = useCallback(
    () => fetchJobs().then(applyJobs, onRefreshError),
    [applyJobs, onRefreshError],
  );

  const hasActiveJobs = jobs.some((job) => ACTIVE_STATUSES.includes(job.status));
  const isUploading = uploads.some((upload) => upload.error === null);
  const [refreshing, setRefreshing] = useState(false);
  const shouldPoll = hasActiveJobs || isUploading;

  // Reads the job status from this app's server only (it never triggers OpenAI calls),
  // and only while something is in progress.
  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      fetchJobs().then(
        (latest) => {
          if (!cancelled) applyJobs(latest);
        },
        (refreshError: unknown) => {
          if (!cancelled) onRefreshError(refreshError);
        },
      );
    void tick();
    const timer = shouldPoll ? setInterval(() => void tick(), POLL_INTERVAL_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [shouldPoll, applyJobs, onRefreshError]);

  const manualRefresh = () => {
    setRefreshing(true);
    setError(null);
    void refreshJobs().finally(() => setRefreshing(false));
  };

  useEffect(() => {
    if (!isUploading) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isUploading]);

  useEffect(() => {
    const xhrs = xhrRefs.current;
    return () => xhrs.forEach((xhr) => xhr.abort());
  }, []);

  const addFiles = (files: File[]) => {
    const accepted: PendingFile[] = [];
    const errors: string[] = [];
    for (const file of files) {
      const validationError = validateMediaFile(file, LONG_TRANSCRIBE_FORMATS);
      if (validationError) errors.push(`${file.name}: ${validationError}`);
      else accepted.push({ key: fileKey(file), file });
    }
    setRejected(errors);
    setPending((current) => {
      const known = new Set(current.map((item) => item.key));
      return [...current, ...accepted.filter((item) => !known.has(item.key))];
    });
  };

  const processUploads = async (queue: Upload[]) => {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    try {
      for (const item of queue) {
        try {
          await uploadFile(
            item.file,
            { language, labelSpeakers },
            (progress) =>
              setUploads((current) =>
                current.map((upload) => (upload.key === item.key ? { ...upload, progress } : upload)),
              ),
            (xhr) => xhrRefs.current.set(item.key, xhr),
          );
          setUploads((current) => current.filter((upload) => upload.key !== item.key));
          void refreshJobs();
        } catch (uploadError: unknown) {
          const aborted = uploadError instanceof DOMException && uploadError.name === "AbortError";
          setUploads((current) =>
            aborted
              ? current.filter((upload) => upload.key !== item.key)
              : current.map((upload) =>
                  upload.key === item.key
                    ? {
                        ...upload,
                        error:
                          uploadError instanceof Error ? uploadError.message : "Caricamento fallito.",
                      }
                    : upload,
                ),
          );
        } finally {
          xhrRefs.current.delete(item.key);
        }
      }
    } finally {
      uploadingRef.current = false;
    }
  };

  const startTranscription = () => {
    if (pending.length === 0 || isUploading) return;
    const queue = pending.map(({ key, file }) => ({ key, file, progress: 0, error: null }));
    setUploads((current) => [...current.filter((upload) => upload.error === null), ...queue]);
    setPending([]);
    setRejected([]);
    setError(null);
    void processUploads(queue);
  };

  const cancelUpload = (key: string) => {
    const xhr = xhrRefs.current.get(key);
    if (xhr) xhr.abort();
    else setUploads((current) => current.filter((upload) => upload.key !== key));
  };

  const removeJob = async (job: ClientJob) => {
    const question =
      job.status === "done"
        ? `Eliminare la trascrizione di "${job.fileName}"?`
        : `Annullare la trascrizione di "${job.fileName}"? Il lavoro svolto andrà perso.`;
    if (!window.confirm(question)) return;
    setBusyJobId(job.id);
    try {
      await fetchJson(`/api/transcriptions/${job.id}`, { method: "DELETE" });
    } catch (removeError: unknown) {
      // 404: the server already forgot it, so removing it from the list is all that is left.
      if (!(removeError instanceof HttpError && removeError.status === 404)) {
        setError(describeRequestError(removeError, "Eliminazione non riuscita."));
        return;
      }
    } finally {
      setBusyJobId(null);
    }
    removedIds.current.add(job.id);
    setJobs((current) => current.filter((item) => item.id !== job.id));
    setPreviews((current) => withoutKey(current, job.id));
  };

  const retryJob = async (job: ClientJob) => {
    setBusyJobId(job.id);
    setError(null);
    try {
      await fetchJson(`/api/transcriptions/${job.id}/retry`, { method: "POST" });
      await refreshJobs();
    } catch (retryError: unknown) {
      setError(describeRequestError(retryError, "Impossibile riprovare la trascrizione."));
    } finally {
      setBusyJobId(null);
    }
  };

  const fetchTranscript = async (job: ClientJob): Promise<string> => {
    if (previews[job.id] !== undefined) return previews[job.id];
    const response = await fetch(`/api/transcriptions/${job.id}/transcript`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(
        response.status >= 500
          ? `Errore di connessione o timeout del server (HTTP ${response.status}).`
          : "Impossibile leggere la trascrizione.",
      );
    }
    return response.text();
  };

  const togglePreview = async (job: ClientJob) => {
    if (previews[job.id] !== undefined) {
      setHidden((current) => ({ ...current, [job.id]: !current[job.id] }));
      return;
    }
    setBusyJobId(job.id);
    try {
      const text = await fetchTranscript(job);
      setPreviews((current) => ({ ...current, [job.id]: text }));
    } catch (previewError: unknown) {
      setError(describeRequestError(previewError, "Anteprima non disponibile."));
    } finally {
      setBusyJobId(null);
    }
  };

  const copyTranscript = async (job: ClientJob) => {
    try {
      await navigator.clipboard.writeText(await fetchTranscript(job));
      setCopiedId(job.id);
      setTimeout(() => setCopiedId((current) => (current === job.id ? null : current)), 2000);
    } catch (copyError: unknown) {
      setError(
        copyError instanceof DOMException && copyError.name === "NotAllowedError"
          ? "Copia negli appunti non riuscita."
          : describeRequestError(copyError, "Copia negli appunti non riuscita."),
      );
    }
  };

  const pendingSize = pending.reduce((total, item) => total + item.file.size, 0);

  return (
    <div className="space-y-6">
      <FileDropzone
        title="Carica i file da trascrivere"
        formats={LONG_TRANSCRIBE_FORMATS}
        multiple
        onFiles={addFiles}
      />

      {rejected.length > 0 && <ErrorBanner message={`File scartati — ${rejected.join(" · ")}`} />}
      {error && <ErrorBanner message={error} />}
      {pollError && (
        <ErrorBanner message={`Aggiornamento dello stato non riuscito: ${pollError} Riprovo automaticamente.`} />
      )}

      {pending.length > 0 && (
        <section className="space-y-4 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5 dark:border-emerald-900/60 dark:bg-emerald-950/20">
          <div className="space-y-1">
            <p className="font-medium">
              {pending.length === 1
                ? "Vuoi trascrivere l'audio?"
                : `Vuoi trascrivere ${pending.length} file?`}
            </p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Totale {formatBytes(pendingSize)}. I file lunghi vengono divisi in blocchi sulle pause
              e trascritti in background: puoi chiudere questa scheda dopo il caricamento.
            </p>
          </div>

          <ul className="divide-y divide-emerald-200/70 rounded-xl border border-emerald-200/70 bg-white text-sm dark:divide-emerald-900/40 dark:border-emerald-900/40 dark:bg-zinc-950">
            {pending.map(({ key, file }) => (
              <li key={key} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                  <FileAudio className="h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />
                  <span className="truncate">{file.name}</span>
                  <span className="shrink-0 text-xs text-zinc-500">{formatBytes(file.size)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setPending((current) => current.filter((item) => item.key !== key))}
                  aria-label={`Rimuovi ${file.name}`}
                  className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-900"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="space-y-1 text-sm">
              <span className="block font-medium">Lingua dell&apos;audio</span>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                {LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex max-w-sm items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={labelSpeakers}
                onChange={(e) => setLabelSpeakers(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-emerald-600"
              />
              <span>
                <span className="block font-medium">Riconosci i parlanti</span>
                <span className="text-xs text-zinc-600 dark:text-zinc-400">
                  Divide il testo in interventi &quot;Voce 1:&quot;, &quot;Voce 2:&quot;… con
                  gpt-4o-mini, dedotti dal contenuto del dialogo.
                </span>
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setPending([])}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={startTranscription}
                disabled={isUploading}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Wand2 className="h-4 w-4" aria-hidden />
                Trascrivi
              </button>
            </div>
          </div>
          {isUploading && (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Attendi la fine dei caricamenti in corso prima di avviarne altri.
            </p>
          )}
        </section>
      )}

      {uploads.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Caricamento</h2>
          <ul className="space-y-2">
            {uploads.map((upload) => (
              <li
                key={upload.key}
                className="space-y-2 rounded-xl border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate font-medium">{upload.file.name}</span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-zinc-500">
                    {upload.error ? "Errore" : `${Math.round(upload.progress * 100)}%`}
                    <button
                      type="button"
                      onClick={() => cancelUpload(upload.key)}
                      aria-label={upload.error ? "Rimuovi" : "Annulla caricamento"}
                      className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </button>
                  </span>
                </div>
                {upload.error ? (
                  <p className="text-xs text-red-700 dark:text-red-300">{upload.error}</p>
                ) : (
                  <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-[width]"
                      style={{ width: `${upload.progress * 100}%` }}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Trascrizioni</h2>
          <div className="flex items-center gap-3">
            {hasActiveJobs && (
              <span className="text-xs text-zinc-500">Elaborazione in corso</span>
            )}
            <button
              type="button"
              onClick={manualRefresh}
              disabled={refreshing}
              className={secondaryButton}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
              Aggiorna stato
            </button>
          </div>
        </div>

        {jobs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            Nessuna trascrizione da mostrare. Carica uno o più file, oppure premi &quot;Aggiorna
            stato&quot; per vedere quelle già presenti.
          </p>
        ) : (
          <ul className="space-y-3">
            {jobs.map((job) => {
              const active = ACTIVE_STATUSES.includes(job.status);
              const progress = jobProgress(job);
              const busy = busyJobId === job.id;
              return (
                <li
                  key={job.id}
                  className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-0.5">
                      <p className="truncate font-medium">{job.fileName}</p>
                      <p className="text-xs text-zinc-500">
                        {formatBytes(job.size)}
                        {job.durationSec !== null && ` · ${formatDuration(job.durationSec)}`}
                        {job.totalChunks > 0 && ` · ${job.totalChunks} blocchi`}
                      </p>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                        job.status === "done"
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200"
                          : job.status === "error"
                            ? "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200"
                            : "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                      }`}
                    >
                      {active && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                      {statusLabel(job)}
                    </span>
                  </div>

                  {active && (
                    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
                        style={{ width: `${progress * 100}%` }}
                      />
                    </div>
                  )}

                  {job.status === "error" && job.error && (
                    <p className="text-sm text-red-700 dark:text-red-300">{job.error}</p>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {job.status === "done" && (
                      <>
                        {previews[job.id] !== undefined ? (
                          <button
                            type="button"
                            onClick={() =>
                              downloadTextFile(
                                previews[job.id],
                                `${baseNameOf(job.fileName, "trascrizione")}-trascrizione.txt`,
                              )
                            }
                            className={secondaryButton}
                          >
                            <Download className="h-3.5 w-3.5" aria-hidden />
                            Scarica .txt
                          </button>
                        ) : (
                          <a
                            href={`/api/transcriptions/${job.id}/transcript?download=1`}
                            className={secondaryButton}
                          >
                            <Download className="h-3.5 w-3.5" aria-hidden />
                            Scarica .txt
                          </a>
                        )}
                        <button type="button" onClick={() => void copyTranscript(job)} className={secondaryButton}>
                          {copiedId === job.id ? (
                            <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                          ) : (
                            <Copy className="h-3.5 w-3.5" aria-hidden />
                          )}
                          {copiedId === job.id ? "Copiato" : "Copia negli appunti"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void togglePreview(job)}
                          disabled={busy}
                          className={secondaryButton}
                        >
                          {busy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : previews[job.id] !== undefined && !hidden[job.id] ? (
                            <EyeOff className="h-3.5 w-3.5" aria-hidden />
                          ) : (
                            <Eye className="h-3.5 w-3.5" aria-hidden />
                          )}
                          {previews[job.id] !== undefined && !hidden[job.id]
                            ? "Nascondi testo"
                            : "Mostra testo e parlanti"}
                        </button>
                      </>
                    )}
                    {job.status === "error" && previews[job.id] !== undefined && (
                      <button
                        type="button"
                        onClick={() =>
                          downloadTextFile(
                            previews[job.id],
                            `${baseNameOf(job.fileName, "trascrizione")}-trascrizione.txt`,
                          )
                        }
                        className={secondaryButton}
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden />
                        Scarica .txt
                      </button>
                    )}
                    {job.status === "error" && !job.lost && (
                      <button
                        type="button"
                        onClick={() => void retryJob(job)}
                        disabled={busy}
                        className={secondaryButton}
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                        Riprova
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void removeJob(job)}
                      disabled={busy}
                      className={`${dangerButton} disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      {active ? <X className="h-3.5 w-3.5" aria-hidden /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />}
                      {active ? "Annulla" : "Cancella"}
                    </button>
                  </div>

                  {job.status === "done" && job.labelSpeakers && (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <ModelBadge
                        ai={job.ai}
                        emptyLabel="Parlanti non riconosciuti"
                        emptyTitle="Il modello non ha restituito un risultato utilizzabile: il testo è quello di Whisper."
                      />
                      {job.warning && (
                        <span className="text-amber-700 dark:text-amber-300">{job.warning}</span>
                      )}
                    </div>
                  )}

                  {previews[job.id] !== undefined && !hidden[job.id] && (
                    <div className="space-y-4">
                      <textarea
                        value={previews[job.id]}
                        onChange={(e) => {
                          const value = e.target.value;
                          setPreviews((current) => ({ ...current, [job.id]: value }));
                        }}
                        aria-label={`Trascrizione di ${job.fileName}`}
                        className="min-h-64 w-full resize-y rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:border-zinc-800 dark:bg-zinc-900"
                      />
                      <SpeakerManager
                        key={job.id}
                        text={previews[job.id]}
                        onTextChange={(next) =>
                          setPreviews((current) => ({ ...current, [job.id]: next }))
                        }
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
