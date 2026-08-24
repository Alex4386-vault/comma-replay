import type { OverlayAlert, OverlayFrame, Viewport } from "@/overlay/types";
import { wrapText } from "@/overlay/wrapText";
import wheelUrl from "@/overlay/icons/mici/wheel.png";
import dmPersonUrl from "@/overlay/icons/mici/dm_person.png";
import dmConeUrl from "@/overlay/icons/mici/dm_cone.png";
import turnSignalUrl from "@/overlay/icons/mici/turn_signal_left.png";
import blindSpotUrl from "@/overlay/icons/mici/blind_spot_left.png";

/** comma 4 (mici) onroad HUD is laid out for 536×240. Scale into the content rect. */
export const MICI_DESIGN_W = 536;
export const MICI_DESIGN_H = 240;
/** Right-side panel reserved for the confidence dot. */
export const MICI_SIDE_PANEL = 60;

/**
 * Uniform fit-scale: the mici screen (536×240, ~2.23:1) rarely matches the
 * qcamera content aspect, so scale design px by the smaller of the two ratios
 * to keep elements proportional and prevent horizontal/vertical overflow.
 */
export function miciScale(content: Viewport["content"]): number {
  return Math.min(content.w / MICI_DESIGN_W, content.h / MICI_DESIGN_H);
}

export function ms(content: Viewport["content"], n: number): number {
  return n * miciScale(content);
}

function loadImg(src: string): HTMLImageElement {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  void img.decode().catch(() => undefined);
  return img;
}

const wheelImg = loadImg(wheelUrl);
const dmPersonImg = loadImg(dmPersonUrl);
const dmConeImg = loadImg(dmConeUrl);
const turnSignalImg = loadImg(turnSignalUrl);
const blindSpotImg = loadImg(blindSpotUrl);

const TURN_SIGNAL_BLINK_PERIOD = 60 / 80; // Mazda heartbeat BPM

/** Offscreen canvas for tinting the cone without touching the main canvas. */
let tintCanvas: HTMLCanvasElement | null = null;
function tintedCone(size: number, r: number, g: number, b: number): HTMLCanvasElement | null {
  if (!dmConeImg.complete || dmConeImg.naturalWidth === 0) return null;
  const s = Math.max(1, Math.ceil(size));
  if (!tintCanvas) tintCanvas = document.createElement("canvas");
  tintCanvas.width = s;
  tintCanvas.height = s;
  const tctx = tintCanvas.getContext("2d");
  if (!tctx) return null;
  tctx.clearRect(0, 0, s, s);
  tctx.drawImage(dmConeImg, 0, 0, s, s);
  tctx.globalCompositeOperation = "source-in";
  tctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  tctx.fillRect(0, 0, s, s);
  return tintCanvas;
}

/** mici ALERT_COLORS: normal=black, userPrompt=orange, critical=red. */
const MICI_ALERT_RGB: Record<0 | 1 | 2, [number, number, number]> = {
  0: [0, 0, 0],
  1: [255, 115, 0],
  2: [255, 0, 21],
};

const FONT = "Geist Variable, ui-sans-serif, sans-serif";

const ALERT_MARGIN = 18;

/**
 * mici alert: a top-anchored gradient bar (solid top 20%, fading to transparent),
 * lowercase left-aligned text. Not the 3X bottom rounded toast.
 */
export function drawMiciAlert(
  ctx: CanvasRenderingContext2D,
  alert: OverlayAlert | null,
  content: Viewport["content"],
  iconSide: "left" | "right" | null = null,
) {
  if (!alert) return;
  const [r, g, b] = MICI_ALERT_RGB[alert.status];
  const x = content.x;
  const y = content.y;
  const w = content.w;
  const h = content.h;
  // Reserve space for a turn-signal icon so text doesn't overlap it. The icon
  // occupies ~104 design px in the corresponding top corner.
  const iconW = iconSide ? ms(content, 104 + 8) : 0;

  // bg_height by size: small=0.583, mid=0.833, full=1.0 (device keys off event type).
  const frac = alert.size === 1 ? 0.583 : alert.size === 2 ? 0.833 : 1;
  const bgH = Math.round(h * frac);
  const solidH = Math.round(bgH * 0.2);
  const topA = 0.9;

  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${topA})`;
  ctx.fillRect(x, y, w, solidH);
  const grad = ctx.createLinearGradient(0, y + solidH, 0, y + bgH);
  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${topA})`);
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(x, y + solidH, w, bgH - solidH);

  const text1 = alert.text1.toLowerCase();
  // Device: <=12 → 82, <=16 → 70, else 54 (design px). Icon reduces size a step.
  let size1 = text1.length <= 12 ? 82 : text1.length <= 16 ? 70 : 54;
  if (iconSide) size1 = Math.max(44, size1 - 10);
  // Left icon pushes text right; right/left icon both shrink the text column.
  const tx = x + ms(content, ALERT_MARGIN) + (iconSide === "left" ? iconW : 0);
  const wrapW = w - ms(content, ALERT_MARGIN) * 2 - iconW;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  const f1 = ms(content, size1);
  ctx.font = `700 ${f1}px ${FONT}`;
  const lines1 = wrapText(ctx, text1, wrapW);
  let y1 = y + ms(content, size1 >= 70 ? 11 : 4);
  for (const ln of lines1) {
    ctx.fillText(ln, tx, y1);
    y1 += f1 * 0.86;
  }

  if (alert.text2) {
    const text2 = alert.text2.toLowerCase();
    const size2 = text2.length > 24 ? 32 : text2.length > 18 ? 36 : 40;
    ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
    const f2 = ms(content, size2);
    ctx.font = `400 ${f2}px ${FONT}`;
    let y2 = y1;
    for (const ln of wrapText(ctx, text2, wrapW)) {
      ctx.fillText(ln, tx, y2);
      y2 += f2 * 0.86;
    }
  }
}

function formatSpeed(ms_: number, metric: boolean): string {
  return String(Math.round(metric ? ms_ * 3.6 : ms_ * 2.23694));
}

const SET_SPEED_PERSISTENCE = 2.5; // seconds
// Tracks set-speed changes across frames to replicate the device's transient
// bubble (shows on change / newly engaged, then fades after 2.5s).
let lastSetSpeed = -1;
let lastEngaged = false;
let setSpeedChangedT = -1e9;

/**
 * Whether the set-speed bubble is currently visible. Advances the change-
 * tracking state, so call exactly once per frame. The device hides the driver
 * monitor whenever this "top icon" is showing, so the painter uses the result
 * to gate the DMoji too.
 */
export function miciSetSpeedVisible(frame: OverlayFrame): boolean {
  const engaged = Boolean(frame.engaged);
  const setSpeed = frame.cruiseSpeed != null && frame.cruiseSpeed > 0 ? Math.round(frame.cruiseSpeed) : -1;
  const changed = setSpeed !== lastSetSpeed || (engaged && !lastEngaged);
  if (changed && engaged) setSpeedChangedT = frame.t;
  lastSetSpeed = setSpeed;
  lastEngaged = engaged;

  const dt = frame.t - setSpeedChangedT;
  return engaged && setSpeed > 0 && dt >= 0 && dt < SET_SPEED_PERSISTENCE;
}

/**
 * mici set-speed bubble (top-left). Only appears when the set speed changes or
 * cruise is newly engaged, then disappears after SET_SPEED_PERSISTENCE seconds,
 * matching the device HudRenderer._draw_set_speed. `visible` is precomputed by
 * the painter via miciSetSpeedVisible.
 */
export function drawMiciSetSpeed(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
  metric: boolean,
  visible: boolean,
) {
  if (!visible) return;

  const x = content.x;
  const y = content.y;
  const r = ms(content, 162) / 2;

  // radial drop shadow
  const grad = ctx.createRadialGradient(x + r, y + r, 0, x + r, y + r, r);
  grad.addColorStop(0, "rgba(0, 0, 0, 0.5)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, r * 2, r * 2);

  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = `800 ${ms(content, 112)}px ${FONT}`;
  ctx.fillText(formatSpeed(frame.cruiseSpeed, metric), x + ms(content, 17), y - ms(content, 8));

  ctx.font = `600 ${ms(content, 36)}px ${FONT}`;
  ctx.fillText("MAX", x + ms(content, 25), y + ms(content, 109));
}

/**
 * mici steering wheel (bottom-left). Rotates with steering angle, faded to 0.9
 * alpha when engaged, hidden (alpha 0) when disengaged or a blind spot is active.
 */
export function drawMiciWheel(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
) {
  const img = wheelImg;
  if (!img.complete || img.naturalWidth === 0) return;
  const size = ms(content, 50);
  // Device hides the wheel when status is DISENGAGED or a blind spot is active.
  const bsm = frame.leftBlindspot || frame.rightBlindspot;
  const hidden = frame.uiStatus === 0 || bsm;
  const alpha = hidden ? 0 : 0.9;
  if (alpha <= 0.01) return;

  const cx = content.x + ms(content, 21) + size / 2;
  const cy = content.y + content.h - ms(content, 14) - size / 2;
  const rot = (-frame.steeringAngleDeg * Math.PI) / 180;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.drawImage(img, -size / 2, -size / 2, size, size);
  ctx.restore();
}

/**
 * mici confidence ball on the right side panel. Vertical position tracks the
 * model confidence; color reflects engagement/confidence zone.
 */
export function drawMiciConfidence(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
) {
  const panelW = ms(content, MICI_SIDE_PANEL);
  const px = content.x + content.w - panelW;
  const r = ms(content, 24);
  const status = frame.uiStatus;
  const engaged = status === 1;
  const latOrLong = status === 3 || status === 4;
  const override = status === 2;
  // confidence in [-0.5, 1]; -0.5 parks the dot below-screen when disengaged.
  const conf = frame.confidence ?? (status !== 0 ? 1 : -0.5);
  const c = Math.max(-0.5, Math.min(1, status === 0 ? -0.5 : conf));
  const dotY = content.y + (1 - c) * (content.h - 2 * r) + r;
  const dotX = px + panelW - r;

  let top: string;
  let bottom: string;
  if (engaged) {
    if (c > 0.5) {
      top = "rgb(0, 255, 204)";
      bottom = "rgb(0, 255, 38)";
    } else if (c > 0.2) {
      top = "rgb(255, 200, 0)";
      bottom = "rgb(255, 115, 0)";
    } else {
      top = "rgb(255, 0, 21)";
      bottom = "rgb(255, 0, 89)";
    }
  } else if (latOrLong) {
    // MADS lat/long-only: solid teal-green dot.
    top = bottom = "rgb(0, 255, 128)";
  } else if (override) {
    top = "rgb(255, 255, 255)";
    bottom = "rgb(82, 82, 82)";
  } else {
    top = "rgb(50, 50, 50)";
    bottom = "rgb(13, 13, 13)";
  }

  const grad = ctx.createLinearGradient(0, dotY - r, 0, dotY + r);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  ctx.beginPath();
  ctx.fillStyle = grad;
  ctx.arc(dotX, dotY, r, 0, Math.PI * 2);
  ctx.fill();
}

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, u));
}

const TORQUE_ANGLE_SPAN = 12.7;

/**
 * Shared torque/steering bar (device TorqueBar). A large-radius curved arc
 * anchored to bottom-center that rises with |torque|; a filled sub-arc grows
 * left/right with torque sign, fading toward orange near saturation, with a
 * center dot when |torque| < 0.5. Used by both mici (scale≈fit) and the 3X HUD
 * (scale = 3·hudScale). Visible unless DISENGAGED/LONG_ONLY; only brightens when
 * lateral is active (engaged or MADS lat_only).
 */
export function drawTorqueBar(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
  scale: number,
) {
  const visible = frame.uiStatus !== 0 && frame.uiStatus !== 4;
  if (!visible) return;
  const latEngaged = frame.uiStatus === 1 || frame.uiStatus === 3;

  // Device filters on -actuatorsOutput.torque (positive torque steers left).
  const torque = Math.max(-1, Math.min(1, -frame.actuatorsTorque));
  const at = Math.abs(torque);

  const offset = lerp(22, 26, (at - 0.5) / 0.5) * scale;
  const height = lerp(14, 56, (at - 0.5) / 0.5) * scale;
  const radius = 1200 * scale;
  const midR = radius + height / 2;

  const cx = content.x + content.w / 2 + 8 * scale;
  const cy = content.y + content.h + radius - offset;

  const topAngle = -Math.PI / 2;
  // Background span animates from 0 (invisible) up to full when lateral active.
  const spanRad = ((latEngaged ? 1 : 0.15) * TORQUE_ANGLE_SPAN * Math.PI) / 180;

  const bgAlpha = latEngaged ? lerp(0.25, 0.5, (at - 0.5) / 0.5) : 0.15;
  drawArcBar(ctx, cx, cy, midR, height, topAngle - spanRad / 2, topAngle + spanRad / 2, `rgba(255,255,255,${bgAlpha})`);

  // filled sub-arc from center out toward torque direction
  const a1 = topAngle + (spanRad / 2) * torque;
  const sat = Math.max(0, at - 0.75) * 4;
  const gg = latEngaged ? Math.round(lerp(255, 115, sat)) : 255;
  const bb = latEngaged ? Math.round(lerp(255, 0, sat)) : 255;
  const barAlpha = latEngaged ? 0.9 : 0.35;
  drawArcBar(ctx, cx, cy, midR, height, topAngle, a1, `rgba(255,${gg},${bb},${barAlpha})`);

  // center dot
  if (at < 0.5) {
    const dotY = content.y + content.h - offset - height / 2;
    ctx.beginPath();
    ctx.fillStyle = `rgba(182, 182, 182, ${latEngaged ? 0.9 : 0.35})`;
    ctx.arc(cx, dotY, 5 * scale, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** mici torque bar: shared bar at the uniform mici fit-scale. */
export function drawMiciTorqueBar(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
) {
  drawTorqueBar(ctx, frame, content, miciScale(content));
}

const DM_CONE_GREEN: [number, number, number] = [0, 255, 64];
const DM_CONE_ORANGE: [number, number, number] = [255, 115, 0];

/**
 * mici driver monitor (top-left): dm_person face plus a head-direction cone.
 * Cone rotates with head pose (atan2(pitch*2, yaw)) and fades green→orange as
 * awareness drops. Face dims to 0.35 when DM is inactive. Hidden during alerts
 * and whenever the top-left set-speed bubble occupies the same corner.
 */
export function drawMiciDriverMonitor(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
  topIconsVisible: boolean,
) {
  if (frame.alert || topIconsVisible) return;

  const base = ms(content, 60);
  const x = content.x + ms(content, 16);
  const y = content.y + ms(content, 10);
  // The person logo is always drawn (greyed out when DM isn't actively tracking
  // an attentive face); only the direction cone depends on active detection.
  const active = frame.dmActive;
  const faceA = active && frame.dmFaceDetected ? 1 : 0.35;

  if (dmPersonImg.complete && dmPersonImg.naturalWidth > 0) {
    const ps = ms(content, 52);
    ctx.save();
    ctx.globalAlpha = 0.9 * faceA;
    ctx.drawImage(dmPersonImg, x + (base - ps) / 2, y + (base - ps) / 2, ps, ps);
    ctx.restore();
  }

  if (active && frame.dmFaceDetected) {
    const cs = ms(content, 52);
    const green = frame.dmAwarenessUnfull ? 0 : 1;
    const r = Math.round(DM_CONE_GREEN[0] * green + DM_CONE_ORANGE[0] * (1 - green));
    const g = Math.round(DM_CONE_GREEN[1] * green + DM_CONE_ORANGE[1] * (1 - green));
    const b = Math.round(DM_CONE_GREEN[2] * green + DM_CONE_ORANGE[2] * (1 - green));
    const cone = tintedCone(cs, r, g, b);
    if (cone) {
      const cx = x + base / 2;
      const cy = y + base / 2;
      // rotation = atan2(pitch*2, yaw); cone drawn at rotation - 90°.
      const rotation = Math.atan2(frame.dmFacePitch * 2, frame.dmFaceYaw);
      ctx.save();
      ctx.globalAlpha = faceA;
      ctx.translate(cx, cy);
      ctx.rotate(rotation - Math.PI / 2);
      ctx.drawImage(cone, -cs / 2, -cs / 2, cs, cs);
      ctx.restore();
    }
  }
}

/**
 * mici blind-spot warning icons (BCW). Drawn in the top-left/right when the
 * blindSpot toggle is on and carState reports a blind-spot vehicle.
 */
export function drawMiciBlindSpot(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
) {
  if (!blindSpotImg.complete || blindSpotImg.naturalWidth === 0) return;
  const w = ms(content, 108);
  const h = ms(content, 128);
  const marginX = ms(content, 20);
  const y = content.y + ms(content, 100);
  if (frame.leftBlindspot) {
    ctx.drawImage(blindSpotImg, content.x + marginX, y, w, h);
  }
  if (frame.rightBlindspot) {
    drawFlipped(ctx, blindSpotImg, content.x + content.w - marginX - w, y, w, h);
  }
}

/**
 * mici turn-signal icons. The device only shows these during a lane-change
 * alert; the "always display blinker" toggle shows them whenever the blinker
 * is on. Icons blink on the Mazda-heartbeat cadence. `forceLeft`/`forceRight`
 * (from a preLaneChange event) draw the arrow even if the raw blinker flag has
 * already dropped.
 */
export function drawMiciBlinker(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
  forceLeft = false,
  forceRight = false,
) {
  if (!turnSignalImg.complete || turnSignalImg.naturalWidth === 0) return;
  const left = frame.leftBlinker || forceLeft;
  const right = frame.rightBlinker || forceRight;
  if (!left && !right) return;
  const w = ms(content, 104);
  const h = ms(content, 96);
  const marginX = ms(content, 2);
  const y = content.y + ms(content, 10);
  // Blink cadence: on for the first ~40% of each period.
  const phase = frame.t % TURN_SIGNAL_BLINK_PERIOD;
  const on = phase < TURN_SIGNAL_BLINK_PERIOD * 0.4;
  const alpha = on ? 1 : 0.2;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (left) {
    ctx.drawImage(turnSignalImg, content.x + marginX, y, w, h);
  }
  if (right) {
    drawFlipped(ctx, turnSignalImg, content.x + content.w - marginX - w, y, w, h);
  }
  ctx.restore();
}

function drawFlipped(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  ctx.save();
  ctx.translate(x + w, y);
  ctx.scale(-1, 1);
  ctx.drawImage(img, 0, 0, w, h);
  ctx.restore();
}

/** Filled thick arc between two angles (radians), centered at (cx,cy). */
/** Thick arc drawn as a round-capped stroke along the mid radius. */
function drawArcBar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  midR: number,
  thickness: number,
  a0: number,
  a1: number,
  stroke: string,
) {
  const lo = Math.min(a0, a1);
  const hi = Math.max(a0, a1);
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = thickness;
  ctx.lineCap = "round";
  // Guarantee a visible dot even at zero span (rounded cap needs a tiny arc).
  ctx.arc(cx, cy, midR, lo, Math.max(hi, lo + 1e-3), false);
  ctx.stroke();
  ctx.restore();
}
