/** comma 3X onroad HUD is laid out for 2160×1080. Scale into the video content rect. */
export const DESIGN_H = 1080;

export type Rect = { x: number; y: number; w: number; h: number };

export function hudScale(content: Rect): number {
  return content.h / DESIGN_H;
}

export function sx(content: Rect, x: number): number {
  return content.x + x * hudScale(content);
}

export function sy(content: Rect, y: number): number {
  return content.y + y * hudScale(content);
}

export function ss(content: Rect, n: number): number {
  return n * hudScale(content);
}

export const UI = {
  headerHeight: 300,
  borderSize: 30,
  buttonSize: 192,
  wheelIcon: 144,
  setSpeedWidthMetric: 200,
  setSpeedWidthImperial: 172,
  setSpeedHeight: 204,
  currentSpeed: 176,
  speedUnit: 66,
  maxSpeed: 40,
  setSpeed: 90,
  alertMargin: 40,
  alertPadding: 60,
  alertRadius: 30,
  alertSmallH: 271,
  alertMidH: 420,
  alertFontSmall: 66,
  alertFontMedium: 74,
  alertFontBig: 88,
} as const;
