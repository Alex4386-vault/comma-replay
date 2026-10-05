import { FILE_NAMES } from "@/route/patterns";
import type { DataSource } from "@/source/types";
import type { RecordEntry } from "@/records";
import { SEGMENT_SECONDS } from "@/playback/session";
import { indexCanOffMain } from "@/can/canWorker";
import { emptyCanSegment, type CanSegment } from "@/can/types";

/** rlog segments are large; keep only a few indexed at once. */
const CACHE_MAX = 6;

async function findCanLog(
  source: DataSource,
  segmentDir: string,
): Promise<{ path: string; log: "rlog" | "qlog" } | null> {
  const entries = await source.list(segmentDir);
  for (const log of ["rlog", "qlog"] as const) {
    for (const name of FILE_NAMES[log]) {
      const hit = entries.find((e) => e.kind === "file" && e.name === name);
      if (hit) return { path: hit.path, log };
    }
  }
  return null;
}

/**
 * Lazily indexed CAN frames per segment. Prefers rlog: qlog only keeps a
 * sliver of `can` events, so it is a last resort.
 */
export class CanTimeline {
  private cache = new Map<number, CanSegment>();
  private inflight = new Map<number, Promise<CanSegment>>();
  private lastUse = new Map<number, number>();
  private listeners = new Set<() => void>();
  private useClock = 0;
  private pinned = new Set<number>();
  /** Bumped whenever a segment lands or is evicted. */
  version = 0;

  constructor(
    private source: DataSource,
    private record: RecordEntry,
  ) {}

  get segmentCount(): number {
    return this.record.segmentPaths.length;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(index: number): CanSegment | undefined {
    const seg = this.cache.get(index);
    if (seg) this.lastUse.set(index, ++this.useClock);
    return seg;
  }

  isLoading(index: number): boolean {
    return this.inflight.has(index);
  }

  /** Loaded segments, ascending by index. */
  loaded(): [number, CanSegment][] {
    return [...this.cache.entries()].sort((a, b) => a[0] - b[0]);
  }

  fingerprint(): string {
    for (const [, seg] of this.loaded()) if (seg.fingerprint) return seg.fingerprint;
    return "";
  }

  /** Segments that must survive eviction (current playhead, analysis ranges). */
  pin(indices: Iterable<number>): void {
    this.pinned = new Set(indices);
  }

  ensureSegment(index: number): Promise<CanSegment> {
    if (index < 0 || index >= this.segmentCount) return Promise.resolve(emptyCanSegment());
    const hit = this.get(index);
    if (hit) return Promise.resolve(hit);
    const running = this.inflight.get(index);
    if (running) return running;
    const task = this.loadSegment(index)
      .then((seg) => {
        this.cache.set(index, seg);
        this.lastUse.set(index, ++this.useClock);
        this.evict();
        return seg;
      })
      .finally(() => {
        this.inflight.delete(index);
        this.version++;
        for (const fn of this.listeners) fn();
      });
    this.inflight.set(index, task);
    this.version++;
    for (const fn of this.listeners) fn();
    return task;
  }

  /** Load every segment overlapping drive-time range [a, b]. */
  async ensureRange(a: number, b: number): Promise<void> {
    const lo = Math.max(0, Math.floor(Math.min(a, b) / SEGMENT_SECONDS));
    const hi = Math.min(this.segmentCount - 1, Math.floor(Math.max(a, b) / SEGMENT_SECONDS));
    // Sequential: each rlog is tens of MB; parallel reads just thrash memory.
    for (let i = lo; i <= hi; i++) await this.ensureSegment(i);
  }

  private evict(): void {
    while (this.cache.size > CACHE_MAX) {
      let worst = -1;
      let worstUse = Infinity;
      for (const key of this.cache.keys()) {
        if (this.pinned.has(key)) continue;
        const use = this.lastUse.get(key) ?? 0;
        if (use < worstUse) {
          worstUse = use;
          worst = key;
        }
      }
      if (worst < 0) break;
      this.cache.delete(worst);
      this.lastUse.delete(worst);
    }
  }

  private async loadSegment(index: number): Promise<CanSegment> {
    const segDir = this.record.segmentPaths[index];
    if (!segDir) return emptyCanSegment();
    const found = await findCanLog(this.source, segDir);
    if (!found) {
      console.warn("[replay:can] no rlog/qlog in", segDir);
      return emptyCanSegment();
    }
    const t0 = performance.now();
    try {
      const bytes = await this.source.read(found.path);
      const seg = await indexCanOffMain(bytes, found.log);
      console.info(
        "[replay:can]",
        found.path,
        Math.round(performance.now() - t0),
        "ms",
        seg.tracks.length,
        "msgs",
        seg.frames,
        "frames",
      );
      return seg;
    } catch (err) {
      console.error("[replay:can] index failed", found.path, err);
      return emptyCanSegment();
    }
  }
}
