import { indexOverlayBytes, type OverlaySegment } from "@/overlay/indexLog";

export type OverlayWorkerRequest = { id: number; bytes: ArrayBuffer };
export type OverlayWorkerResponse =
  | { id: number; result: OverlaySegment }
  | { id: number; error: string };

let chain: Promise<void> = Promise.resolve();

self.onmessage = (ev: MessageEvent<OverlayWorkerRequest>) => {
  chain = chain.then(async () => {
    const { id, bytes } = ev.data;
    try {
      const result = await indexOverlayBytes(new Uint8Array(bytes));
      const res: OverlayWorkerResponse = { id, result };
      self.postMessage(res);
    } catch (err) {
      const res: OverlayWorkerResponse = {
        id,
        error: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(res);
    }
  });
};
