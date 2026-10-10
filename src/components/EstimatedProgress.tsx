"use client";

import { useEffect, useState } from "react";

const TICK_MS = 1000;
// Before this much real progress the speed measured so far is too noisy to trust alone.
const MIN_MEASURED_PROGRESS = 0.02;
const MIN_MEASURED_SEC = 5;
const FULL_TRUST_PROGRESS = 0.15;
const MAX_DISPLAYED = 0.99;

function formatRemaining(seconds: number): string {
  if (seconds < 60) return "meno di un minuto";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `circa ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `circa ${hours} h ${rest} min` : `circa ${hours} h`;
}

/**
 * Progress bar with an estimated remaining time. Between two real updates the bar keeps
 * moving at the expected speed, but never past `progress + step`, so it only simulates the
 * part of the work that is actually in flight. Purely visual: it makes no requests.
 */
export function EstimatedProgress({
  progress,
  step = 0,
  estimateSec = null,
  label,
}: {
  /** Real completion reported by the server, 0..1. */
  progress: number;
  /** Share of the work in flight right now, which the bar may fill on its own. */
  step?: number;
  /** Expected total duration in seconds, used until the real speed can be measured. */
  estimateSec?: number | null;
  label?: string;
}) {
  const real = Math.min(1, Math.max(0, progress));
  const [now, setNow] = useState(() => Date.now());
  const [start] = useState(() => ({ at: Date.now(), progress: real }));
  const [last, setLast] = useState(() => ({ at: Date.now(), progress: real }));
  if (real !== last.progress) setLast({ at: now, progress: real });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const elapsedSec = Math.max(0, (now - start.at) / 1000);
  const gained = real - start.progress;
  const measuredRate =
    gained >= MIN_MEASURED_PROGRESS && elapsedSec >= MIN_MEASURED_SEC ? gained / elapsedSec : null;
  const estimatedRate = estimateSec && estimateSec > 0 ? 1 / estimateSec : null;
  const trust = Math.min(1, gained / FULL_TRUST_PROGRESS);
  const rate =
    measuredRate !== null && estimatedRate !== null
      ? trust * measuredRate + (1 - trust) * estimatedRate
      : (measuredRate ?? estimatedRate);

  const sinceUpdateSec = Math.max(0, (now - last.at) / 1000);
  const simulated = rate !== null ? Math.min(step * 0.9, sinceUpdateSec * rate) : 0;
  const shown = Math.min(MAX_DISPLAYED, real + simulated);
  const remainingSec = rate !== null ? (1 - shown) / rate : null;

  return (
    <div className="space-y-1.5">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown * 100)}
        aria-label={label ?? "Avanzamento"}
        className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
      >
        <div
          className="h-full rounded-full bg-emerald-500 transition-[width] duration-1000 ease-linear"
          style={{ width: `${shown * 100}%` }}
        />
      </div>
      <p className="flex justify-between gap-2 text-xs text-zinc-500">
        <span>{Math.round(shown * 100)}%</span>
        <span title="Stima basata sulla durata dell'audio e sulla velocità misurata finora">
          {remainingSec !== null
            ? `Tempo stimato rimanente: ${formatRemaining(remainingSec)}`
            : "Calcolo del tempo stimato…"}
        </span>
      </p>
    </div>
  );
}
