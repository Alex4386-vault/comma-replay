import { SEGMENT_SECONDS } from "@/playback/session";
import type { CanTimeline } from "@/can/canTimeline";
import { canKey, type CanTrack } from "@/can/types";

/** Per-message bit mask (one byte per payload byte); set bits are ignored. */
export type IgnoreMasks = Record<string, number[]>;

export const hex = (n: number, width = 2) => n.toString(16).toUpperCase().padStart(width, "0");
export const addrHex = (address: number) => `0x${hex(address, address > 0x7ff ? 8 : 3)}`;

/** Last index with times[i] <= t, or -1. */
export function indexAtOrBefore(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0 || times[0]! > t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** First index with times[i] >= t (may equal length). */
function lowerBound(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function frameAt(track: CanTrack, i: number): Uint8Array {
  return track.data.subarray(i * track.stride, i * track.stride + track.lens[i]!);
}

export function trackHz(track: CanTrack): number {
  const n = track.times.length;
  if (n < 2) return 0;
  const span = track.times[n - 1]! - track.times[0]!;
  return span > 0 ? (n - 1) / span : 0;
}

/**
 * Seconds since each byte last changed (counting only unmasked bits), looking
 * back at most `window` seconds from frame `idx`. Infinity = no change seen.
 */
export function byteChangeAges(
  track: CanTrack,
  idx: number,
  now: number,
  window: number,
  ignore?: number[],
): Float64Array {
  const ages = new Float64Array(track.lens[idx] ?? 0).fill(Infinity);
  if (idx <= 0) return ages;
  const { changes, times, data, stride } = track;
  let j = indexAtOrBefore(changes, idx);
  let pending = ages.length;
  for (; j >= 0 && pending > 0; j--) {
    const fi = changes[j]!;
    const age = now - times[fi]!;
    if (age > window) break;
    const a = fi * stride;
    const b = a - stride;
    for (let k = 0; k < ages.length; k++) {
      if (ages[k] !== Infinity) continue;
      if (((data[a + k]! ^ data[b + k]!) & ~(ignore?.[k] ?? 0) & 0xff) !== 0) {
        ages[k] = age;
        pending--;
      }
    }
  }
  return ages;
}

type FrameVisitor = (t: number, bytes: Uint8Array) => void;

/** Visit frames of one message within drive-time [a, b], across loaded segments. */
export function forEachFrame(
  timeline: CanTimeline,
  key: string,
  a: number,
  b: number,
  visit: FrameVisitor,
): void {
  const lo = Math.max(0, Math.floor(a / SEGMENT_SECONDS));
  const hi = Math.min(timeline.segmentCount - 1, Math.floor(b / SEGMENT_SECONDS));
  for (let s = lo; s <= hi; s++) {
    const seg = timeline.get(s);
    if (!seg) continue;
    const track = seg.tracks.find((t) => canKey(t.bus, t.address) === key);
    if (!track) continue;
    const base = s * SEGMENT_SECONDS;
    const start = lowerBound(track.times, a - base);
    for (let i = start; i < track.times.length; i++) {
      const t = base + track.times[i]!;
      if (t > b) break;
      visit(t, frameAt(track, i));
    }
  }
}

/** Message keys present in any loaded segment overlapping [a, b]. */
export function keysInRange(timeline: CanTimeline, a: number, b: number): Map<string, CanTrack> {
  const out = new Map<string, CanTrack>();
  const lo = Math.max(0, Math.floor(a / SEGMENT_SECONDS));
  const hi = Math.min(timeline.segmentCount - 1, Math.floor(b / SEGMENT_SECONDS));
  for (let s = lo; s <= hi; s++) {
    for (const t of timeline.get(s)?.tracks ?? []) {
      const k = canKey(t.bus, t.address);
      if (!out.has(k)) out.set(k, t);
    }
  }
  return out;
}

/** How often each bit flipped within [a, b]; index = byte * 8 + bit (bit 0 = LSB). */
export function bitFlipCounts(
  timeline: CanTimeline,
  key: string,
  a: number,
  b: number,
): { flips: Uint32Array; frames: number } {
  const flips = new Uint32Array(64 * 8);
  let prev: Uint8Array | null = null;
  let frames = 0;
  forEachFrame(timeline, key, a, b, (_t, bytes) => {
    frames++;
    if (prev) {
      const n = Math.min(prev.length, bytes.length);
      for (let k = 0; k < n; k++) {
        let x = prev[k]! ^ bytes[k]!;
        while (x) {
          const bit = 31 - Math.clz32(x);
          flips[k * 8 + bit]!++;
          x &= ~(1 << bit);
        }
      }
    }
    prev = bytes.slice();
  });
  return { flips, frames };
}

export type ChangeRow = {
  t: number;
  key: string;
  bus: number;
  address: number;
  prev: Uint8Array;
  next: Uint8Array;
  /** Changed bits per byte, after ignore mask. */
  diff: Uint8Array;
};

/** Payload changes (on unmasked bits) for `keys` within [a, b], time-ordered. */
export function changeLog(
  timeline: CanTimeline,
  keys: Iterable<string>,
  a: number,
  b: number,
  ignore: IgnoreMasks,
  limit = 2000,
): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const want = new Set(keys);
  const lo = Math.max(0, Math.floor(a / SEGMENT_SECONDS));
  const hi = Math.min(timeline.segmentCount - 1, Math.floor(b / SEGMENT_SECONDS));
  for (let s = lo; s <= hi; s++) {
    const seg = timeline.get(s);
    if (!seg) continue;
    const base = s * SEGMENT_SECONDS;
    for (const track of seg.tracks) {
      const key = canKey(track.bus, track.address);
      if (!want.has(key)) continue;
      const mask = ignore[key];
      const { changes, times } = track;
      for (let j = lowerBound(changes, lowerBound(times, a - base)); j < changes.length; j++) {
        const fi = changes[j]!;
        const t = base + times[fi]!;
        if (t < a) continue;
        if (t > b) break;
        const prev = frameAt(track, fi - 1);
        const next = frameAt(track, fi);
        const n = Math.max(prev.length, next.length);
        const diff = new Uint8Array(n);
        let any = prev.length !== next.length;
        for (let k = 0; k < n; k++) {
          diff[k] = ((prev[k] ?? 0) ^ (next[k] ?? 0)) & ~(mask?.[k] ?? 0) & 0xff;
          if (diff[k]) any = true;
        }
        if (!any) continue;
        rows.push({
          t,
          key,
          bus: track.bus,
          address: track.address,
          prev: prev.slice(),
          next: next.slice(),
          diff,
        });
      }
    }
  }
  rows.sort((x, y) => x.t - y.t);
  return rows.length > limit ? rows.slice(rows.length - limit) : rows;
}

/** Drive times where any tracked message changed (unmasked), for timeline ticks. */
export function changeTimes(
  timeline: CanTimeline,
  keys: Iterable<string>,
  ignore: IgnoreMasks,
  limit = 600,
): number[] {
  const out: number[] = [];
  const want = new Set(keys);
  if (want.size === 0) return out;
  for (const [s, seg] of timeline.loaded()) {
    const base = s * SEGMENT_SECONDS;
    for (const track of seg.tracks) {
      const key = canKey(track.bus, track.address);
      if (!want.has(key)) continue;
      const mask = ignore[key];
      for (const fi of track.changes) {
        const a = fi * track.stride;
        const b = a - track.stride;
        for (let k = 0; k < track.lens[fi]!; k++) {
          if (((track.data[a + k]! ^ track.data[b + k]!) & ~(mask?.[k] ?? 0) & 0xff) !== 0) {
            out.push(base + track.times[fi]!);
            break;
          }
        }
      }
    }
  }
  out.sort((x, y) => x - y);
  if (out.length <= limit) return out;
  // Thin evenly so ticks still cover the whole drive.
  const step = out.length / limit;
  return Array.from({ length: limit }, (_, i) => out[Math.floor(i * step)]!);
}

export type BitHit = {
  byte: number;
  bit: number;
  /** Value held throughout the baseline. */
  from: 0 | 1;
  /** First drive time the bit left its baseline value. */
  firstT: number;
  /** Transitions inside the action window (1 = clean state change). */
  flips: number;
};

export type FindResult = {
  key: string;
  bus: number;
  address: number;
  /** "new" = message absent in the baseline, present in the action window. */
  kind: "bits" | "new";
  hits: BitHit[];
  firstT: number;
};

/**
 * Bits that never moved during `baseline` but did during `action` — the
 * Cabana-style "what does this button do" search. Ignored bits are skipped.
 */
export function findChangedBits(
  timeline: CanTimeline,
  baseline: [number, number],
  action: [number, number],
  ignore: IgnoreMasks,
): FindResult[] {
  const results: FindResult[] = [];
  const baseKeys = keysInRange(timeline, baseline[0], baseline[1]);
  const actionKeys = keysInRange(timeline, action[0], action[1]);

  for (const [key, track] of actionKeys) {
    // Baseline: reference payload + bits that varied at all.
    let ref: Uint8Array | null = null;
    const varying = new Uint8Array(64);
    let baseLen = 64;
    if (baseKeys.has(key)) {
      forEachFrame(timeline, key, baseline[0], baseline[1], (_t, bytes) => {
        if (!ref) {
          ref = bytes.slice();
          baseLen = bytes.length;
          return;
        }
        baseLen = Math.min(baseLen, bytes.length);
        for (let k = 0; k < baseLen; k++) varying[k]! |= ref[k]! ^ bytes[k]!;
      });
    }

    let firstSeen = Infinity;
    if (!ref) {
      forEachFrame(timeline, key, action[0], action[1], (t) => {
        if (firstSeen === Infinity) firstSeen = t;
      });
      if (firstSeen !== Infinity) {
        results.push({
          key,
          bus: track.bus,
          address: track.address,
          kind: "new",
          hits: [],
          firstT: firstSeen,
        });
      }
      continue;
    }

    const refBytes: Uint8Array = ref;
    const mask = ignore[key];
    const stable = new Uint8Array(baseLen);
    for (let k = 0; k < baseLen; k++) stable[k] = ~(varying[k]! | (mask?.[k] ?? 0)) & 0xff;

    const firstT = new Float64Array(baseLen * 8).fill(Infinity);
    const flips = new Uint32Array(baseLen * 8);
    let prev: Uint8Array = refBytes;
    let any = false;
    forEachFrame(timeline, key, action[0], action[1], (t, bytes) => {
      const n = Math.min(baseLen, bytes.length);
      for (let k = 0; k < n; k++) {
        const st = stable[k]!;
        if (!st) continue;
        let moved = (prev[k]! ^ bytes[k]!) & st;
        while (moved) {
          const bit = 31 - Math.clz32(moved);
          const idx = k * 8 + bit;
          flips[idx]!++;
          if (firstT[idx] === Infinity) firstT[idx] = t;
          any = true;
          moved &= ~(1 << bit);
        }
      }
      prev = bytes.slice();
    });
    if (!any) continue;

    const hits: BitHit[] = [];
    let first = Infinity;
    for (let idx = 0; idx < flips.length; idx++) {
      if (!flips[idx]) continue;
      const byte = idx >> 3;
      const bit = idx & 7;
      hits.push({
        byte,
        bit,
        from: ((refBytes[byte]! >> bit) & 1) as 0 | 1,
        firstT: firstT[idx]!,
        flips: flips[idx]!,
      });
      first = Math.min(first, firstT[idx]!);
    }
    results.push({ key, bus: track.bus, address: track.address, kind: "bits", hits, firstT: first });
  }

  // Few, clean (single-transition) bits first: those are the likely signals.
  const score = (r: FindResult) => {
    if (r.kind === "new") return 1000;
    const clean = r.hits.filter((h) => h.flips <= 2).length;
    return (clean > 0 ? 0 : 500) + r.hits.length;
  };
  results.sort((x, y) => score(x) - score(y) || x.firstT - y.firstT);
  return results;
}

/** Bit position in DBC terms (Intel/little-endian start bit). */
export const dbcStartBit = (byte: number, bit: number) => byte * 8 + bit;

export function toCsv(rows: ChangeRow[], notes: Record<string, string>): string {
  const lines = ["time_s,bus,address,note,prev,next,changed_bits"];
  for (const r of rows) {
    const bits: string[] = [];
    r.diff.forEach((d, k) => {
      for (let bit = 7; bit >= 0; bit--) if ((d >> bit) & 1) bits.push(`B${k}.${bit}`);
    });
    const note = (notes[r.key] ?? "").replaceAll('"', '""');
    lines.push(
      [
        r.t.toFixed(3),
        r.bus,
        addrHex(r.address),
        `"${note}"`,
        [...r.prev].map((b) => hex(b)).join(" "),
        [...r.next].map((b) => hex(b)).join(" "),
        bits.join(" "),
      ].join(","),
    );
  }
  return lines.join("\n");
}
