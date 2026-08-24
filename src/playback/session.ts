/** Drive-relative playback clock (seconds from drive start). */

export type PlaybackQuality = "qcamera" | "fcamera";

export type OverlayStyle = "none" | "comma3x-stock" | "comma3x-sunnypilot" | "comma4";

export type SessionState = {
  /** Current time on the drive timeline, seconds. */
  t: number;
  /** Total drive length, seconds. */
  duration: number;
  playing: boolean;
  rate: number;
  /** Export / clip range (inclusive start, exclusive end conceptually). */
  inPoint: number;
  outPoint: number;
  quality: PlaybackQuality;
  overlay: OverlayStyle;
};

export const SEGMENT_SECONDS = 60;

export function initialSession(segmentCount: number): SessionState {
  const duration = Math.max(1, segmentCount) * SEGMENT_SECONDS;
  return {
    t: 0,
    duration,
    playing: false,
    rate: 1,
    inPoint: 0,
    outPoint: duration,
    quality: "qcamera",
    overlay: "none",
  };
}

export function clampTime(t: number, duration: number): number {
  if (!Number.isFinite(t)) return 0;
  return Math.min(Math.max(0, t), Math.max(0, duration));
}

export function formatDriveClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Segment index + offset within that segment for a drive time. */
export function timeToSegment(t: number, segmentCount: number): { index: number; offset: number } {
  const idx = Math.min(
    Math.max(0, Math.floor(t / SEGMENT_SECONDS)),
    Math.max(0, segmentCount - 1),
  );
  return { index: idx, offset: t - idx * SEGMENT_SECONDS };
}
