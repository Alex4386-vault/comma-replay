/**
 * Minimal HEVC (H.265) Annex-B elementary-stream parser for comma fcamera.hevc.
 * Splits the byte stream into access units (frames), flags keyframes, and
 * derives WebCodecs codec-string candidates from the SPS. No container/timing
 * exists in the raw stream; the caller assigns timestamps at a constant fps.
 */

export type AccessUnit = {
  /** Annex-B bytes for the whole access unit (start codes included). */
  data: Uint8Array;
  keyframe: boolean;
};

export type HevcInfo = {
  accessUnits: AccessUnit[];
  /** Candidate codec strings to try with VideoDecoder.isConfigSupported. */
  codecs: string[];
  codedWidth: number;
  codedHeight: number;
};

type Nal = { start: number; end: number; type: number };

/** Find NAL unit ranges (including leading start code) in an Annex-B buffer. */
function findNals(buf: Uint8Array): Nal[] {
  const nals: Nal[] = [];
  const n = buf.length;
  let i = 0;
  let prevStart = -1;
  let prevType = -1;
  while (i + 3 < n) {
    // Match 00 00 01 (3-byte) or 00 00 00 01 (4-byte) start codes.
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      const nalHeaderPos = i + 3;
      if (prevStart >= 0) nals.push({ start: prevStart, end: i, type: prevType });
      prevStart = i;
      prevType = (buf[nalHeaderPos]! >> 1) & 0x3f;
      i = nalHeaderPos + 2;
    } else {
      i++;
    }
  }
  if (prevStart >= 0) nals.push({ start: prevStart, end: n, type: prevType });
  return nals;
}

const VCL_MAX = 31; // NAL types 0..31 are VCL (slice) units
function isVcl(type: number): boolean {
  return type <= VCL_MAX;
}
// IRAP (keyframe) VCL types: BLA 16..18, IDR 19..20, CRA 21.
function isIrap(type: number): boolean {
  return type >= 16 && type <= 23;
}

/** first_slice_segment_in_pic_flag is the top bit after the 2-byte NAL header. */
function isFirstSlice(buf: Uint8Array, nal: Nal): boolean {
  // nal.start points at the start code; skip it + 2-byte header.
  const scLen = buf[nal.start + 2] === 1 ? 3 : 4;
  const rbsp = nal.start + scLen + 2;
  return rbsp < buf.length && (buf[rbsp]! & 0x80) !== 0;
}

export function parseHevcAnnexB(buf: Uint8Array): HevcInfo {
  const nals = findNals(buf);
  const accessUnits: AccessUnit[] = [];
  let auStart = -1;
  let auHasVcl = false;
  let auKey = false;
  let spsNal: Nal | null = null;

  const flush = (end: number) => {
    if (auStart >= 0 && auHasVcl) {
      accessUnits.push({ data: buf.subarray(auStart, end), keyframe: auKey });
    }
  };

  for (const nal of nals) {
    if (!spsNal && nal.type === 33) spsNal = nal;
    const vcl = isVcl(nal.type);
    if (vcl && isFirstSlice(buf, nal) && auHasVcl) {
      // New picture starts: close the previous access unit here.
      flush(nal.start);
      auStart = nal.start;
      auHasVcl = false;
      auKey = false;
    }
    if (auStart < 0) auStart = nal.start;
    if (vcl) {
      auHasVcl = true;
      if (isIrap(nal.type)) auKey = true;
    }
  }
  flush(buf.length);

  const derived = spsNal ? deriveFromSps(buf, spsNal) : null;

  return {
    accessUnits,
    codecs: derived?.codecs.length
      ? derived.codecs
      : ["hev1.1.6.L153.B0", "hev1.1.6.L120.B0", "hvc1.1.6.L153.B0"],
    codedWidth: derived?.width ?? 0,
    codedHeight: derived?.height ?? 0,
  };
}

/** Strip Annex-B start code + emulation-prevention bytes, return RBSP. */
function toRbsp(buf: Uint8Array, nal: Nal): Uint8Array {
  const scLen = buf[nal.start + 2] === 1 ? 3 : 4;
  const start = nal.start + scLen + 2; // skip start code + 2-byte NAL header
  const src = buf.subarray(start, nal.end);
  const out = new Uint8Array(src.length);
  let o = 0;
  let zeros = 0;
  for (let i = 0; i < src.length; i++) {
    const b = src[i]!;
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue; // drop emulation-prevention byte
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

class BitReader {
  private buf: Uint8Array;
  private pos = 0;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  bit(): number {
    const byte = this.buf[this.pos >> 3] ?? 0;
    const b = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v >>> 0;
  }
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0 && zeros < 32) zeros++;
    let v = 0;
    for (let i = 0; i < zeros; i++) v = (v << 1) | this.bit();
    return v + (1 << zeros) - 1;
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) >> 1 : -(k >> 1);
  }
}

function deriveFromSps(
  buf: Uint8Array,
  spsNal: Nal,
): { codecs: string[]; width: number; height: number } {
  try {
    const r = new BitReader(toRbsp(buf, spsNal));
    r.bits(4); // sps_video_parameter_set_id
    const maxSubLayersMinus1 = r.bits(3);
    r.bit(); // sps_temporal_id_nesting_flag

    // profile_tier_level(1, maxSubLayersMinus1)
    const generalProfileSpace = r.bits(2);
    r.bit(); // general_tier_flag
    const generalProfileIdc = r.bits(5);
    const compat = r.bits(32); // general_profile_compatibility_flags
    // general_constraint_indicator_flags (48 bits) — capture the first byte.
    const constraintByte = r.bits(8);
    r.bits(40);
    const generalLevelIdc = r.bits(8);

    // Sub-layer profile/level present flags.
    const subProfile: number[] = [];
    const subLevel: number[] = [];
    for (let i = 0; i < maxSubLayersMinus1; i++) {
      subProfile.push(r.bit());
      subLevel.push(r.bit());
    }
    if (maxSubLayersMinus1 > 0) {
      for (let i = maxSubLayersMinus1; i < 8; i++) r.bits(2);
    }
    for (let i = 0; i < maxSubLayersMinus1; i++) {
      if (subProfile[i]) r.bits(88);
      if (subLevel[i]) r.bits(8);
    }

    r.ue(); // sps_seq_parameter_set_id
    const chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) r.bit(); // separate_colour_plane_flag
    const width = r.ue();
    const height = r.ue();

    // Build codec string: hev1.PS.compat.Ltier.constraint...
    const prefix = generalProfileSpace === 0 ? "" : String.fromCharCode(65 + generalProfileSpace - 1);
    // compatibility flags are reversed-bit; comma uses Main (profile 1) → "6".
    const compatHex = reverseBits32(compat).toString(16).toUpperCase();
    const base = `${prefix}${generalProfileIdc}.${compatHex}.L${generalLevelIdc}.${constraintByte.toString(16).toUpperCase().padStart(2, "0")}`;
    const codecs = [`hev1.${base}`, `hvc1.${base}`];
    return { codecs, width, height };
  } catch {
    return { codecs: [], width: 0, height: 0 };
  }
}

function reverseBits32(v: number): number {
  let r = 0;
  for (let i = 0; i < 32; i++) {
    r = (r << 1) | (v & 1);
    v >>>= 1;
  }
  return r >>> 0;
}
