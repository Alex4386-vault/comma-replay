/**
 * Device-frame → screen projection (port of tools/replay Calibration +
 * common/transformations/camera view_frame_from_device_frame).
 *
 * Device: x forward, y right, z down
 * View:   x right,  y down,   z forward
 */

const VIEW_FROM_DEVICE: number[][] = [
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 0],
];

let cachedRpy: [number, number, number] | null = null;
let cachedExt: number[][] = VIEW_FROM_DEVICE;

/**
 * Narrow/road camera (qcamera is a downscale of this).
 * OX03C10 / AR0231 on comma 3X–4: 1928×1208, fx≈2648.
 */
export const DEFAULT_INTRINSIC = {
  width: 1928,
  height: 1208,
  fx: 2648,
  fy: 2648,
};

export type Intrinsic = typeof DEFAULT_INTRINSIC;

/** XYZ intrinsic euler → 3×3 rotation (matches openpilot euler2rot convention). */
export function euler2rot(roll: number, pitch: number, yaw: number): number[][] {
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return [
    [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
    [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
    [-sp, cp * sr, cp * cr],
  ];
}

function matMul3(a: number[][], b: number[][]): number[][] {
  const out: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i]![j] = a[i]![0]! * b[0]![j]! + a[i]![1]! * b[1]![j]! + a[i]![2]! * b[2]![j]!;
    }
  }
  return out;
}

export function extrinsicsFromRpy(rpy: [number, number, number] | null): number[][] {
  if (!rpy) return VIEW_FROM_DEVICE;
  if (cachedRpy === rpy) return cachedExt;
  cachedRpy = rpy;
  cachedExt = matMul3(VIEW_FROM_DEVICE, euler2rot(rpy[0], rpy[1], rpy[2]));
  return cachedExt;
}

export type ScreenPoint = { u: number; v: number };

/** Project device-frame points into full-frame pixel coords. */
export function projectPoints(
  xs: number[],
  ys: number[],
  zs: number[],
  extrinsics: number[][],
  K: Intrinsic = DEFAULT_INTRINSIC,
): (ScreenPoint | null)[] {
  const out: (ScreenPoint | null)[] = [];
  const n = Math.min(xs.length, ys.length, zs.length);
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    const z = zs[i]!;
    const ex = extrinsics[0]![0]! * x + extrinsics[0]![1]! * y + extrinsics[0]![2]! * z;
    const ey = extrinsics[1]![0]! * x + extrinsics[1]![1]! * y + extrinsics[1]![2]! * z;
    const ez = extrinsics[2]![0]! * x + extrinsics[2]![1]! * y + extrinsics[2]![2]! * z;
    if (!(ez > 0.1)) {
      out.push(null);
      continue;
    }
    const u = (K.fx * ex) / ez + K.width / 2;
    const v = (K.fy * ey) / ez + K.height / 2;
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      out.push(null);
      continue;
    }
    out.push({ u, v });
  }
  return out;
}

/** Map full-frame pixels into the letterboxed content rect on the canvas. */
export function fullFrameToCanvas(
  pt: ScreenPoint,
  content: { x: number; y: number; w: number; h: number },
  K: Intrinsic = DEFAULT_INTRINSIC,
): ScreenPoint {
  return {
    u: content.x + (pt.u / K.width) * content.w,
    v: content.y + (pt.v / K.height) * content.h,
  };
}

/** object-contain letterbox for a video frame inside a canvas. */
export function contentRect(
  canvasW: number,
  canvasH: number,
  videoW: number,
  videoH: number,
): { x: number; y: number; w: number; h: number } {
  if (videoW <= 0 || videoH <= 0) {
    return { x: 0, y: 0, w: canvasW, h: canvasH };
  }
  const scale = Math.min(canvasW / videoW, canvasH / videoH);
  const w = videoW * scale;
  const h = videoH * scale;
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h };
}
