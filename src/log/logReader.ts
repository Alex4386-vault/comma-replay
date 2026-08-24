import { Message } from "capnp-ts";
import { CerealEvent, Event_Which, type LogEvent } from "../cereal";

/** Unpacked capnp stream framing — same as pycapnp Event.read_multiple_bytes. */
export function framedMessageLength(data: Uint8Array, offset: number): number | null {
  if (offset + 4 > data.byteLength) return null;
  const dv = new DataView(data.buffer, data.byteOffset + offset, data.byteLength - offset);
  const segmentCount = dv.getUint32(0, true) + 1;
  if (segmentCount < 1 || segmentCount > 512) return null;
  let headerBytes = 4 + segmentCount * 4;
  if (headerBytes % 8 !== 0) headerBytes += 8 - (headerBytes % 8);
  if (headerBytes > data.byteLength - offset) return null;
  let total = headerBytes;
  for (let i = 0; i < segmentCount; i++) {
    const words = dv.getUint32(4 + i * 4, true);
    if (words > 0x1000000) return null;
    total += words * 8;
  }
  if (offset + total > data.byteLength) return null;
  return total;
}

export function* parseEvents(raw: Uint8Array): Generator<LogEvent> {
  let offset = 0;
  while (offset < raw.byteLength) {
    const len = framedMessageLength(raw, offset);
    if (len == null || len <= 0) break;
    const slice = raw.subarray(offset, offset + len);
    const msg = new Message(slice, false);
    yield msg.getRoot(CerealEvent);
    offset += len;
  }
}

export type EventWhich = ReturnType<LogEvent["which"]>;

export type EventSummary = {
  logMonoTime: string;
  which: string;
};

export function summarize(event: LogEvent): EventSummary {
  return {
    logMonoTime: event.getLogMonoTime().toString(),
    which: Event_Which[event.which()] ?? String(event.which()),
  };
}
