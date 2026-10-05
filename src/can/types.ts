/** One (bus, address) stream inside a segment. Payloads are packed at a fixed stride. */
export type CanTrack = {
  bus: number;
  address: number;
  /** Seconds from segment start, ascending. */
  times: Float64Array;
  /** Payload length per frame. */
  lens: Uint8Array;
  /** Payloads, `stride` bytes per frame (zero-padded). */
  data: Uint8Array;
  stride: number;
  /** Frame indices i > 0 whose payload differs from frame i - 1. */
  changes: Uint32Array;
};

export type CanSegment = {
  tracks: CanTrack[];
  /** Which log the frames came from; qlog CAN is heavily decimated. */
  log: "rlog" | "qlog" | null;
  frames: number;
  fingerprint: string;
};

export const canKey = (bus: number, address: number) => `${bus}:${address}`;

export const emptyCanSegment = (): CanSegment => ({
  tracks: [],
  log: null,
  frames: 0,
  fingerprint: "",
});
