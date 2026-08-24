import { hudScale, ss, sy, UI } from "@/overlay/hudLayout";
import type { OverlayAlert, OverlayFrame, Viewport } from "@/overlay/types";
import { wrapText } from "@/overlay/wrapText";
import wheelUrl from "@/overlay/icons/chffr_wheel.png";
import expUrl from "@/overlay/icons/experimental.png";

function load(src: string): HTMLImageElement {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  void img.decode().catch(() => undefined);
  return img;
}

const wheelImg = load(wheelUrl);
const expImg = load(expUrl);

const ALERT_FILL: Record<0 | 1 | 2, string> = {
  0: "rgba(21, 21, 21, 0.945)",
  1: "rgba(218, 111, 37, 0.945)",
  2: "rgba(201, 34, 49, 0.945)",
};

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

export function drawExpButton(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
) {
  const size = ss(content, UI.buttonSize);
  const icon = ss(content, UI.wheelIcon);
  const x = content.x + content.w - ss(content, UI.borderSize) - size;
  const y = content.y + ss(content, UI.borderSize);
  const cx = x + size / 2;
  const cy = y + size / 2;

  ctx.beginPath();
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.fill();

  const img = frame.experimentalMode ? expImg : wheelImg;
  if (!img.complete || img.naturalWidth === 0) return;
  ctx.save();
  ctx.globalAlpha = frame.engageable || frame.engaged ? 1 : 180 / 255;
  ctx.drawImage(img, cx - icon / 2, cy - icon / 2, icon, icon);
  ctx.restore();
}

export function drawAlertToast(
  ctx: CanvasRenderingContext2D,
  alert: OverlayAlert | null,
  content: Viewport["content"],
) {
  if (!alert) return;
  const s = hudScale(content);
  const font = "Geist Variable, ui-sans-serif, sans-serif";

  const lineSpacing = 45 * s;

  if (alert.size === 3) {
    ctx.fillStyle = ALERT_FILL[alert.status];
    ctx.fillRect(content.x, content.y, content.w, content.h);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const cx = content.x + content.w / 2;
    const wrapW = content.w - ss(content, UI.alertPadding) * 2;
    const long = alert.text1.length > 15 || alert.text1.includes("\n");
    const f1 = ss(content, long ? 132 : 177);
    ctx.font = `700 ${f1}px ${font}`;
    const lines1 = wrapText(ctx, alert.text1, wrapW);
    let ty = content.y + ss(content, long ? 200 : 270);
    for (const ln of lines1) {
      ctx.fillText(ln, cx, ty);
      ty += f1;
    }
    if (alert.text2) {
      const f2 = ss(content, UI.alertFontBig);
      ctx.font = `500 ${f2}px ${font}`;
      const lines2 = wrapText(ctx, alert.text2, wrapW);
      let by = content.y + content.h - ss(content, long ? 361 : 420);
      for (const ln of lines2) {
        ctx.fillText(ln, cx, by);
        by += f2;
      }
    }
    return;
  }

  const m = ss(content, UI.alertMargin);
  const pad = ss(content, UI.alertPadding);
  const w = content.w - m * 2;
  const wrapW = w - pad * 2;
  const x = content.x + m;
  const cx = x + w / 2;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";

  if (alert.size === 1) {
    const fs = ss(content, UI.alertFontMedium);
    ctx.font = `700 ${fs}px ${font}`;
    const lines = wrapText(ctx, alert.text1, wrapW);
    const lineH = fs;
    const textH = lines.length * lineH;
    // Dynamic height grows to fit wrapped lines (device _calculate_dynamic_height).
    const boxH = Math.max(ss(content, UI.alertSmallH), pad * 2 + textH + m * 2);
    const y = content.y + content.h - boxH + m;
    const h = boxH - m * 2;
    ctx.fillStyle = ALERT_FILL[alert.status];
    roundRect(ctx, x, y, w, h, ss(content, UI.alertRadius));
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "top";
    ctx.font = `700 ${fs}px ${font}`;
    let ty = y + (h - textH) / 2;
    for (const ln of lines) {
      ctx.fillText(ln, cx, ty);
      ty += lineH;
    }
    return;
  }

  // size 2 (mid): wrapped bold text1 + regular text2, centered vertically.
  const f1 = ss(content, UI.alertFontBig);
  const f2 = ss(content, UI.alertFontSmall);
  ctx.font = `700 ${f1}px ${font}`;
  const lines1 = wrapText(ctx, alert.text1, wrapW);
  ctx.font = `500 ${f2}px ${font}`;
  const lines2 = alert.text2 ? wrapText(ctx, alert.text2, wrapW) : [];
  const textH = lines1.length * f1 + (lines2.length ? lineSpacing + lines2.length * f2 : 0);
  const boxH = Math.max(ss(content, UI.alertMidH), pad * 2 + textH + m * 2);
  const y = content.y + content.h - boxH + m;
  const h = boxH - m * 2;
  ctx.fillStyle = ALERT_FILL[alert.status];
  roundRect(ctx, x, y, w, h, ss(content, UI.alertRadius));
  ctx.fill();

  ctx.fillStyle = "#fff";
  ctx.textBaseline = "top";
  let ty = y + (h - textH) / 2;
  ctx.font = `700 ${f1}px ${font}`;
  for (const ln of lines1) {
    ctx.fillText(ln, cx, ty);
    ty += f1;
  }
  if (lines2.length) {
    ty += lineSpacing;
    ctx.font = `500 ${f2}px ${font}`;
    for (const ln of lines2) {
      ctx.fillText(ln, cx, ty);
      ty += f2;
    }
  }
}

/** BORDER_COLORS by UIStatus (disengaged/engaged/override + MADS lat/long-only). */
const BORDER_COLORS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "rgb(18, 40, 57)", // disengaged — blue
  1: "rgb(22, 127, 64)", // engaged — green
  2: "rgb(137, 146, 141)", // override — gray
  3: "rgb(0, 200, 200)", // lat_only — cyan
  4: "rgb(150, 28, 168)", // long_only — purple
};

export function drawStatusBorder(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
) {
  const t = ss(content, UI.borderSize);
  const r = 0.12 * (Math.min(content.w, content.h) / 2);
  ctx.strokeStyle = BORDER_COLORS[frame.uiStatus];
  ctx.lineWidth = t;
  roundRect(ctx, content.x + t / 2, content.y + t / 2, content.w - t, content.h - t, r);
  ctx.stroke();
}

export function drawRoadName(ctx: CanvasRenderingContext2D, name: string, content: Viewport["content"]) {
  if (!name) return;
  const font = `600 ${ss(content, 46)}px Geist Variable, ui-sans-serif, sans-serif`;
  ctx.font = font;
  const pad = ss(content, 40);
  const tw = Math.min(ctx.measureText(name).width + pad, content.w - ss(content, 40));
  const h = ss(content, 60);
  const x = content.x + content.w / 2 - tw / 2;
  const y = content.y - ss(content, 4);
  ctx.fillStyle = "rgba(0, 0, 0, 0.47)";
  roundRect(ctx, x, y, tw, h, ss(content, 12));
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, content.x + content.w / 2, y + h / 2, tw - ss(content, 20));
}

export function drawSpeedLimitSign(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
  metric: boolean,
) {
  if (frame.speedLimitMs == null) return;
  const boxW = ss(content, metric ? UI.setSpeedWidthMetric : UI.setSpeedWidthImperial);
  const boxH = ss(content, UI.setSpeedHeight);
  const x = content.x + ss(content, 60) + boxW + ss(content, 24);
  const y = sy(content, 45) - ss(content, 6);
  const w = boxW;
  const h = boxH + ss(content, 12);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const radius = (w + ss(content, 18)) / 2;
  ctx.beginPath();
  ctx.fillStyle = "#fff";
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.strokeStyle = "rgb(235, 32, 32)";
  ctx.lineWidth = radius * 0.25;
  ctx.arc(cx, cy, radius * 0.875, 0, Math.PI * 2);
  ctx.stroke();
  const val = metric
    ? String(Math.round(frame.speedLimitMs * 3.6))
    : String(Math.round(frame.speedLimitMs * 2.23694));
  ctx.fillStyle = "#111";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${ss(content, val.length >= 3 ? 70 : 85)}px Geist Variable, ui-sans-serif, sans-serif`;
  ctx.fillText(val, cx, cy);
}

type DevItem = { label: string; value: string; unit: string; color: string };

const WHITE = "#fff";
const GREEN = "rgb(0, 255, 0)";
const GREY = "rgb(145, 155, 149)";
const ORANGE = "rgb(255, 188, 0)";
const RED = "rgb(255, 60, 60)";

/** Mirrors elements.LateralControlElement.get_lat_color. */
function latColor(latActive: boolean, steerOverride: boolean, angle = 0, checkAngle = false): string {
  let color = WHITE;
  if (latActive) color = steerOverride ? GREY : GREEN;
  if (checkAngle) {
    if (Math.abs(angle) > 180) color = "rgb(235, 32, 32)";
    else if (Math.abs(angle) > 90) color = ORANGE;
  }
  return color;
}

export function drawDeveloperUi(
  ctx: CanvasRenderingContext2D,
  frame: OverlayFrame,
  content: Viewport["content"],
  mode: 0 | 1 | 2 | 3,
  metric: boolean,
) {
  if (mode === 0) return;
  const font = "Geist Variable, ui-sans-serif, sans-serif";
  const lead = frame.leads[0];
  const latActive = frame.latActive;
  const steerOverride = frame.steeringPressed;
  const vEgo = frame.vEgo ?? 0;
  // actual/desired lateral accel = curvature * v^2 (roll compensation unavailable in replay).
  const actualLatAccel = frame.curvature * vEgo * vEgo;
  const desiredLatAccel = frame.desiredCurvature * vEgo * vEgo;

  const right: DevItem[] = [
    {
      label: "REL DIST",
      value: lead ? String(Math.round(lead.x)) : "-",
      unit: "m",
      color: lead && lead.x < 5 ? RED : lead && lead.x < 15 ? ORANGE : WHITE,
    },
    {
      label: "REL SPEED",
      value: lead ? (metric ? String(Math.round(lead.vRel * 3.6)) : String(Math.round(lead.vRel * 2.23694))) : "-",
      unit: metric ? "km/h" : "mph",
      color: lead && lead.vRel < -4.47 ? RED : lead && lead.vRel < 0 ? ORANGE : WHITE,
    },
    {
      label: "REAL STEER",
      value: `${frame.steeringAngleDeg.toFixed(1)}°`,
      unit: "",
      color: latColor(latActive, steerOverride, frame.steeringAngleDeg, true),
    },
    {
      label: "DESIRED L.A.",
      value: latActive ? desiredLatAccel.toFixed(2) : "-",
      unit: "m/s²",
      color: latColor(latActive, steerOverride),
    },
    {
      label: "ACTUAL L.A.",
      value: actualLatAccel.toFixed(2),
      unit: "m/s²",
      color: latColor(latActive, steerOverride),
    },
  ];
  if (mode === 2 || mode === 3) {
    const colW = ss(content, 184);
    let x = content.x + content.w - colW - ss(content, 40);
    let y = content.y + ss(content, 30) + ss(content, 230);
    ctx.textAlign = "center";
    for (const el of right) {
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "top";
      ctx.font = `700 ${ss(content, 28)}px ${font}`;
      ctx.fillText(el.label, x + colW / 2, y);
      ctx.fillStyle = el.color;
      ctx.font = `700 ${ss(content, 60)}px ${font}`;
      ctx.fillText(el.value, x + colW / 2, y + ss(content, 45));
      if (el.unit) {
        ctx.save();
        ctx.fillStyle = "#fff";
        ctx.font = `700 ${ss(content, 28)}px ${font}`;
        ctx.translate(x + colW, y + ss(content, 75));
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "left";
        ctx.fillText(el.unit, 0, 0);
        ctx.restore();
      }
      y += ss(content, 130);
    }
  }
  if (mode === 1 || mode === 3) {
    const barH = ss(content, 61);
    const y = content.y + content.h - barH;
    ctx.fillStyle = "rgba(0, 0, 0, 0.39)";
    ctx.fillRect(content.x, y, content.w, barH);
    const leadSpd = lead
      ? metric
        ? Math.round((vEgo + lead.vRel) * 3.6)
        : Math.round((vEgo + lead.vRel) * 2.23694)
      : null;
    const fricColor = frame.torqueValid ? GREEN : WHITE;
    const bottom: DevItem[] = [
      { label: "ACC.", value: frame.aEgo.toFixed(1), unit: "m/s²", color: WHITE },
      { label: "L.S.", value: leadSpd == null ? "-" : String(leadSpd), unit: metric ? "km/h" : "mph", color: WHITE },
      { label: "FRIC.", value: frame.frictionCoeff.toFixed(3), unit: "", color: fricColor },
      { label: "L.A.", value: frame.latAccelFactor.toFixed(3), unit: "m/s²", color: fricColor },
      { label: "ALT.", value: frame.altitude == null ? "-" : frame.altitude.toFixed(1), unit: "m", color: WHITE },
    ];
    ctx.textBaseline = "middle";
    ctx.font = `700 ${ss(content, 38)}px ${font}`;
    const gap = content.w / (bottom.length + 1);
    bottom.forEach((el, i) => {
      const text = el.unit ? `${el.label} ${el.value} ${el.unit}` : `${el.label} ${el.value}`;
      ctx.textAlign = "center";
      ctx.fillStyle = el.color;
      ctx.fillText(text, content.x + gap * (i + 1), y + barH / 2);
    });
  }
}
