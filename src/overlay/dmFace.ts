import { ss, UI } from "@/overlay/hudLayout";
import type { OverlayFrame, Viewport } from "@/overlay/types";
import faceUrl from "@/overlay/icons/driver_face.png";

const faceImg = new Image();
faceImg.decoding = "async";
faceImg.src = faceUrl;
void faceImg.decode().catch(() => undefined);

/** comma 3X driver-monitoring 3D face keypoints (design px), from driver_state.py. */
const FACE_KPTS: [number, number, number][] = [
  [-5.98, -51.2, 8], [-17.64, -49.14, 8], [-23.81, -46.4, 8], [-29.98, -40.91, 8],
  [-32.04, -37.49, 8], [-34.1, -32, 8], [-36.16, -21.03, 8], [-36.16, 6.4, 8],
  [-35.47, 10.51, 8], [-32.73, 19.43, 8], [-29.3, 26.29, 8], [-24.5, 33.83, 8],
  [-19.01, 41.37, 8], [-14.21, 46.17, 8], [-12.16, 47.54, 8], [-4.61, 49.6, 8],
  [4.99, 49.6, 8], [12.53, 47.54, 8], [14.59, 46.17, 8], [19.39, 41.37, 8],
  [24.87, 33.83, 8], [29.67, 26.29, 8], [33.1, 19.43, 8], [35.84, 10.51, 8],
  [36.53, 6.4, 8], [36.53, -21.03, 8], [34.47, -32, 8], [32.42, -37.49, 8],
  [30.36, -40.91, 8], [24.19, -46.4, 8], [18.02, -49.14, 8], [6.36, -51.2, 8],
  [-5.98, -51.2, 8],
];

const ARC_LENGTH = 133;
const ARC_THICK_DEFAULT = 6.7;
const ARC_THICK_EXTEND = 12;
const ARC_N = 37;

/**
 * comma 3X driver monitor: 3D face outline that rotates with head orientation,
 * plus horizontal/vertical arcs indicating head turn. Mirrors DriverStateRenderer.
 */
export function drawDriverFace(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
) {
  if (frame.alert?.size === 3) return;

  const btn = ss(content, UI.buttonSize);
  const offset = ss(content, UI.borderSize) + btn / 2;
  const cx = content.x + (frame.dmIsRHD ? content.w - offset : offset);
  const cy = content.y + content.h - offset;

  const active = frame.dmActive;
  const fade = active ? 0 : 0.5; // dm_fade_state target (no temporal smoothing in replay)
  const opacity = active ? 0.65 : 0.2;

  // background circle (device uses alpha 70/255 ≈ 0.27)
  ctx.beginPath();
  ctx.fillStyle = "rgba(0, 0, 0, 0.27)";
  ctx.arc(cx, cy, btn / 2, 0, Math.PI * 2);
  ctx.fill();

  // face icon
  if (faceImg.complete && faceImg.naturalWidth > 0) {
    const icon = ss(content, UI.wheelIcon);
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.drawImage(faceImg, cx - icon / 2, cy - icon / 2, icon, icon);
    ctx.restore();
  }

  // Pose is already smoothed + scaled at index time (driver_pose_vals).
  // rotation_amount = vals * (1 - fade); compute sin/cos.
  const rot = frame.dmPoseVals.map((v) => v * (1 - fade));
  const sins = rot.map(Math.sin);
  const coss = rot.map(Math.cos);
  const [sinY, sinX, sinZ] = sins as [number, number, number];
  const [cosY, cosX, cosZ] = coss as [number, number, number];

  // Rotation matrix (row-major), same as device r_xyz.
  const r = [
    [cosX * cosZ, cosX * sinZ, -sinX],
    [-sinY * sinX * cosZ - cosY * sinZ, -sinY * sinX * sinZ + cosY * cosZ, -sinY * cosX],
    [cosY * sinX * cosZ - sinY * sinZ, cosY * sinX * sinZ + sinY * cosZ, cosY * cosX],
  ];

  const scale = ss(content, 1);
  const pts: [number, number][] = FACE_KPTS.map(([x, y, z]) => {
    // face_kpts_draw = KPTS @ r.T  → per-row dot with r rows.
    const rx = x * r[0]![0]! + y * r[0]![1]! + z * r[0]![2]!;
    const ry = x * r[1]![0]! + y * r[1]![1]! + z * r[1]![2]!;
    let rz = x * r[2]![0]! + y * r[2]![1]! + z * r[2]![2]!;
    rz = rz * (1 - fade) + 8 * fade;
    const depth = (rz - 8) / 120 + 1;
    return [cx + rx * depth * scale, cy + ry * depth * scale];
  });

  // face outline
  ctx.strokeStyle = `rgba(255, 255, 255, ${opacity})`;
  ctx.lineWidth = 5.2 * scale;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
  ctx.stroke();

  // arcs — green whenever lateral is active (engaged or MADS lat-only), grey otherwise.
  const arcColor = frame.latActive ? [26, 242, 66] : [139, 139, 139];
  const arcAlpha = 0.4 * (1 - fade);
  const stroke = `rgba(${arcColor[0]}, ${arcColor[1]}, ${arcColor[2]}, ${arcAlpha})`;

  // Device: delta_x uses driver_pose_sins[1] (sinX), delta_y uses [0] (sinY);
  // arc thickness grows with driver_pose_diff[1]/[0].
  const arcLen = ARC_LENGTH * scale;
  const deltaX = (-sinX * arcLen) / 2;
  const deltaY = (-sinY * arcLen) / 2;

  drawArc(ctx, {
    delta: deltaX,
    size: Math.abs(deltaX),
    x: cx,
    y: cy - arcLen / 2,
    sinVal: sinX,
    diff: frame.dmPoseDiff[1]!,
    horizontal: true,
    arcLen,
    scale,
    stroke,
  });
  drawArc(ctx, {
    delta: deltaY,
    size: Math.abs(deltaY),
    x: cx - arcLen / 2,
    y: cy,
    sinVal: sinY,
    diff: frame.dmPoseDiff[0]!,
    horizontal: false,
    arcLen,
    scale,
    stroke,
  });
}

function drawArc(
  ctx: CanvasRenderingContext2D,
  o: {
    delta: number;
    size: number;
    x: number;
    y: number;
    sinVal: number;
    diff: number;
    horizontal: boolean;
    arcLen: number;
    scale: number;
    stroke: string;
  },
) {
  if (o.size <= 0) return;
  const thickness = (ARC_THICK_DEFAULT + ARC_THICK_EXTEND * Math.min(1, o.diff * 5)) * o.scale;
  const startDeg = o.horizontal ? (o.sinVal > 0 ? 90 : -90) : o.sinVal > 0 ? 0 : 180;
  const x = o.horizontal ? Math.min(o.x + o.delta, o.x) : o.x;
  const y = o.horizontal ? o.y : Math.min(o.y + o.delta, o.y);
  const width = o.horizontal ? o.size : o.arcLen;
  const height = o.horizontal ? o.arcLen : o.size;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const radiusX = width / 2;
  const radiusY = height / 2;

  ctx.strokeStyle = o.stroke;
  ctx.lineWidth = thickness;
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < ARC_N; i++) {
    const ang = (i / (ARC_N - 1)) * Math.PI + (startDeg * Math.PI) / 180;
    const px = centerX + Math.cos(ang) * radiusX;
    const py = centerY - Math.sin(ang) * radiusY;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}
