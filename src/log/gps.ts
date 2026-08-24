import { Event_Which, type GpsLocation, type LogEvent } from "../cereal";
import { decompressLog } from "./decompress";
import { parseEvents } from "./logReader";

export type GpsFix = {
  latitude: number;
  longitude: number;
  unixTimestampMillis: number | null;
};

export type GpsLockMode = "first" | "last";

function isLock(gps: GpsLocation): boolean {
  const lat = gps.getLatitude();
  const lon = gps.getLongitude();
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return false;
  if (lat === 0 && lon === 0) return false;
  try {
    if (gps.getHasFix()) return true;
  } catch {
    /* field may be absent */
  }
  return Math.abs(lat) > 1e-5 || Math.abs(lon) > 1e-5;
}

function toFix(gps: GpsLocation): GpsFix {
  const ts = gps.getUnixTimestampMillis();
  const millis = typeof ts === "bigint" ? Number(ts) : Number(ts);
  return {
    latitude: gps.getLatitude(),
    longitude: gps.getLongitude(),
    unixTimestampMillis: Number.isFinite(millis) && millis > 0 ? millis : null,
  };
}

function gpsFromEvent(event: LogEvent): GpsLocation | null {
  const which = event.which();
  if (which === Event_Which.GPS_LOCATION) return event.getGpsLocation();
  if (which === Event_Which.GPS_LOCATION_EXTERNAL) return event.getGpsLocationExternal();
  return null;
}

/** First or last GPS lock in one log blob. */
export async function gpsLockInLog(
  bytes: Uint8Array,
  mode: GpsLockMode,
): Promise<GpsFix | null> {
  let raw: Uint8Array;
  try {
    raw = await decompressLog(bytes);
  } catch (err) {
    console.warn("[replay:gps] truncated or unreadable log", err);
    return null;
  }
  let scanned = 0;
  let gpsMsgs = 0;

  if (mode === "first") {
    for (const event of parseEvents(raw)) {
      scanned++;
      const gps = gpsFromEvent(event);
      if (!gps) continue;
      gpsMsgs++;
      if (!isLock(gps)) continue;
      console.info("[replay:gps:worker] first lock after", scanned, "events,", gpsMsgs, "gps msgs");
      return toFix(gps);
    }
    console.info("[replay:gps:worker] no first lock — scanned", scanned, "events,", gpsMsgs, "gps msgs");
    return null;
  }

  let last: GpsFix | null = null;
  for (const event of parseEvents(raw)) {
    scanned++;
    const gps = gpsFromEvent(event);
    if (!gps) continue;
    gpsMsgs++;
    if (!isLock(gps)) continue;
    last = toFix(gps);
  }
  console.info(
    "[replay:gps:worker] last lock",
    last ? "found" : "missing",
    "— scanned",
    scanned,
    "events,",
    gpsMsgs,
    "gps msgs",
  );
  return last;
}
