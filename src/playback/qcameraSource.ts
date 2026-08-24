import mpegts from "mpegts.js";
import type { DataSource, ObjectUrlHandle } from "@/source/types";
import { FILE_NAMES } from "@/route/patterns";
import type { RecordEntry } from "@/records";
import { SEGMENT_SECONDS, timeToSegment } from "@/playback/session";

export type FrameSourceEvents = {
  onTime?: (t: number) => void;
  onEnded?: () => void;
  onError?: (message: string) => void;
  onSegment?: (index: number) => void;
};

type SegmentSlot = {
  path: string;
  handle: ObjectUrlHandle;
};

type MpegtsPlayer = {
  attachMediaElement: (el: HTMLMediaElement) => void;
  load: () => void;
  play: () => Promise<void>;
  pause: () => void;
  unload: () => void;
  detachMediaElement: () => void;
  destroy: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  off: (event: string, listener: (...args: unknown[]) => void) => void;
};

/**
 * qcamera.ts via mpegts.js (MSE), one segment file at a time.
 * Drive time ≈ segmentIndex * 60 + video.currentTime.
 */
export class QcameraSource {
  private source: DataSource;
  private record: RecordEntry;
  private video: HTMLVideoElement;
  private events: FrameSourceEvents;
  private slots = new Map<number, SegmentSlot>();
  private player: MpegtsPlayer | null = null;
  private segmentIndex = -1;
  private loadGen = 0;
  private disposed = false;
  private syncTimer: number | null = null;
  private onPlayerError: ((...args: unknown[]) => void) | null = null;

  constructor(
    source: DataSource,
    record: RecordEntry,
    video: HTMLVideoElement,
    events: FrameSourceEvents = {},
  ) {
    this.source = source;
    this.record = record;
    this.video = video;
    this.events = events;
  }

  get duration(): number {
    return Math.max(1, this.record.segments.length) * SEGMENT_SECONDS;
  }

  async open(): Promise<void> {
    if (!this.source.openObjectURL) {
      throw new Error("DataSource does not support openObjectURL");
    }
    if (!mpegts.isSupported()) {
      throw new Error("MPEG-TS / MSE H.264 playback is not supported in this browser");
    }

    // Resolve paths lazily per segment on first seek/load — only probe the first now.
    if (this.record.segmentPaths.length === 0) {
      throw new Error("No segments");
    }

    this.video.addEventListener("ended", this.onVideoEnded);
    this.video.addEventListener("timeupdate", this.onTimeUpdate);
    this.video.addEventListener("error", this.onVideoError);

    await this.loadSegment(0, 0);
    this.startSync();
  }

  async seek(driveTime: number): Promise<void> {
    const { index, offset } = timeToSegment(driveTime, this.record.segmentPaths.length);
    if (index !== this.segmentIndex) {
      await this.loadSegment(index, offset);
    } else {
      this.video.currentTime = offset;
    }
    this.events.onTime?.(index * SEGMENT_SECONDS + (this.video.currentTime || 0));
  }

  play(): void {
    void this.video.play().catch((err) => {
      this.events.onError?.(err instanceof Error ? err.message : String(err));
    });
  }

  pause(): void {
    this.video.pause();
  }

  setRate(rate: number): void {
    this.video.playbackRate = rate;
  }

  dispose(): void {
    this.disposed = true;
    this.stopSync();
    this.video.removeEventListener("ended", this.onVideoEnded);
    this.video.removeEventListener("timeupdate", this.onTimeUpdate);
    this.video.removeEventListener("error", this.onVideoError);
    this.destroyPlayer();
    for (const slot of this.slots.values()) {
      slot.handle.revoke();
    }
    this.slots.clear();
  }

  private driveTime(): number {
    if (this.segmentIndex < 0) return 0;
    return this.segmentIndex * SEGMENT_SECONDS + (this.video.currentTime || 0);
  }

  private startSync() {
    this.stopSync();
    const tick = () => {
      if (this.disposed) return;
      if (this.segmentIndex >= 0 && !this.video.paused) {
        this.events.onTime?.(this.driveTime());
      }
      this.syncTimer = window.setTimeout(tick, 250);
    };
    this.syncTimer = window.setTimeout(tick, 250);
  }

  private stopSync() {
    if (this.syncTimer != null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private onTimeUpdate = () => {
    if (this.disposed || this.video.paused) return;
    this.events.onTime?.(this.driveTime());
  };

  private onVideoEnded = () => {
    const next = this.segmentIndex + 1;
    if (next < this.record.segmentPaths.length) {
      void this.loadSegment(next, 0).then(() => {
        if (!this.disposed) this.play();
      });
    } else {
      this.events.onEnded?.();
    }
  };

  private onVideoError = () => {
    const err = this.video.error;
    this.events.onError?.(err?.message || `video error code ${err?.code ?? "?"}`);
  };

  private destroyPlayer() {
    if (this.player && this.onPlayerError) {
      try {
        this.player.off(mpegts.Events.ERROR, this.onPlayerError);
      } catch {
        /* ignore */
      }
    }
    this.onPlayerError = null;
    if (this.player) {
      try {
        this.player.pause();
        this.player.unload();
        this.player.detachMediaElement();
        this.player.destroy();
      } catch {
        /* ignore */
      }
      this.player = null;
    }
  }

  private async resolveSlot(index: number): Promise<SegmentSlot> {
    const existing = this.slots.get(index);
    if (existing) return existing;

    const segDir = this.record.segmentPaths[index];
    if (!segDir) throw new Error(`Missing segment path at index ${index}`);

    const openObjectURL = this.source.openObjectURL;
    if (!openObjectURL) throw new Error("DataSource does not support openObjectURL");

    let lastErr: unknown;
    for (const name of FILE_NAMES.qcamera) {
      const path = `${segDir}/${name}`;
      try {
        if (this.source.exists && !(await this.source.exists(path))) continue;
        if (this.disposed) throw new Error("disposed");
        // Keep method on source — unbound openObjectURL loses `this` (resolveDir).
        const handle = await openObjectURL.call(this.source, path);
        if (this.disposed) {
          handle.revoke();
          throw new Error("disposed");
        }
        const slot: SegmentSlot = { path, handle };
        this.slots.set(index, slot);
        return slot;
      } catch (err) {
        if (err instanceof Error && err.message === "disposed") throw err;
        lastErr = err;
      }
    }
    const detail =
      lastErr instanceof Error ? lastErr.message : lastErr ? String(lastErr) : "not found";
    throw new Error(`No qcamera under ${segDir}: ${detail}`);
  }

  private async loadSegment(index: number, offset: number): Promise<void> {
    const gen = ++this.loadGen;
    this.destroyPlayer();

    const slot = await this.resolveSlot(index);
    if (this.disposed || gen !== this.loadGen) return;

    // Workers break under Vite (webworkify). Keep transmux on main thread.
    const player = mpegts.createPlayer(
      {
        type: "mpegts",
        isLive: false,
        hasAudio: false,
        hasVideo: true,
        url: slot.handle.url,
      },
      {
        enableWorker: false,
        enableWorkerForMSE: false,
        enableStashBuffer: true,
        stashInitialSize: 384,
        lazyLoad: false,
      },
    ) as MpegtsPlayer;

    this.onPlayerError = (...args: unknown[]) => {
      const msg = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
      console.error("[replay:qcamera] mpegts error", ...args);
      this.events.onError?.(msg || "mpegts error");
    };
    player.on(mpegts.Events.ERROR, this.onPlayerError);

    player.attachMediaElement(this.video);
    player.load();
    this.player = player;
    this.segmentIndex = index;
    this.events.onSegment?.(index);

    await waitEvent(this.video, "loadedmetadata", 20_000);
    if (this.disposed || gen !== this.loadGen) return;

    const dur = Number.isFinite(this.video.duration) ? this.video.duration : SEGMENT_SECONDS;
    this.video.currentTime = Math.min(Math.max(0, offset), Math.max(0, dur - 0.05));
  }
}

function waitEvent(el: HTMLMediaElement, type: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (type === "loadedmetadata" && el.readyState >= HTMLMediaElement.HAVE_METADATA) {
      resolve();
      return;
    }
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error(`media ${type} failed`));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timer);
      el.removeEventListener(type, onOk);
      el.removeEventListener("error", onErr);
    };
    el.addEventListener(type, onOk, { once: true });
    el.addEventListener("error", onErr, { once: true });
  });
}
