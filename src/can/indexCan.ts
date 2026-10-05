import { Event_Which } from "@/cereal";
import { decompressLog } from "@/log/decompress";
import { parseEvents } from "@/log/logReader";
import { SEGMENT_SECONDS } from "@/playback/session";
import type { CanSegment, CanTrack } from "@/can/types";

/** Growable per-message buffers; frozen into a CanTrack at the end. */
class TrackBuilder {
  n = 0;
  stride = 8;
  times = new Float64Array(256);
  lens = new Uint8Array(256);
  data = new Uint8Array(256 * 8);

  constructor(
    readonly bus: number,
    readonly address: number,
  ) {}

  push(t: number, dat: Uint8Array) {
    if (dat.length > this.stride) this.widen(dat.length > 8 ? 64 : 8);
    if (this.n === this.times.length) this.grow();
    const i = this.n++;
    this.times[i] = t;
    this.lens[i] = dat.length;
    this.data.set(dat, i * this.stride);
  }

  private grow() {
    const cap = this.times.length * 2;
    const times = new Float64Array(cap);
    times.set(this.times);
    const lens = new Uint8Array(cap);
    lens.set(this.lens);
    const data = new Uint8Array(cap * this.stride);
    data.set(this.data);
    this.times = times;
    this.lens = lens;
    this.data = data;
  }

  private widen(stride: number) {
    const data = new Uint8Array(this.times.length * stride);
    for (let i = 0; i < this.n; i++) {
      data.set(this.data.subarray(i * this.stride, i * this.stride + this.lens[i]!), i * stride);
    }
    this.data = data;
    this.stride = stride;
  }

  build(): CanTrack {
    const { n, stride } = this;
    const data = this.data.slice(0, n * stride);
    const lens = this.lens.slice(0, n);
    const changes: number[] = [];
    for (let i = 1; i < n; i++) {
      if (lens[i] !== lens[i - 1]) {
        changes.push(i);
        continue;
      }
      const a = i * stride;
      const b = a - stride;
      for (let k = 0; k < stride; k++) {
        if (data[a + k] !== data[b + k]) {
          changes.push(i);
          break;
        }
      }
    }
    return {
      bus: this.bus,
      address: this.address,
      times: this.times.slice(0, n),
      lens,
      data,
      stride,
      changes: Uint32Array.from(changes),
    };
  }
}

/** Extract every `can` frame from a raw/compressed log, grouped by (bus, address). */
export async function indexCanBytes(
  bytes: Uint8Array,
  log: CanSegment["log"],
): Promise<CanSegment> {
  const raw = await decompressLog(bytes);
  const builders = new Map<number, TrackBuilder>();
  let t0: bigint | null = null;
  let frames = 0;
  let fingerprint = "";

  for (const event of parseEvents(raw)) {
    const mono = event.getLogMonoTime();
    const monoBig = typeof mono === "bigint" ? mono : BigInt(Math.trunc(Number(mono)));
    if (t0 == null) t0 = monoBig;
    const which = event.which();
    try {
      if (which === Event_Which.CAN) {
        const t = Number(monoBig - t0) / 1e9;
        if (!Number.isFinite(t) || t < -1 || t > SEGMENT_SECONDS + 30) continue;
        const list = event.getCan();
        const len = list.getLength();
        for (let i = 0; i < len; i++) {
          const msg = list.get(i);
          const bus = msg.getSrc();
          const address = msg.getAddress();
          const key = bus * 0x1_0000_0000 + address;
          let b = builders.get(key);
          if (!b) {
            b = new TrackBuilder(bus, address);
            builders.set(key, b);
          }
          b.push(t, msg.getDat().toUint8Array());
          frames++;
        }
      } else if (which === Event_Which.CAR_PARAMS && !fingerprint) {
        fingerprint = event.getCarParams().getCarFingerprint() || "";
      }
    } catch {
      /* skip malformed event */
    }
  }

  const tracks = [...builders.values()]
    .map((b) => b.build())
    .sort((a, b) => a.bus - b.bus || a.address - b.address);
  return { tracks, log, frames, fingerprint };
}

/** ArrayBuffers to transfer when posting a CanSegment across threads. */
export function canTransferables(seg: CanSegment): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const t of seg.tracks) {
    out.push(
      t.times.buffer as ArrayBuffer,
      t.lens.buffer as ArrayBuffer,
      t.data.buffer as ArrayBuffer,
      t.changes.buffer as ArrayBuffer,
    );
  }
  return out;
}
