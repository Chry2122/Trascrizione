import type { Tier, TierInfo } from "@/lib/tiered-ai";

const TIER_STYLES: Record<Tier, { icon: string; label: string; className: string }> = {
  low: {
    icon: "⚡",
    label: "Tier Low",
    className:
      "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  },
  medium: {
    icon: "⚖️",
    label: "Tier Medium",
    className:
      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  },
  high: {
    icon: "🧠",
    label: "Tier High",
    className:
      "border-zinc-300 bg-zinc-100 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100",
  },
};

const baseClassName =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium";

function describe(tier: TierInfo): string {
  const lines = [`Modello: ${tier.model}`, `Affidabilità: ${tier.confidenceScore}/100`];
  if (tier.segments && tier.segments > 1) lines.push(`Segmenti elaborati: ${tier.segments}`);
  if (tier.attempts.length > 1) {
    lines.push(`Percorso: ${tier.attempts.map((attempt) => `${attempt.tier} (${attempt.model})`).join(" → ")}`);
  }
  if (tier.unclearWords.length > 0) lines.push(`Parole dubbie: ${tier.unclearWords.join(", ")}`);
  return lines.join("\n");
}

/** Shows which AI tier produced a result; `tier === null` means no LLM was needed. */
export function TierBadge({
  tier,
  emptyLabel = "Nessun LLM (corrispondenza esatta)",
  emptyTitle = "I testi coincidono: nessun modello di intelligenza artificiale è stato necessario.",
}: {
  tier: TierInfo | null | undefined;
  emptyLabel?: string;
  emptyTitle?: string;
}) {
  if (!tier) {
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

  const style = TIER_STYLES[tier.tierUsed];
  return (
    <span title={describe(tier)} className={`${baseClassName} ${style.className}`}>
      <span aria-hidden>{style.icon}</span>
      {style.label} ({tier.model})
    </span>
  );
}
