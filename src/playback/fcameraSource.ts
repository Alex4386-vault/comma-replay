import type { DataSource } from "@/source/types";
import { FILE_NAMES } from "@/route/patterns";
import type { RecordEntry } from "@/records";
import { SEGMENT_SECONDS, timeToSegment } from "@/playback/session";
import { parseHevcAnnexB, type AccessUnit } from "@/playback/hevcAnnexB";
import type { FrameSourceEvents } from "@/playback/qcameraSource";

const FCAM_FPS = 20; // comma road camera runs at 20 Hz

type DecodedSegment = {
  units: AccessUnit[];
  config: VideoDecoderConfig;
};

/**
 * fcamera.hevc playback via WebCodecs. The raw HEVC elementary stream has no
 * timestamps, so we assign a constant 20fps cadence and drive playback from an
 * internal clock, decoding on demand and painting frames to a canvas.
 */
export class FcameraSource {
  private source: DataSource;
  private record: RecordEntry;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private events: FrameSourceEvents;

  private segments = new Map<number, DecodedSegment>();
  private segmentIndex = -1;
  private disposed = false;
  private playing = false;
  private rate = 1;
  private offset = 0; // seconds within current segment
  private lastTick = 0;
  private raf = 0;
  private loadGen = 0;
  private decoder: VideoDecoder | null = null;

  constructor(
    source: DataSource,
    record: RecordEntry,
    canvas: HTMLCanvasElement,
    events: FrameSourceEvents = {},
  ) {
    this.source = source;
    this.record = record;
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.events = events;
  }

  static isSupported(): boolean {
    return typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";
  }

  get duration(): number {
    return Math.max(1, this.record.segments.length) * SEGMENT_SECONDS;
  }

  async open(): Promise<void> {
    if (!FcameraSource.isSupported()) {
      throw new Error("WebCodecs (VideoDecoder) is not supported in this browser");
    }
    if (this.record.segmentPaths.length === 0) throw new Error("No segments");
    await this.showFrameAt(0, 0);
    this.startClock();
  }

  async seek(driveTime: number): Promise<void> {
    const { index, offset } = timeToSegment(driveTime, this.record.segmentPaths.length);
    await this.showFrameAt(index, offset);
    this.events.onTime?.(index * SEGMENT_SECONDS + offset);
  }

  play(): void {
    this.playing = true;
    this.lastTick = performance.now();
  }

  pause(): void {
    this.playing = false;
  }

  setRate(rate: number): void {
    this.rate = rate;
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.closeDecoder();
    this.segments.clear();
  }

  private driveTime(): number {
    if (this.segmentIndex < 0) return 0;
    return this.segmentIndex * SEGMENT_SECONDS + this.offset;
  }

  private startClock() {
    this.lastTick = performance.now();
    const tick = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = (now - this.lastTick) / 1000;
      this.lastTick = now;
      if (!this.playing) return;
      this.offset += dt * this.rate;
      let index = this.segmentIndex;
      let offset = this.offset;
      if (offset >= SEGMENT_SECONDS) {
        offset -= SEGMENT_SECONDS;
        index += 1;
        if (index >= this.record.segmentPaths.length) {
          this.playing = false;
          this.events.onEnded?.();
          return;
        }
      }
      void this.showFrameAt(index, offset);
      this.events.onTime?.(this.driveTime());
    };
    this.raf = requestAnimationFrame(tick);
  }

  private busy = false;
  private pendingTarget: { index: number; offset: number } | null = null;

  /** Decode + paint the frame at (segment, offset). Coalesces rapid requests. */
  private async showFrameAt(index: number, offset: number): Promise<void> {
    this.segmentIndex = index;
    this.offset = offset;
    if (this.busy) {
      this.pendingTarget = { index, offset };
      return;
    }
    this.busy = true;
    try {
      const seg = await this.ensureSegment(index);
      if (this.disposed || !seg) return;
      const frameIdx = Math.min(
        seg.units.length - 1,
        Math.max(0, Math.floor(offset * FCAM_FPS)),
      );
      if (index === this.segmentIndex) {
        this.events.onSegment?.(index);
        await this.decodeAndPaint(seg, frameIdx);
      }
    } catch (err) {
      if (!this.disposed) this.events.onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
      const next = this.pendingTarget;
      this.pendingTarget = null;
      if (next && (next.index !== index || Math.abs(next.offset - offset) > 0.02)) {
        void this.showFrameAt(next.index, next.offset);
      }
    }
  }

  private async ensureSegment(index: number): Promise<DecodedSegment | null> {
    const cached = this.segments.get(index);
    if (cached) return cached;
    const segDir = this.record.segmentPaths[index];
    if (!segDir) return null;

    let bytes: Uint8Array | null = null;
    for (const name of FILE_NAMES.fcamera) {
      const path = `${segDir}/${name}`;
      try {
        if (this.source.exists && !(await this.source.exists(path))) continue;
        bytes = await this.source.read(path);
        break;
      } catch {
        /* try next */
      }
    }
    if (!bytes) throw new Error(`No fcamera under ${segDir}`);

    const info = parseHevcAnnexB(bytes);
    if (info.accessUnits.length === 0) throw new Error("fcamera: no frames decoded from stream");

    const codec = await pickCodec(info.codecs, info.codedWidth, info.codedHeight);
    if (!codec) throw new Error(`fcamera: no supported HEVC codec (${info.codecs.join(", ")})`);

    const seg: DecodedSegment = {
      units: info.accessUnits,
      config: { codec, codedWidth: info.codedWidth || undefined, codedHeight: info.codedHeight || undefined },
    };
    this.segments.set(index, seg);
    // Keep memory bounded: retain a small window of segments.
    if (this.segments.size > 4) {
      for (const key of this.segments.keys()) {
        if (Math.abs(key - index) > 2) {
          this.segments.delete(key);
          break;
        }
      }
    }
    return seg;
  }

  /**
   * Decode from the keyframe at/behind frameIdx up to frameIdx, painting the
   * last frame. HEVC requires decoding from a keyframe forward.
   */
  private async decodeAndPaint(seg: DecodedSegment, frameIdx: number): Promise<void> {
    let key = frameIdx;
    while (key > 0 && !seg.units[key]!.keyframe) key--;

    await this.resetDecoder(seg.config);
    const decoder = this.decoder;
    if (!decoder) return;

    let lastFrame: VideoFrame | null = null;
    const wanted = frameIdx;
    const onFrame = (frame: VideoFrame, i: number) => {
      if (i >= wanted) {
        if (lastFrame) lastFrame.close();
        lastFrame = frame;
      } else {
        frame.close();
      }
    };

    let emitted = 0;
    this.frameSink = (frame) => onFrame(frame, emitted++);

    for (let i = key; i <= frameIdx; i++) {
      const u = seg.units[i]!;
      decoder.decode(
        new EncodedVideoChunk({
          type: u.keyframe ? "key" : "delta",
          timestamp: (i * 1e6) / FCAM_FPS,
          data: u.data,
        }),
      );
    }
    await decoder.flush().catch(() => undefined);
    this.frameSink = null;

    if (lastFrame && !this.disposed) {
      this.paint(lastFrame);
      (lastFrame as VideoFrame).close();
    }
  }

  private frameSink: ((frame: VideoFrame) => void) | null = null;

  private async resetDecoder(config: VideoDecoderConfig): Promise<void> {
    this.closeDecoder();
    const gen = ++this.loadGen;
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (this.disposed || gen !== this.loadGen) {
          frame.close();
          return;
        }
        if (this.frameSink) this.frameSink(frame);
        else frame.close();
      },
      error: (e) => {
        if (!this.disposed) this.events.onError?.(e.message);
      },
    });
    decoder.configure(config);
    this.decoder = decoder;
  }

  private closeDecoder() {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        /* ignore */
      }
      this.decoder = null;
    }
  }

  private paint(frame: VideoFrame) {
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(frame, 0, 0, w, h);
  }
}

/** First codec string that VideoDecoder reports as supported. */
async function pickCodec(codecs: string[], w: number, h: number): Promise<string | null> {
  for (const codec of codecs) {
    try {
      const cfg: VideoDecoderConfig = { codec };
      if (w) cfg.codedWidth = w;
      if (h) cfg.codedHeight = h;
      const support = await VideoDecoder.isConfigSupported(cfg);
      if (support.supported) return codec;
    } catch {
      /* try next */
    }
  }
  return null;
}
