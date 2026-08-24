import {
  extrinsicsFromRpy,
  fullFrameToCanvas,
  projectPoints,
  type ScreenPoint,
} from "@/overlay/project";
import { hudScale, ss, sy, UI, type Rect } from "@/overlay/hudLayout";

function insetContent(c: Rect): Rect {
  const b = ss(c, UI.borderSize);
  return { x: c.x + b, y: c.y + b, w: c.w - 2 * b, h: c.h - 2 * b };
}
import { drawAlertToast, drawDeveloperUi, drawExpButton, drawRoadName, drawSpeedLimitSign, drawStatusBorder } from "@/overlay/hudChrome";
import { drawDriverFace } from "@/overlay/dmFace";
import {
  drawMiciAlert,
  drawMiciConfidence,
  drawMiciDriverMonitor,
  drawMiciBlindSpot,
  drawMiciBlinker,
  drawMiciSetSpeed,
  drawMiciTorqueBar,
  drawMiciWheel,
  drawTorqueBar,
  miciSetSpeedVisible,
  MICI_SIDE_PANEL,
  ms,
} from "@/overlay/miciChrome";
import type { OverlayFrame, OverlayLead, OverlayPainter, Vec3Path, Viewport } from "@/overlay/types";
import type { SunnypilotOverlaySettings } from "@/overlay/sunnypilotSettings";
import turnSignalLeftUrl from "@/overlay/icons/turn_signal_left.png";
import blindSpotLeftUrl from "@/overlay/icons/blind_spot_left.png";

const turnSignalImg = new Image();
turnSignalImg.src = turnSignalLeftUrl;
const blindSpotImg = new Image();
blindSpotImg.src = blindSpotLeftUrl;

const TURN_SIGNAL_PERIOD = 60 / 80;
const PATH_MAX = 100;
const LANE_HALF = 0.025;

function truncatePath(path: Vec3Path, maxX: number): Vec3Path {
  const n = path.x.length;
  if (n === 0) return path;
  let end = 0;
  for (let i = 0; i < n; i++) {
    if (path.x[i]! <= maxX) end = i;
  }
  if (end >= n - 1) return path;
  const next = Math.min(end + 1, n - 1);
  const x0 = path.x[end]!;
  const x1 = path.x[next]!;
  const t = x1 === x0 ? 0 : (maxX - x0) / (x1 - x0);
  const lerp = (a: number[], i: number, j: number) => a[i]! + (a[j]! - a[i]!) * t;
  return {
    x: [...path.x.slice(0, end + 1), maxX],
    y: [...path.y.slice(0, end + 1), lerp(path.y, end, next)],
    z: [...path.z.slice(0, end + 1), lerp(path.z, end, next)],
  };
}

function ribbonPairs(
  path: Vec3Path,
  frame: OverlayFrame,
  viewport: Viewport,
  halfWidth: number,
  zOff: number,
): { l: ScreenPoint; r: ScreenPoint }[] {
  const ext = extrinsicsFromRpy(frame.rpy);
  const n = Math.min(path.x.length, path.y.length, path.z.length);
  if (n < 2) return [];
  const leftY = new Array<number>(n);
  const rightY = new Array<number>(n);
  const zs = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    leftY[i] = path.y[i]! - halfWidth;
    rightY[i] = path.y[i]! + halfWidth;
    zs[i] = path.z[i]! + zOff;
  }
  const left = projectPoints(path.x, leftY, zs, ext);
  const right = projectPoints(path.x, rightY, zs, ext);
  const pairs: { l: ScreenPoint; r: ScreenPoint }[] = [];
  for (let i = 0; i < n; i++) {
    const lp = left[i];
    const rp = right[i];
    if (!lp || !rp) continue;
    pairs.push({
      l: fullFrameToCanvas(lp, viewport.content),
      r: fullFrameToCanvas(rp, viewport.content),
    });
  }
  return pairs;
}

function ribbonPolygon(
  path: Vec3Path,
  frame: OverlayFrame,
  viewport: Viewport,
  halfWidth: number,
  zOff: number,
): ScreenPoint[] | null {
  const pairs = ribbonPairs(path, frame, viewport, halfWidth, zOff);
  if (pairs.length < 2) return null;
  const poly: ScreenPoint[] = [];
  for (const p of pairs) poly.push(p.l);
  for (let i = pairs.length - 1; i >= 0; i--) poly.push(pairs[i]!.r);
  return poly;
}

function fillPathQuads(
  ctx: CanvasRenderingContext2D,
  path: Vec3Path,
  frame: OverlayFrame,
  viewport: Viewport,
  halfWidth: number,
  rainbow: boolean,
) {
  const pairs = ribbonPairs(path, frame, viewport, halfWidth, frame.height);
  if (pairs.length < 2) return;
  // Green throttle carpet when laterally active (MADS-aware), else neutral white.
  const latActive = frame.latActive;
  for (let i = 0; i < pairs.length - 1; i++) {
    const a = pairs[i]!;
    const b = pairs[i + 1]!;
    const t = i / (pairs.length - 1);
    let fill: string;
    if (rainbow) {
      const hue = (frame.t * 50 + t * 360) % 360;
      fill = `hsla(${hue}, 90%, 60%, ${0.55 * (1 - t * 0.35)})`;
    } else if (latActive) {
      fill = `rgba(${13 + t * 101}, ${248 + t * 7}, ${122 - t * 30}, ${0.48 * (1 - t * 0.55)})`;
    } else {
      fill = `rgba(242, 242, 242, ${0.32 * (1 - t * 0.5)})`;
    }
    ctx.beginPath();
    ctx.fillStyle = fill;
    ctx.moveTo(a.l.u, a.l.v);
    ctx.lineTo(b.l.u, b.l.v);
    ctx.lineTo(b.r.u, b.r.v);
    ctx.lineTo(a.r.u, a.r.v);
    ctx.closePath();
    ctx.fill();
  }
}

function fillPoly(ctx: CanvasRenderingContext2D, poly: ScreenPoint[], fill: string) {
  ctx.beginPath();
  ctx.fillStyle = fill;
  ctx.moveTo(poly[0]!.u, poly[0]!.v);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i]!.u, poly[i]!.v);
  ctx.closePath();
  ctx.fill();
}

function pathMaxDistance(frame: OverlayFrame): number {
  let max = PATH_MAX;
  const lead = frame.leads[0];
  if (lead && lead.prob > 0.5 && lead.x > 8) {
    const leadD = lead.x * 2;
    max = Math.max(10, Math.min(max, leadD - Math.min(leadD * 0.35, 10)));
  }
  return max;
}

function drawLeads(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  viewport: Viewport,
  chevronInfo = 0,
) {
  const ext = extrinsicsFromRpy(frame.rpy);
  const { content } = viewport;
  const s = hudScale(content);
  for (const lead of frame.leads) {
    const pts = projectPoints([lead.x], [-lead.y], [frame.height], ext);
    const p = pts[0];
    if (!p) continue;
    const scr = fullFrameToCanvas(p, content);
    const sz = Math.min(30, Math.max(15, (25 * 30) / (lead.x / 3 + 30))) * 2.35;
    const x = Math.min(Math.max(scr.u, content.x), content.x + content.w - sz / 2);
    const y = Math.min(scr.v, content.y + content.h - sz * 0.6);
    const gxo = sz / 5;
    const gyo = sz / 10;

    let fillA = 0;
    if (lead.x < 40) {
      fillA = 1 - lead.x / 40;
      if (lead.vRel < 0) fillA += -lead.vRel / 10;
      fillA = Math.min(fillA, 1);
    }

    ctx.beginPath();
    ctx.fillStyle = "rgb(218, 202, 37)";
    ctx.moveTo(x + sz * 1.35 + gxo, y + sz + gyo);
    ctx.lineTo(x, y - gyo);
    ctx.lineTo(x - sz * 1.35 - gxo, y + sz + gyo);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.fillStyle = `rgba(201, 34, 49, ${fillA})`;
    ctx.moveTo(x + sz * 1.25, y + sz);
    ctx.lineTo(x, y);
    ctx.lineTo(x - sz * 1.25, y + sz);
    ctx.closePath();
    ctx.fill();

    if (chevronInfo > 0) {
      drawChevronMetrics(ctx, frame, viewport, lead, x, y, sz, s);
    }
  }
}

function formatSpeed(ms: number, metric: boolean): string {
  if (metric) return String(Math.round(ms * 3.6));
  return String(Math.round(ms * 2.23694));
}

function drawChevronMetrics(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  viewport: Viewport,
  lead: OverlayLead,
  chevronX: number,
  chevronY: number,
  sz: number,
  s: number,
) {
  const metric = viewport.useMetric ?? true;
  const vEgo = frame.vEgo ?? 0;
  const mode = viewport.sunnypilot?.chevronInfo ?? 0;
  const lines: string[] = [];
  if (mode === 1 || mode === 4) {
    const d = metric ? lead.x : lead.x * 3.28084;
    lines.push(`${Math.round(Math.max(0, d))} ${metric ? "m" : "ft"}`);
  }
  if (mode === 2 || mode === 4) {
    const v = Math.max(0, vEgo + lead.vRel);
    lines.push(`${formatSpeed(v, metric)} ${metric ? "km/h" : "mph"}`);
  }
  if (mode === 3 || mode === 4) {
    const ttc = vEgo > 0 && lead.x > 0 ? lead.x / vEgo : 0;
    lines.push(ttc > 0 && ttc < 200 ? `${ttc.toFixed(1)} s` : "---");
  }
  if (!lines.length) return;

  const fontSize = 40 * s;
  const lineH = 50 * s;
  const margin = 20 * s;
  const { content } = viewport;
  let textY = chevronY + sz + 15 * s;
  const totalH = lines.length * lineH;
  if (textY + totalH > content.y + content.h - margin) {
    const yMax = Math.min(chevronY, content.y + content.h - margin);
    textY = Math.max(content.y + margin, yMax - 15 * s - totalH);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `600 ${fontSize}px Geist Variable, ui-sans-serif, sans-serif`;
  for (let i = 0; i < lines.length; i++) {
    const y = textY + i * lineH;
    ctx.fillStyle = "rgba(0,0,0,0.78)";
    ctx.fillText(lines[i]!, chevronX + 2 * s, y + 2 * s);
    ctx.fillStyle = "#fff";
    ctx.fillText(lines[i]!, chevronX, y);
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawHeaderGradient(ctx: CanvasRenderingContext2D, content: Viewport["content"]) {
  const h = ss(content, UI.headerHeight);
  const g = ctx.createLinearGradient(0, content.y, 0, content.y + h);
  g.addColorStop(0, "rgba(0, 0, 0, 0.447)");
  g.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(content.x, content.y, content.w, h);
}

function drawMaxBox(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
  metric: boolean,
  rightSide: boolean,
) {
  const boxW = ss(content, metric ? UI.setSpeedWidthMetric : UI.setSpeedWidthImperial);
  const boxH = ss(content, UI.setSpeedHeight);
  const imperialW = ss(content, UI.setSpeedWidthImperial);
  let x = content.x + ss(content, 60) + (imperialW - boxW) / 2;
  if (rightSide) x = content.x + content.w - ss(content, 60) - boxW - (imperialW - boxW) / 2;
  const y = sy(content, 45);

  const r = Math.min(boxW, boxH) * 0.35;
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  roundRect(ctx, x, y, boxW, boxH, r);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.294)";
  ctx.lineWidth = ss(content, 6);
  roundRect(ctx, x, y, boxW, boxH, r);
  ctx.stroke();

  const cruise = frame.cruiseSpeed;
  const set = cruise != null && cruise > 0;
  let maxColor = "rgb(166, 166, 166)";
  let setColor = "rgb(114, 114, 114)";
  if (set) {
    setColor = "#fff";
    maxColor = frame.engaged ? "rgb(128, 216, 166)" : "rgb(145, 155, 149)";
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = maxColor;
  ctx.font = `600 ${ss(content, UI.maxSpeed)}px Geist Variable, ui-sans-serif, sans-serif`;
  ctx.fillText("MAX", x + boxW / 2, y + ss(content, 27));
  ctx.fillStyle = setColor;
  ctx.font = `700 ${ss(content, UI.setSpeed)}px Geist Variable, ui-sans-serif, sans-serif`;
  ctx.fillText(set ? formatSpeed(cruise, metric) : "–", x + boxW / 2, y + ss(content, 77));
}

function drawSpeed(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
  metric: boolean,
) {
  if (frame.vEgo == null) return;
  const speed = formatSpeed(frame.vEgo, metric);
  const unit = metric ? "km/h" : "mph";
  const cx = content.x + content.w / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${ss(content, UI.currentSpeed)}px Geist Variable, ui-sans-serif, sans-serif`;
  ctx.fillText(speed, cx, sy(content, 180));
  ctx.fillStyle = "rgba(255, 255, 255, 0.784)";
  ctx.font = `500 ${ss(content, UI.speedUnit)}px Geist Variable, ui-sans-serif, sans-serif`;
  ctx.fillText(unit, cx, sy(content, 290));
}

type HudOpts = {
  metric: boolean;
  hideSpeed?: boolean;
  maxOnRight?: boolean;
};

function drawHud(ctx: CanvasRenderingContext2D, frame: OverlayFrame, viewport: Viewport, opts: HudOpts) {
  const { content } = viewport;
  drawHeaderGradient(ctx, content);
  drawMaxBox(ctx, frame, content, opts.metric, Boolean(opts.maxOnRight));
  if (!opts.hideSpeed) drawSpeed(ctx, frame, content, opts.metric);
  if (!opts.maxOnRight) drawExpButton(ctx, frame, content);
}

function drawIcon(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  flip: boolean,
  alpha: number,
) {
  if (!img.complete || img.naturalWidth === 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (flip) {
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0, w, h);
  } else {
    ctx.drawImage(img, x, y, w, h);
  }
  ctx.restore();
}

function turnAlpha(t: number): number {
  const phase = t % TURN_SIGNAL_PERIOD;
  return Math.min(1, Math.max(0.2, 1 - phase / (TURN_SIGNAL_PERIOD * 0.45)));
}

function paintSunnypilotExtras(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  viewport: Viewport,
  sp: SunnypilotOverlaySettings,
) {
  const { content } = viewport;
  const s = hudScale(content);
  const size = ss(content, 150);
  const iconW = ss(content, 120);
  const iconH = ss(content, 109);
  const cx = content.x + content.w / 2;
  const leftX = cx - ss(content, 80) - size;
  const rightX = cx + ss(content, 80);
  const iconY = sy(content, 190);

  const drawSide = (left: boolean) => {
    const bsm = left ? frame.leftBlindspot : frame.rightBlindspot;
    const blink = left ? frame.leftBlinker : frame.rightBlinker;
    const x = left ? leftX : rightX;
    const flip = !left;
    if (sp.blindSpot && bsm) {
      drawIcon(ctx, blindSpotImg, x + (size - iconW) / 2, iconY + (size - iconH) / 2, iconW, iconH, flip, 1);
      return;
    }
    if (sp.showTurnSignals && blink) {
      drawIcon(
        ctx,
        turnSignalImg,
        x + (size - iconW) / 2,
        iconY + (size - iconH) / 2,
        iconW,
        iconH,
        flip,
        turnAlpha(frame.t),
      );
    }
  };
  if (sp.blindSpot || sp.showTurnSignals) {
    drawSide(true);
    drawSide(false);
  }

  if (sp.rocketFuel) {
    const a = frame.aEgo;
    let hha = 0;
    if (a > 0) hha = 0.85 - 0.1 / a;
    else if (a < 0) hha = 0.85 + 0.1 / a;
    if (hha < 0) hha = 0;
    hha *= content.h;
    const wp = 28;
    const raY = a > 0 ? content.h / 2 - hha / 2 : content.h / 2;
    if (hha > 0) {
      ctx.fillStyle = a > 0 ? "rgba(0, 245, 0, 0.784)" : "rgba(245, 0, 0, 0.784)";
      ctx.fillRect(content.x, content.y + raY, wp, hha / 2);
    }
  }

  if (sp.torqueBar) {
    // Same TorqueBar as mici, at scale 3. Shown unless DISENGAGED or LONG_ONLY;
    // bar brightens/colors only when lateral is active (engaged or lat_only).
    drawTorqueBar(ctx, frame, content, 3 * s);
  }

  if (sp.standstillTimer && frame.standstill && frame.standstillDuration > 0.2) {
    const radius = ss(content, 250);
    const x = content.x + content.w - radius - ss(content, 100) - ss(content, UI.borderSize * 3);
    const y = content.y + content.h / 2 + ss(content, 20);
    ctx.beginPath();
    ctx.fillStyle = "rgba(0, 0, 0, 0.745)";
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.294)";
    ctx.lineWidth = ss(content, 15);
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();

    const secs = Math.floor(frame.standstillDuration);
    const timer = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255, 175, 3, 0.94)";
    ctx.font = `700 ${ss(content, 80)}px Geist Variable, ui-sans-serif, sans-serif`;
    ctx.fillText("STOPPED", x, y - radius / 3.5);
    ctx.fillStyle = "#fff";
    ctx.font = `700 ${ss(content, 100)}px Geist Variable, ui-sans-serif, sans-serif`;
    ctx.fillText(timer, x, y + radius / 4);
  }
}

function paintModel(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  viewport: Viewport,
  rainbow: boolean,
  chevronInfo: number,
) {
  const maxX = pathMaxDistance(frame);
  if (frame.path) {
    // Device _get_path_half_width: 0.9 when laterally active, else 0.40.
    const half = frame.latActive ? 0.9 : 0.4;
    fillPathQuads(ctx, truncatePath(frame.path, maxX), frame, viewport, half, rainbow);
  } else if (frame.laneLines.length >= 2) {
    const a = frame.laneLines[0]!;
    const b = frame.laneLines[1]!;
    const mid: Vec3Path = {
      x: a.path.x,
      y: a.path.y.map((y, i) => (y + (b.path.y[i] ?? y)) / 2),
      z: a.path.z,
    };
    fillPathQuads(ctx, truncatePath(mid, maxX), frame, viewport, 0.9, rainbow);
  }
  for (const edge of frame.roadEdges) {
    const alpha = Math.max(0, Math.min(1, 1 - edge.std));
    const poly = ribbonPolygon(truncatePath(edge.path, maxX), frame, viewport, LANE_HALF, frame.height);
    if (poly) fillPoly(ctx, poly, `rgba(255, 0, 0, ${alpha})`);
  }
  for (const lane of frame.laneLines) {
    const alpha = Math.max(0, Math.min(0.7, lane.prob));
    const poly = ribbonPolygon(
      truncatePath(lane.path, maxX),
      frame,
      viewport,
      LANE_HALF * lane.prob,
      frame.height,
    );
    if (poly) fillPoly(ctx, poly, `rgba(255, 255, 255, ${alpha})`);
  }
  drawLeads(ctx, frame, viewport, chevronInfo);
}

export const comma3xStock: OverlayPainter = {
  id: "comma3x-stock",
  label: "comma 3X stock",
  paint(ctx, frame, viewport) {
    if (viewport.content.w < 8 || viewport.content.h < 8) return;
    const ic = insetContent(viewport.content);
    const iv = { ...viewport, content: ic };
    paintModel(ctx, frame, viewport, false, 0);
    drawHud(ctx, frame, iv, { metric: viewport.useMetric ?? true });
    drawDriverFace(ctx, frame, ic);
    drawAlertToast(ctx, frame.alert, ic);
    drawStatusBorder(ctx, frame, viewport.content);
  },
};

export const comma3xSunnypilot: OverlayPainter = {
  id: "comma3x-sunnypilot",
  label: "comma 3X sunnypilot",
  paint(ctx, frame, viewport) {
    if (viewport.content.w < 8 || viewport.content.h < 8) return;
    const ic = insetContent(viewport.content);
    const iv = { ...viewport, content: ic };
    const metric = viewport.useMetric ?? true;
    const sp = viewport.sunnypilot;
    paintModel(ctx, frame, viewport, Boolean(sp?.rainbowMode), sp?.chevronInfo ?? 4);
    drawHud(ctx, frame, iv, {
      metric,
      hideSpeed: Boolean(sp?.hideVEgoUi),
    });
    drawRoadName(ctx, frame.roadName, ic);
    drawSpeedLimitSign(ctx, frame, ic, metric);
    if (sp) paintSunnypilotExtras(ctx, frame, iv, sp);
    drawDeveloperUi(ctx, frame, ic, sp?.devUiInfo ?? 0, metric);
    // Bottom dev UI (modes 1 & 3) lifts the driver monitor by 60 design px.
    const devUi = sp?.devUiInfo ?? 0;
    const bottomDev = devUi === 1 || devUi === 3;
    const dmContent = bottomDev ? { ...ic, h: ic.h - ss(ic, 60) } : ic;
    drawDriverFace(ctx, frame, dmContent);
    drawAlertToast(ctx, frame.alert, ic);
    drawStatusBorder(ctx, frame, viewport.content);
  },
};

export const comma4: OverlayPainter = {
  id: "comma4",
  label: "comma 4",
  paint(ctx, frame, viewport) {
    const full = viewport.content;
    if (full.w < 8 || full.h < 8) return;
    const metric = viewport.useMetric ?? true;
    const sp = viewport.sunnypilot;

    // The model projects into the FULL video content rect (same as the 3X and
    // the device) — the side panel is an overlay, not a reduction of the camera
    // view. Shrinking the projection rect here squished the road horizontally.
    // Model lane lines + path are hidden entirely while disengaged on mici
    // (uiStatus 0 = disengaged). lat_only/long_only/override still render.
    if (frame.uiStatus !== 0) paintModel(ctx, frame, viewport, false, 0);

    // HUD chrome is laid out within the content minus the right side panel.
    const panelW = ms(full, MICI_SIDE_PANEL);
    const content = { x: full.x, y: full.y, w: full.w - panelW, h: full.h };

    // Compute set-speed visibility once per frame; the device hides the driver
    // monitor whenever this top-left bubble is showing.
    const setSpeedVisible = miciSetSpeedVisible(frame);

    drawMiciTorqueBar(ctx, frame, content);
    drawMiciSetSpeed(ctx, frame, content, metric, setSpeedVisible);
    drawMiciWheel(ctx, frame, content);
    drawMiciDriverMonitor(ctx, frame, content, setSpeedVisible);
    // BCW warning when the blind-spot toggle is on.
    if (sp?.blindSpot) drawMiciBlindSpot(ctx, frame, content);

    // Blinker icons: shown during a lane-change alert (device default), or
    // always when the "always display blinker" toggle is on.
    const evt = frame.alert?.alertType?.split("/")[0] ?? "";
    const laneChangeAlert =
      evt === "preLaneChangeLeft" ||
      evt === "preLaneChangeRight" ||
      evt === "laneChange" ||
      evt === "laneChangeBlocked";
    const forceLeft = evt === "preLaneChangeLeft";
    const forceRight = evt === "preLaneChangeRight";
    const showBlinker = Boolean(sp?.alwaysDisplayBlinker) || laneChangeAlert;
    const blinkerLeft = showBlinker && (frame.leftBlinker || forceLeft);
    const blinkerRight = showBlinker && (frame.rightBlinker || forceRight);
    // Alert reserves space for the icon so text doesn't overlap it.
    const iconSide: "left" | "right" | null = blinkerLeft ? "left" : blinkerRight ? "right" : null;

    drawMiciAlert(ctx, frame.alert, content, iconSide);
    // Icons draw ON TOP of the alert bar (device draws icons after the bg).
    if (showBlinker) drawMiciBlinker(ctx, frame, content, forceLeft, forceRight);
    drawMiciConfidence(ctx, frame, full);
  },
};

export const PAINTERS: Record<string, OverlayPainter> = {
  "comma3x-stock": comma3xStock,
  "comma3x-sunnypilot": comma3xSunnypilot,
  comma4,
};
