import type { Timed } from "@/overlay/indexLog";
import type {
  CarHud,
  CtrlHud,
  DmHud,
  GpsHud,
  OverlayFrame,
  OverlayLead,
  Vec3Path,
} from "@/overlay/types";

export type Span<T> = { lo: T; hi: T; u: number };

export function spanAt<T>(arr: Timed<T>[], t: number): Span<T> | null {
  if (arr.length === 0) return null;
  if (t <= arr[0]!.t || arr.length === 1) return { lo: arr[0]!.value, hi: arr[0]!.value, u: 0 };
  const last = arr[arr.length - 1]!;
  if (t >= last.t) return { lo: last.value, hi: last.value, u: 0 };

  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = arr[lo]!;
  const b = arr[lo + 1] ?? a;
  const dt = b.t - a.t;
  const u = dt > 1e-6 ? (t - a.t) / dt : 0;
  return { lo: a.value, hi: b.value, u: Math.min(1, Math.max(0, u)) };
}

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

function lerpNullable(a: number | null, b: number | null, u: number): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return lerp(a, b, u);
}

function lerpPath(a: Vec3Path | null, b: Vec3Path | null, u: number): Vec3Path | null {
  if (!a) return b;
  if (!b || u <= 0) return a;
  if (u >= 1) return b;
  const n = Math.min(a.x.length, a.y.length, a.z.length, b.x.length, b.y.length, b.z.length);
  if (n === 0) return a;
  const x = new Array<number>(n);
  const y = new Array<number>(n);
  const z = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    x[i] = lerp(a.x[i]!, b.x[i]!, u);
    y[i] = lerp(a.y[i]!, b.y[i]!, u);
    z[i] = lerp(a.z[i]!, b.z[i]!, u);
  }
  return { x, y, z };
}

function lerpLeads(a: OverlayLead[], b: OverlayLead[], u: number): OverlayLead[] {
  const n = Math.min(a.length, b.length);
  const out: OverlayLead[] = [];
  for (let i = 0; i < n; i++) {
    const la = a[i]!;
    const lb = b[i]!;
    out.push({
      x: lerp(la.x, lb.x, u),
      y: lerp(la.y, lb.y, u),
      prob: lerp(la.prob, lb.prob, u),
      vRel: lerp(la.vRel, lb.vRel, u),
    });
  }
  return out;
}

function lerpRpy(
  a: [number, number, number] | null,
  b: [number, number, number] | null,
  u: number,
): [number, number, number] | null {
  if (!a) return b;
  if (!b || u <= 0) return a;
  if (u >= 1) return b;
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
}

type ModelLike = {
  path: Vec3Path | null;
  laneLines: OverlayFrame["laneLines"];
  roadEdges: OverlayFrame["roadEdges"];
  leads: OverlayLead[];
  confidence: number | null;
};

export function interpModel(span: Span<ModelLike> | null, interpolate: boolean): ModelLike | null {
  if (!span) return null;
  if (!interpolate || span.u === 0) return span.lo;
  const u = span.u;
  const laneN = Math.min(span.lo.laneLines.length, span.hi.laneLines.length);
  const edgeN = Math.min(span.lo.roadEdges.length, span.hi.roadEdges.length);
  return {
    path: lerpPath(span.lo.path, span.hi.path, u),
    laneLines: Array.from({ length: laneN }, (_, i) => ({
      path: lerpPath(span.lo.laneLines[i]!.path, span.hi.laneLines[i]!.path, u)!,
      prob: lerp(span.lo.laneLines[i]!.prob, span.hi.laneLines[i]!.prob, u),
    })),
    roadEdges: Array.from({ length: edgeN }, (_, i) => ({
      path: lerpPath(span.lo.roadEdges[i]!.path, span.hi.roadEdges[i]!.path, u)!,
      std: lerp(span.lo.roadEdges[i]!.std, span.hi.roadEdges[i]!.std, u),
    })),
    leads: lerpLeads(span.lo.leads, span.hi.leads, u),
    confidence: lerpNullable(span.lo.confidence, span.hi.confidence, u),
  };
}

export function interpCar(span: Span<CarHud> | null, interpolate: boolean): CarHud | null {
  if (!span) return null;
  if (!interpolate || span.u === 0) return span.lo;
  const u = span.u;
  return {
    vEgo: lerp(span.lo.vEgo, span.hi.vEgo, u),
    cruiseSpeed: lerpNullable(span.lo.cruiseSpeed, span.hi.cruiseSpeed, u),
    aEgo: lerp(span.lo.aEgo, span.hi.aEgo, u),
    steeringTorqueEps: lerp(span.lo.steeringTorqueEps, span.hi.steeringTorqueEps, u),
    steeringAngleDeg: lerp(span.lo.steeringAngleDeg, span.hi.steeringAngleDeg, u),
    steeringPressed: span.u < 0.5 ? span.lo.steeringPressed : span.hi.steeringPressed,
    standstill: span.u < 0.5 ? span.lo.standstill : span.hi.standstill,
    leftBlinker: span.lo.leftBlinker || span.hi.leftBlinker,
    rightBlinker: span.lo.rightBlinker || span.hi.rightBlinker,
    leftBlindspot: span.lo.leftBlindspot || span.hi.leftBlindspot,
    rightBlindspot: span.lo.rightBlindspot || span.hi.rightBlindspot,
  };
}

export function interpCtrl(span: Span<CtrlHud> | null, interpolate: boolean): CtrlHud | null {
  if (!span) return null;
  if (!interpolate || span.u === 0) return span.lo;
  const u = span.u;
  const pick = span.u < 0.5 ? span.lo : span.hi;
  return {
    curvature: lerp(span.lo.curvature, span.hi.curvature, u),
    desiredCurvature: lerp(span.lo.desiredCurvature, span.hi.desiredCurvature, u),
    latControlType: pick.latControlType,
    latActive: pick.latActive,
    actuatorsTorque: lerp(span.lo.actuatorsTorque, span.hi.actuatorsTorque, u),
    torqueValid: pick.torqueValid,
    frictionCoeff: lerp(span.lo.frictionCoeff, span.hi.frictionCoeff, u),
    latAccelFactor: lerp(span.lo.latAccelFactor, span.hi.latAccelFactor, u),
  };
}

export function interpDm(span: Span<DmHud> | null, interpolate: boolean): DmHud | null {
  if (!span) return null;
  if (!interpolate || span.u === 0) return span.lo;
  const u = span.u;
  const pick = u < 0.5 ? span.lo : span.hi;
  return {
    active: pick.active,
    faceDetected: pick.faceDetected,
    isRHD: pick.isRHD,
    facePitch: lerp(span.lo.facePitch, span.hi.facePitch, u),
    faceYaw: lerp(span.lo.faceYaw, span.hi.faceYaw, u),
    awarenessUnfull: pick.awarenessUnfull,
    poseVals: [
      lerp(span.lo.poseVals[0], span.hi.poseVals[0], u),
      lerp(span.lo.poseVals[1], span.hi.poseVals[1], u),
      lerp(span.lo.poseVals[2], span.hi.poseVals[2], u),
    ],
    poseDiff: [
      lerp(span.lo.poseDiff[0], span.hi.poseDiff[0], u),
      lerp(span.lo.poseDiff[1], span.hi.poseDiff[1], u),
      lerp(span.lo.poseDiff[2], span.hi.poseDiff[2], u),
    ],
  };
}

export function interpLeads(span: Span<OverlayLead[]> | null, interpolate: boolean): OverlayLead[] {
  if (!span) return [];
  if (!interpolate || span.u === 0) return span.lo;
  return lerpLeads(span.lo, span.hi, span.u);
}

export function interpCalib(
  span: Span<{ rpy: [number, number, number]; height: number }> | null,
  interpolate: boolean,
): { rpy: [number, number, number]; height: number } | null {
  if (!span) return null;
  if (!interpolate || span.u === 0) return span.lo;
  const rpy = lerpRpy(span.lo.rpy, span.hi.rpy, span.u);
  if (!rpy) return span.lo;
  return { rpy, height: lerp(span.lo.height, span.hi.height, span.u) };
}

function lerpBearing(a: number | null, b: number | null, u: number): number | null {
  if (a == null) return b;
  if (b == null) return a;
  // Shortest-path lerp on degrees.
  let delta = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + delta * u + 360) % 360;
}

/** Time-based GPS lerp between samples (and across segment boundaries via absolute t). */
export function interpGps(span: Span<GpsHud> | null, interpolate: boolean): GpsHud | null {
  if (!span) return null;
  if (!interpolate || span.u <= 0) return span.lo;
  if (span.u >= 1) return span.hi;
  return {
    latitude: lerp(span.lo.latitude, span.hi.latitude, span.u),
    longitude: lerp(span.lo.longitude, span.hi.longitude, span.u),
    altitude: lerpNullable(span.lo.altitude, span.hi.altitude, span.u),
    bearingDeg: lerpBearing(span.lo.bearingDeg, span.hi.bearingDeg, span.u),
  };
}
