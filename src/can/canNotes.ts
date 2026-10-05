import { useCallback, useEffect, useState } from "react";

import type { IgnoreMasks } from "@/can/analyze";

/** Per-car reverse-engineering notes, kept across drives of the same fingerprint. */
export type CanNotes = {
  /** Message keys ("bus:address") whose changes are logged. */
  tracked: string[];
  /** Bits to ignore per message (counters, checksums, noise). */
  ignore: IgnoreMasks;
  /** Free-text label per message. */
  labels: Record<string, string>;
};

const PREFIX = "comma-replay.can.";

const empty = (): CanNotes => ({ tracked: [], ignore: {}, labels: {} });

function load(fingerprint: string): CanNotes {
  try {
    const raw = localStorage.getItem(PREFIX + (fingerprint || "unknown"));
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<CanNotes>;
    return {
      tracked: Array.isArray(parsed.tracked) ? parsed.tracked : [],
      ignore: parsed.ignore && typeof parsed.ignore === "object" ? parsed.ignore : {},
      labels: parsed.labels && typeof parsed.labels === "object" ? parsed.labels : {},
    };
  } catch {
    return empty();
  }
}

function save(fingerprint: string, notes: CanNotes) {
  try {
    localStorage.setItem(PREFIX + (fingerprint || "unknown"), JSON.stringify(notes));
  } catch {
    /* storage unavailable */
  }
}

export function useCanNotes(fingerprint: string) {
  const [notes, setNotes] = useState<CanNotes>(() => load(fingerprint));
  useEffect(() => setNotes(load(fingerprint)), [fingerprint]);

  const update = useCallback(
    (fn: (prev: CanNotes) => CanNotes) => {
      setNotes((prev) => {
        const next = fn(prev);
        save(fingerprint, next);
        return next;
      });
    },
    [fingerprint],
  );

  const toggleTracked = useCallback(
    (key: string) =>
      update((n) => ({
        ...n,
        tracked: n.tracked.includes(key) ? n.tracked.filter((k) => k !== key) : [...n.tracked, key],
      })),
    [update],
  );

  const toggleIgnoreBit = useCallback(
    (key: string, byte: number, bit: number) =>
      update((n) => {
        const mask = [...(n.ignore[key] ?? [])];
        while (mask.length <= byte) mask.push(0);
        mask[byte] = (mask[byte]! ^ (1 << bit)) & 0xff;
        return { ...n, ignore: { ...n.ignore, [key]: mask } };
      }),
    [update],
  );

  const setIgnoreMask = useCallback(
    (key: string, mask: number[]) =>
      update((n) => ({ ...n, ignore: { ...n.ignore, [key]: mask } })),
    [update],
  );

  const setLabel = useCallback(
    (key: string, label: string) =>
      update((n) => {
        const labels = { ...n.labels };
        if (label) labels[key] = label;
        else delete labels[key];
        return { ...n, labels };
      }),
    [update],
  );

  return { notes, toggleTracked, toggleIgnoreBit, setIgnoreMask, setLabel };
}
