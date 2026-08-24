import { decompress as zstdDecompress } from "fzstd";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const BZ2_MAGIC = [0x42, 0x5a, 0x68]; // BZh

function startsWith(data: Uint8Array, magic: number[]): boolean {
  if (data.length < magic.length) return false;
  return magic.every((b, i) => data[i] === b);
}

export async function decompressLog(data: Uint8Array): Promise<Uint8Array> {
  if (startsWith(data, ZSTD_MAGIC)) {
    return zstdDecompress(data);
  }
  if (startsWith(data, BZ2_MAGIC)) {
    throw new Error("bz2 logs are not decoded yet; use rlog.zst / qlog.zst");
  }
  return data;
}
