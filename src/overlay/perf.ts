/** Overlay/runtime profiler. Numbers are for DevTools + the on-player HUD. */

export type IndexSample = {
  at: number;
  segment: number;
  path: string;
  bytes: number;
  readMs: number;
  parseMs: number;
  models: number;
  car: number;
};

type PaintSample = {
  total: number;
  stateAt: number;
  draw: number;
};

const PAINT_KEEP = 240;
const paints: PaintSample[] = [];
const indexes: IndexSample[] = [];
let frames = 0;
let longFrames = 0;
let lastFpsT = 0;
let fpsFrames = 0;
let fps = 0;
let cacheMisses = 0;
let lastSeg = -1;
let lastSegHit = true;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

export function recordCache(segment: number, hit: boolean): void {
  lastSeg = segment;
  if (!hit && lastSegHit) cacheMisses++;
  lastSegHit = hit;
}

export function recordPaint(sample: PaintSample): void {
  frames++;
  fpsFrames++;
  paints.push(sample);
  if (paints.length > PAINT_KEEP) paints.shift();
  if (sample.total > 16.7) longFrames++;

  const now = performance.now();
  if (lastFpsT === 0) lastFpsT = now;
  if (now - lastFpsT >= 1000) {
    fps = (fpsFrames * 1000) / (now - lastFpsT);
    fpsFrames = 0;
    lastFpsT = now;
  }
}

export function recordIndex(sample: IndexSample): void {
  indexes.push(sample);
  if (indexes.length > 32) indexes.shift();
  try {
    performance.measure(`replay:index:${sample.segment}`, {
      start: sample.at - sample.parseMs,
      duration: sample.parseMs,
    });
  } catch {
    /* User Timing is best-effort */
  }
}

export function hudLine(): string {
  const totals = paints.map((p) => p.total).sort((a, b) => a - b);
  const draws = paints.map((p) => p.draw).sort((a, b) => a - b);
  const last = indexes[indexes.length - 1];
  const idxBit = last
    ? `idx ${last.segment} read ${last.readMs.toFixed(0)}ms parse ${last.parseMs.toFixed(0)}ms ${(last.bytes / 1e6).toFixed(2)}MB m${last.models}`
    : "idx —";
  return [
    `${fps.toFixed(0)}fps`,
    `paint p50 ${percentile(totals, 50).toFixed(1)} p95 ${percentile(totals, 95).toFixed(1)}`,
    `draw ${percentile(draws, 95).toFixed(1)}`,
    `long ${longFrames}`,
    lastSegHit ? `seg ${lastSeg}` : `seg ${lastSeg} MISS`,
    idxBit,
  ].join(" · ");
}

export function snapshot() {
  const totals = paints.map((p) => p.total).sort((a, b) => a - b);
  return {
    frames,
    fps,
    longFrames,
    cacheMisses,
    paintP50: percentile(totals, 50),
    paintP95: percentile(totals, 95),
    indexes: indexes.slice(),
  };
}

declare global {
  interface Window {
    __replayPerf?: typeof snapshot;
  }
}

if (typeof window !== "undefined") {
  window.__replayPerf = snapshot;
}
