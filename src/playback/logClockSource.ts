import type { RecordEntry } from "@/records";
import { SEGMENT_SECONDS } from "@/playback/session";
import type { FrameSourceEvents } from "@/playback/qcameraSource";

/**
 * Playback without video: a wall clock over the drive, so the map, overlay
 * and CAN inspector still work on drives whose cameras haven't synced.
 * Same surface as QcameraSource / FcameraSource.
 */
export class LogClockSource {
  private record: RecordEntry;
  private events: FrameSourceEvents;
  private t = 0;
  private rate = 1;
  /** performance.now() when play started, null while paused. */
  private startedAt: number | null = null;
  private startT = 0;
  private timer: number | null = null;

  constructor(record: RecordEntry, events: FrameSourceEvents) {
    this.record = record;
    this.events = events;
  }

  get duration(): number {
    return Math.max(1, this.record.segments.length) * SEGMENT_SECONDS;
  }

  currentTime(): number {
    if (this.startedAt == null) return this.t;
    return Math.min(this.duration, this.startT + ((performance.now() - this.startedAt) / 1000) * this.rate);
  }

  async open(): Promise<void> {
    if (this.record.segmentPaths.length === 0) throw new Error("No segments");
    this.events.onTime?.(0);
  }

  async seek(driveTime: number): Promise<void> {
    const playing = this.startedAt != null;
    this.t = Math.min(Math.max(0, driveTime), this.duration);
    if (playing) this.restart();
    this.events.onTime?.(this.t);
  }

  play(): void {
    if (this.startedAt != null) return;
    if (this.t >= this.duration) this.t = 0;
    this.restart();
    this.timer = window.setInterval(this.tick, 100);
  }

  pause(): void {
    this.t = this.currentTime();
    this.startedAt = null;
    this.stopTimer();
  }

  setRate(rate: number): void {
    this.t = this.currentTime();
    this.rate = rate > 0 && Number.isFinite(rate) ? rate : 1;
    if (this.startedAt != null) this.restart();
  }

  dispose(): void {
    this.startedAt = null;
    this.stopTimer();
  }

  private restart() {
    this.startT = this.t;
    this.startedAt = performance.now();
  }

  private stopTimer() {
    if (this.timer != null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private tick = () => {
    const t = this.currentTime();
    this.events.onTime?.(t);
    if (t >= this.duration) {
      this.pause();
      this.t = this.duration;
      this.events.onEnded?.();
    }
  };
}
