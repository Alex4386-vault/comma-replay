import { decompressLog } from "./decompress";
import { parseEvents, summarize, type EventSummary } from "./logReader";

export type ParseResult = {
  count: number;
  byWhich: Record<string, number>;
  firstTime: string | null;
  lastTime: string | null;
  samples: EventSummary[];
};

export async function parseLogBytes(bytes: Uint8Array, sampleLimit = 40): Promise<ParseResult> {
  const raw = await decompressLog(bytes);
  const byWhich: Record<string, number> = {};
  const samples: EventSummary[] = [];
  let count = 0;
  let firstTime: string | null = null;
  let lastTime: string | null = null;

  for (const event of parseEvents(raw)) {
    const s = summarize(event);
    count++;
    byWhich[s.which] = (byWhich[s.which] ?? 0) + 1;
    if (!firstTime) firstTime = s.logMonoTime;
    lastTime = s.logMonoTime;
    if (samples.length < sampleLimit) samples.push(s);
  }

  return { count, byWhich, firstTime, lastTime, samples };
}
