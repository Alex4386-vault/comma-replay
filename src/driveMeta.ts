import { FILE_NAMES } from "@/route/patterns";
import { gpsLockInLog, type GpsFix, type GpsLockMode } from "@/log/gps";
import type { DataSource } from "@/source/types";
import type { RecordEntry } from "@/records";

const QLOG_NAMES = FILE_NAMES.qlog;

/** Extra segments to walk when first/last alone have no GPS lock. */
export const GPS_SEGMENT_LIMIT = 5;

const LOG = (...args: unknown[]) => console.info("[replay:gps]", ...args);
const WARN = (...args: unknown[]) => console.warn("[replay:gps]", ...args);
const ERR = (...args: unknown[]) => console.error("[replay:gps]", ...args);

export type PlaceLabel = {
  place: string;
  region: string;
};

/**
 * - loading-timing: scanning first/last qlog for wall-clock + GPS
 * - loading-places: geocoding or expanding GPS search
 * - ready / empty / error: terminal
 */
export type DriveMeta = {
  status: "loading-timing" | "loading-places" | "ready" | "empty" | "error";
  first: GpsFix | null;
  last: GpsFix | null;
  start?: PlaceLabel;
  end?: PlaceLabel;
  error?: string;
};

export type EnrichOptions = {
  reverseGeocode: boolean;
};

async function segmentQlogPath(source: DataSource, segmentDir: string): Promise<string | null> {
  const entries = await source.list(segmentDir);
  for (const name of QLOG_NAMES) {
    const hit = entries.find((e) => e.kind === "file" && e.name === name);
    if (hit) return hit.path;
  }
  return null;
}

async function lockFromSegment(
  source: DataSource,
  segmentDir: string,
  mode: GpsLockMode,
): Promise<GpsFix | null> {
  const logPath = await segmentQlogPath(source, segmentDir);
  if (!logPath) {
    LOG(`no qlog in ${segmentDir}`);
    return null;
  }
  LOG(`reading ${logPath} (${mode})`);
  const bytes = await source.read(logPath);
  const fix = await gpsLockInLog(bytes, mode);
  if (fix) {
    LOG(`lock ${mode} @ ${segmentDir}`, fix.latitude, fix.longitude, fix.unixTimestampMillis);
  } else {
    LOG(`no lock in ${logPath}`);
  }
  return fix;
}

/** First + last segment only (fast path for date/time). */
async function locksFromEnds(
  source: DataSource,
  segmentPaths: string[],
): Promise<{ first: GpsFix | null; last: GpsFix | null }> {
  const firstDir = segmentPaths[0]!;
  const lastDir = segmentPaths[segmentPaths.length - 1]!;
  if (firstDir === lastDir) {
    const bytesPath = await segmentQlogPath(source, firstDir);
    if (!bytesPath) return { first: null, last: null };
    const bytes = await source.read(bytesPath);
    const [first, last] = await Promise.all([
      gpsLockInLog(bytes, "first"),
      gpsLockInLog(bytes, "last"),
    ]);
    return { first, last };
  }
  const [first, last] = await Promise.all([
    lockFromSegment(source, firstDir, "first"),
    lockFromSegment(source, lastDir, "last"),
  ]);
  return { first, last };
}

/** Walk up to LIMIT segments from each end when ends had no lock. */
async function expandLocks(
  source: DataSource,
  segmentPaths: string[],
  current: { first: GpsFix | null; last: GpsFix | null },
): Promise<{ first: GpsFix | null; last: GpsFix | null }> {
  let { first, last } = current;
  const n = Math.min(GPS_SEGMENT_LIMIT, segmentPaths.length);

  if (!first) {
    for (let i = 1; i < n; i++) {
      first = await lockFromSegment(source, segmentPaths[i]!, "first");
      if (first) break;
    }
  }
  if (!last) {
    for (let i = 1; i < n; i++) {
      const idx = segmentPaths.length - 1 - i;
      last = await lockFromSegment(source, segmentPaths[idx]!, "last");
      if (last) break;
    }
  }
  return { first, last };
}

function formatCoordLabel(fix: GpsFix): PlaceLabel {
  const ns = fix.latitude >= 0 ? "N" : "S";
  const ew = fix.longitude >= 0 ? "E" : "W";
  return {
    place: `${Math.abs(fix.latitude).toFixed(4)}° ${ns}`,
    region: `${Math.abs(fix.longitude).toFixed(4)}° ${ew}`,
  };
}

function geocodeKey(fix: GpsFix): string {
  return `${fix.latitude.toFixed(3)},${fix.longitude.toFixed(3)}`;
}

const geocodeCache = new Map<string, PlaceLabel>();
const geocodeInflight = new Map<string, Promise<PlaceLabel>>();

async function reverseGeocodeNetwork(fix: GpsFix): Promise<PlaceLabel> {
  const url =
    `https://api.bigdatacloud.net/data/reverse-geocode-client` +
    `?latitude=${encodeURIComponent(fix.latitude)}` +
    `&longitude=${encodeURIComponent(fix.longitude)}` +
    `&localityLanguage=en`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geocode ${res.status}`);
  const body = (await res.json()) as {
    locality?: string;
    city?: string;
    principalSubdivision?: string;
    countryName?: string;
    localityInfo?: { administrative?: { name: string; adminLevel: number }[] };
  };
  const admins = body.localityInfo?.administrative ?? [];
  const neighbourhood =
    admins.find((a) => a.adminLevel >= 8)?.name ||
    body.locality ||
    body.city ||
    "—";
  const regionParts = [
    body.city && body.city !== neighbourhood ? body.city : null,
    body.principalSubdivision,
  ].filter(Boolean);
  const region = regionParts.join(", ") || body.countryName || "—";
  return { place: neighbourhood, region };
}

async function reverseGeocode(fix: GpsFix): Promise<PlaceLabel> {
  const key = geocodeKey(fix);
  const cached = geocodeCache.get(key);
  if (cached) return cached;

  const pending = geocodeInflight.get(key);
  if (pending) return pending;

  const task = reverseGeocodeNetwork(fix)
    .then((label) => {
      geocodeCache.set(key, label);
      geocodeInflight.delete(key);
      return label;
    })
    .catch((err) => {
      geocodeInflight.delete(key);
      WARN("geocode failed", err);
      return formatCoordLabel(fix);
    });

  geocodeInflight.set(key, task);
  return task;
}

export async function placesFromFixes(
  first: GpsFix | null,
  last: GpsFix | null,
  reverseGeocodeEnabled: boolean,
): Promise<{ start?: PlaceLabel; end?: PlaceLabel }> {
  const [start, end] = await Promise.all([
    first
      ? reverseGeocodeEnabled
        ? reverseGeocode(first)
        : Promise.resolve(formatCoordLabel(first))
      : Promise.resolve(undefined),
    last
      ? reverseGeocodeEnabled
        ? reverseGeocode(last)
        : Promise.resolve(formatCoordLabel(last))
      : Promise.resolve(undefined),
  ]);
  return { start, end };
}

/**
 * Two-phase enrich. Calls `onUpdate` as each phase completes.
 * 1) first+last qlog → date/time (+ coords)
 * 2) optional expand GPS / reverse geocode → places
 */
export async function loadDriveMeta(
  source: DataSource,
  record: RecordEntry,
  options: EnrichOptions,
  onUpdate: (meta: DriveMeta) => void,
): Promise<void> {
  const paths = record.segmentPaths;
  LOG(`drive ${record.recordId} — ${paths.length} segment(s)`);
  if (paths.length === 0) {
    onUpdate({ status: "empty", first: null, last: null });
    return;
  }

  try {
    onUpdate({ status: "loading-timing", first: null, last: null });

    let { first, last } = await locksFromEnds(source, paths);

    if (!first && !last) {
      // Ends had no lock — keep raw date/time; skeleton places while expanding.
      onUpdate({ status: "loading-places", first: null, last: null });
      ({ first, last } = await expandLocks(source, paths, { first, last }));
      if (!first && !last) {
        WARN(`drive ${record.recordId}: no GPS lock`);
        onUpdate({ status: "empty", first: null, last: null });
        return;
      }
    }

    // Phase 1 done — date/time/duration from GPS timestamps.
    if (options.reverseGeocode) {
      onUpdate({ status: "loading-places", first, last });
      const { start, end } = await placesFromFixes(first, last, true);
      onUpdate({ status: "ready", first, last, start, end });
    } else {
      onUpdate({
        status: "ready",
        first,
        last,
        start: first ? formatCoordLabel(first) : undefined,
        end: last ? formatCoordLabel(last) : undefined,
      });
    }

    LOG(`drive ${record.recordId} ready`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ERR(`drive ${record.recordId} failed`, message);
    onUpdate({ status: "error", first: null, last: null, error: message });
  }
}

export function createEnrichQueue() {
  let chain: Promise<void> = Promise.resolve();
  return function enqueue(task: () => Promise<void>): void {
    chain = chain.then(task).catch((err) => {
      ERR("queue task failed", err);
    });
  };
}
