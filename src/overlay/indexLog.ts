import { Event_Which, type LogEvent } from "@/cereal";
import { decompressLog } from "@/log/decompress";
import { parseEvents } from "@/log/logReader";
import { SEGMENT_SECONDS } from "@/playback/session";
import type {
  CarHud,
  CtrlHud,
  DmHud,
  GpsHud,
  LatControlType,
  OverlayFrame,
  OverlayAlert,
  SelfdriveHud,
  UiStatus,
  Vec3Path,
} from "@/overlay/types";

export type Timed<T> = { t: number; value: T };

export type ModelSample = {
  path: Vec3Path | null;
  laneLines: OverlayFrame["laneLines"];
  roadEdges: OverlayFrame["roadEdges"];
  leads: OverlayFrame["leads"];
  confidence: number | null;
};

export type OverlaySegment = {
  models: Timed<ModelSample>[];
  car: Timed<CarHud>[];
  sd: Timed<SelfdriveHud>[];
  ctrl: Timed<CtrlHud>[];
  gps: Timed<GpsHud>[];
  dm: Timed<DmHud>[];
  calib: Timed<{ rpy: [number, number, number]; height: number }>[];
  radarLeads: Timed<OverlayFrame["leads"]>[];
  map: Timed<{ roadName: string; speedLimitMs: number | null }>[];
  /**
   * Seconds to add to a video offset to get the telemetry sample time. Sample
   * times are relative to the first *telemetry* event, but the video's t=0 is
   * the first camera frame; this is (firstFrameMono - firstEventMono) so the two
   * clocks line up. 0 when no camera-frame events are present (e.g. thin qlogs).
   */
  frameOffset: number;
};

/**
 * Road camera frame events. Their logMonoTime marks the frame the video shows,
 * so the earliest one anchors telemetry to the same clock as video.currentTime.
 * Narrow-road = the main road camera that qcamera.ts / fcamera.hevc come from.
 */
const CAMERA_ANCHOR_WHICH: ReadonlySet<number> = new Set<number>([
  Event_Which.NARROW_ROAD_CAMERA_STATE,
  Event_Which.NARROW_ROAD_ENCODE_IDX,
  Event_Which.Q_NARROW_ROAD_ENCODE_IDX,
]);

const PATH_DRAW_N = 17;
const MODEL_MIN_DT = 0.08;
const CAR_MIN_DT = 0.05;
const GPS_MIN_DT = 0.5;
const RADAR_MIN_DT = 0.1;

/** T_IDXS from modeld: 33 points, t in [0, 10], quadratic spacing. */
const T_IDXS: number[] = Array.from({ length: 33 }, (_, i) => 10 * (i / 32) ** 2);

function listToArray(list: { getLength(): number; get(i: number): number; toArray?: () => number[] }): number[] {
  if (typeof list.toArray === "function") return list.toArray();
  const n = list.getLength();
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(list.get(i));
  return out;
}

function thinPath(path: Vec3Path, n = PATH_DRAW_N): Vec3Path {
  const m = Math.min(path.x.length, path.y.length, path.z.length);
  if (m <= n) return path;
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = Math.round((i * (m - 1)) / (n - 1));
    x.push(path.x[j]!);
    y.push(path.y[j]!);
    z.push(path.z[j]!);
  }
  return { x, y, z };
}

function readXYZT(xyz: {
  getX(): { getLength(): number; get(i: number): number; toArray?: () => number[] };
  getY(): { getLength(): number; get(i: number): number; toArray?: () => number[] };
  getZ(): { getLength(): number; get(i: number): number; toArray?: () => number[] };
}): Vec3Path {
  return thinPath({
    x: listToArray(xyz.getX()),
    y: listToArray(xyz.getY()),
    z: listToArray(xyz.getZ()),
  });
}

function evalPoly(coeffs: number[], t: number): number {
  let acc = 0;
  let p = 1;
  for (const c of coeffs) {
    acc += c * p;
    p *= t;
  }
  return acc;
}

function samplePolyPath(poly: {
  getXCoefficients(): { getLength(): number; get(i: number): number; toArray?: () => number[] };
  getYCoefficients(): { getLength(): number; get(i: number): number; toArray?: () => number[] };
  getZCoefficients(): { getLength(): number; get(i: number): number; toArray?: () => number[] };
}): Vec3Path {
  const cx = listToArray(poly.getXCoefficients());
  const cy = listToArray(poly.getYCoefficients());
  const cz = listToArray(poly.getZCoefficients());
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  for (const t of T_IDXS) {
    x.push(evalPoly(cx, t));
    y.push(evalPoly(cy, t));
    z.push(evalPoly(cz, t));
  }
  return thinPath({ x, y, z });
}

function offsetPath(path: Vec3Path, y0: number): Vec3Path {
  const dy = y0 - (path.y[0] ?? 0);
  return { x: path.x, y: path.y.map((y) => y + dy), z: path.z };
}

function extractModel(event: LogEvent): ModelSample {
  const m = event.getModelV2();
  const path = m.hasPosition() ? readXYZT(m.getPosition()) : null;
  const laneLines: OverlayFrame["laneLines"] = [];
  const probs = m.hasLaneLineProbs() ? listToArray(m.getLaneLineProbs()) : [];
  if (m.hasLaneLines()) {
    const lines = m.getLaneLines();
    for (let i = 0; i < lines.getLength(); i++) {
      laneLines.push({ path: readXYZT(lines.get(i)), prob: probs[i] ?? 0 });
    }
  }
  const roadEdges: OverlayFrame["roadEdges"] = [];
  const stds = m.hasRoadEdgeStds() ? listToArray(m.getRoadEdgeStds()) : [];
  if (m.hasRoadEdges()) {
    const edges = m.getRoadEdges();
    for (let i = 0; i < edges.getLength(); i++) {
      roadEdges.push({ path: readXYZT(edges.get(i)), std: stds[i] ?? 1 });
    }
  }
  const leads: OverlayFrame["leads"] = [];
  if (m.hasLeadsV3()) {
    const lv = m.getLeadsV3();
    for (let i = 0; i < lv.getLength(); i++) {
      const lead = lv.get(i);
      const prob = lead.getProb();
      if (prob < 0.4) continue;
      const xs = lead.getX();
      const ys = lead.getY();
      if (xs.getLength() === 0 || ys.getLength() === 0) continue;
      leads.push({ x: xs.get(0), y: ys.get(0), prob, vRel: 0 });
    }
  }
  return { path, laneLines, roadEdges, leads, confidence: extractConfidence(m) };
}

/** mici confidence ball: (1 - max brakeDisengage) * (1 - max steerOverride). */
function extractConfidence(m: {
  hasMeta?: () => boolean;
  getMeta?: () => {
    hasDisengagePredictions?: () => boolean;
    getDisengagePredictions?: () => {
      getBrakeDisengageProbs(): { getLength(): number; get(i: number): number; toArray?: () => number[] };
      getSteerOverrideProbs(): { getLength(): number; get(i: number): number; toArray?: () => number[] };
    };
  };
}): number | null {
  try {
    if (!m.hasMeta?.() || !m.getMeta) return null;
    const meta = m.getMeta() as {
      hasDisengagePredictions?: () => boolean;
      getDisengagePredictions?: () => {
        getBrakeDisengageProbs(): { getLength(): number; get(i: number): number; toArray?: () => number[] };
        getSteerOverrideProbs(): { getLength(): number; get(i: number): number; toArray?: () => number[] };
      };
      getDeprecated?: () => { getBrakeDisengageProb(): number; getSteerOverrideProb(): number };
    };
    if (meta.hasDisengagePredictions?.() && meta.getDisengagePredictions) {
      const dp = meta.getDisengagePredictions();
      const brake = listToArray(dp.getBrakeDisengageProbs());
      const steer = listToArray(dp.getSteerOverrideProbs());
      if (brake.length || steer.length) {
        const maxBrake = brake.length ? Math.max(...brake) : 0;
        const maxSteer = steer.length ? Math.max(...steer) : 0;
        return (1 - maxBrake) * (1 - maxSteer);
      }
    }
    // Fallback: older/qlog model meta carries single deprecated scalar probs.
    if (meta.getDeprecated) {
      const dep = meta.getDeprecated();
      const maxBrake = dep.getBrakeDisengageProb();
      const maxSteer = dep.getSteerOverrideProb();
      if (Number.isFinite(maxBrake) && Number.isFinite(maxSteer)) {
        return (1 - maxBrake) * (1 - maxSteer);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function extractDrivingModel(event: LogEvent): ModelSample {
  const d = event.getDrivingModelData();
  const path = d.hasPath() ? samplePolyPath(d.getPath()) : null;
  const laneLines: OverlayFrame["laneLines"] = [];
  if (d.hasLaneLineMeta() && path) {
    const meta = d.getLaneLineMeta();
    laneLines.push({ path: offsetPath(path, meta.getLeftY()), prob: meta.getLeftProb() });
    laneLines.push({ path: offsetPath(path, meta.getRightY()), prob: meta.getRightProb() });
  }
  return { path, laneLines, roadEdges: [], leads: [], confidence: null };
}

function extractRadarLeads(event: LogEvent): OverlayFrame["leads"] {
  const rs = event.getRadarState();
  const out: OverlayFrame["leads"] = [];
  for (const lead of [rs.getLeadOne(), rs.getLeadTwo()]) {
    if (!lead.getPresent()) continue;
    const x = lead.getDRel();
    const y = lead.getYRel();
    if (!Number.isFinite(x) || x < 0.5) continue;
    out.push({
      x,
      y,
      prob: Math.max(0.4, lead.getModelProb() || 0.6),
      vRel: lead.getVRel(),
    });
  }
  return out;
}

function extractCar(event: LogEvent): CarHud {
  const cs = event.getCarState();
  const vEgo = cs.getVEgo();
  let cruiseSpeed: number | null = null;
  try {
    const kph = cs.getVCruise();
    if (Number.isFinite(kph) && kph > 0 && kph < 250) cruiseSpeed = kph / 3.6;
  } catch {
    try {
      if (cs.hasCruiseState()) {
        const speed = cs.getCruiseState().getSpeed();
        if (Number.isFinite(speed) && speed > 0 && speed < 50) cruiseSpeed = speed;
      }
    } catch {
      /* optional */
    }
  }
  const flag = (fn: () => boolean) => {
    try {
      return Boolean(fn());
    } catch {
      return false;
    }
  };
  const num = (fn: () => number, fallback = 0) => {
    try {
      const v = fn();
      return Number.isFinite(v) ? v : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    vEgo,
    cruiseSpeed,
    aEgo: num(() => cs.getAEgo()),
    steeringTorqueEps: num(() => cs.getSteeringTorqueEps()),
    steeringAngleDeg: num(() => cs.getSteeringAngleDeg()),
    steeringPressed: flag(() => cs.getSteeringPressed()),
    standstill: flag(() => cs.getStandstill()) || Math.abs(vEgo) < 0.15,
    leftBlinker: flag(() => cs.getLeftBlinker()),
    rightBlinker: flag(() => cs.getRightBlinker()),
    leftBlindspot: flag(() => cs.getLeftBlindspot()),
    rightBlindspot: flag(() => cs.getRightBlindspot()),
  };
}

/** Running MADS state, updated from SELFDRIVE_STATE_SP. */
type MadsState = { available: boolean; enabled: boolean; paused: boolean };

/** MADSState enum: disabled=0, paused=1, enabled=2, softDisabling=3, overriding=4. */
function applyMads(event: LogEvent, mads: MadsState): void {
  try {
    const sp = event.getSelfdriveStateSP() as { getMads?: () => unknown };
    if (!sp.getMads) return;
    const m = sp.getMads() as {
      getAvailable(): boolean;
      getEnabled(): boolean;
      getState(): number;
    };
    mads.available = Boolean(m.getAvailable());
    mads.enabled = Boolean(m.getEnabled());
    const state = Number(m.getState());
    mads.paused = state === 1 || state === 4; // paused or overriding
  } catch {
    /* optional */
  }
}

/** Mirrors UIStateSP.update_status + SP _lateral_active. */
function deriveStatus(ssEnabled: boolean, mads: MadsState): { uiStatus: UiStatus; latActive: boolean } {
  let uiStatus: UiStatus;
  if (mads.paused) {
    uiStatus = 2; // override
  } else if (!mads.available) {
    uiStatus = ssEnabled ? 1 : 0;
  } else if (mads.enabled && ssEnabled) {
    uiStatus = 1; // engaged
  } else if (mads.enabled) {
    uiStatus = 3; // lat_only
  } else if (ssEnabled) {
    uiStatus = 4; // long_only
  } else {
    uiStatus = 0; // disengaged
  }
  const latActive = mads.available
    ? mads.enabled && !mads.paused
    : uiStatus === 1 || uiStatus === 3;
  return { uiStatus, latActive };
}

function extractSelfdrive(event: LogEvent, mads: MadsState): SelfdriveHud {
  const ss = event.getSelfdriveState();
  const size = Number(ss.getAlertSize());
  let alert: OverlayAlert | null = null;
  if (size === 1 || size === 2 || size === 3) {
    let alertType = "";
    try {
      alertType = (ss as { getAlertType?: () => string }).getAlertType?.() || "";
    } catch {
      /* optional */
    }
    alert = {
      text1: ss.getAlertText1() || "",
      text2: ss.getAlertText2() || "",
      size,
      status: (Number(ss.getAlertStatus()) as 0 | 1 | 2) || 0,
      alertType,
    };
  }
  const flag = (fn: () => boolean) => {
    try {
      return Boolean(fn());
    } catch {
      return false;
    }
  };
  const ssEnabled = flag(() => ss.getEnabled());
  const { uiStatus, latActive } = deriveStatus(ssEnabled, mads);
  return {
    engaged: ssEnabled,
    engageable: flag(() => ss.getEngageable()) || ssEnabled,
    experimentalMode: flag(() => ss.getExperimentalMode()),
    alert,
    ssEnabled,
    madsAvailable: mads.available,
    madsEnabled: mads.enabled,
    madsPaused: mads.paused,
    uiStatus,
    latActive,
  };
}

const LAT_WHICH: Record<number, LatControlType> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 3 };

/** Merge a ControlsState event into the running ctrl state. */
function applyControlsState(event: LogEvent, ctrl: CtrlHud): void {
  const cs = event.getControlsState() as {
    getCurvature?: () => number;
    getDesiredCurvature?: () => number;
    getLateralControlState?: () => { which(): number };
  };
  try {
    if (cs.getCurvature) ctrl.curvature = cs.getCurvature();
  } catch {
    /* optional */
  }
  try {
    if (cs.getDesiredCurvature) ctrl.desiredCurvature = cs.getDesiredCurvature();
  } catch {
    /* optional */
  }
  try {
    if (cs.getLateralControlState) {
      const w = Number(cs.getLateralControlState().which());
      ctrl.latControlType = LAT_WHICH[w] ?? 4;
    }
  } catch {
    /* optional */
  }
}

function extractGps(event: LogEvent): GpsHud | null {
  try {
    const which = event.which();
    let g: {
      getLatitude(): number;
      getLongitude(): number;
      getAltitude(): number;
      getBearingDeg?: () => number;
      getHasFix?: () => boolean;
    } | null = null;
    if (which === Event_Which.GPS_LOCATION_EXTERNAL) g = event.getGpsLocationExternal();
    else if (which === Event_Which.GPS_LOCATION) g = event.getGpsLocation();
    if (!g) return null;
    const latitude = g.getLatitude();
    const longitude = g.getLongitude();
    if (!(Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180)) return null;
    if (latitude === 0 && longitude === 0) return null;
    try {
      if (g.getHasFix && !g.getHasFix()) {
        if (Math.abs(latitude) < 1e-5 && Math.abs(longitude) < 1e-5) return null;
      }
    } catch {
      /* optional */
    }
    let bearingDeg: number | null = null;
    try {
      if (g.getBearingDeg) {
        const b = g.getBearingDeg();
        if (Number.isFinite(b)) bearingDeg = b;
      }
    } catch {
      /* optional */
    }
    return {
      latitude,
      longitude,
      altitude: g.getAltitude(),
      bearingDeg,
    };
  } catch {
    return null;
  }
}

const DEG6 = (6 * Math.PI) / 180;
const AWARENESS_UNFULL_PERCENT = 95;

/** Device SCALES_POS / SCALES_NEG for head pose (yaw, pitch, roll). */
const SCALES_POS = [0.9, 0.4, 0.4];
const SCALES_NEG = [0.7, 0.4, 0.4];

/**
 * Running driver-face state. `vals` is the smoothed+scaled pose (device
 * driver_pose_vals); `diff` is the per-sample change (driver_pose_diff).
 */
type FaceState = {
  vals: [number, number, number];
  diff: [number, number, number];
};

/**
 * Update the running pose from a driverStateV2 event, applying the same
 * scaling and EMA smoothing (0.8·new + 0.2·prev) the device uses. This is what
 * keeps the 3X face/arcs from jittering on noisy raw orientation.
 */
function applyDriverState(event: LogEvent, isRHD: boolean, face: FaceState): void {
  try {
    const ds = event.getDriverStateV2() as {
      getLeftDriverData(): { getFaceOrientation(): { get(i: number): number; getLength(): number } };
      getRightDriverData(): { getFaceOrientation(): { get(i: number): number; getLength(): number } };
    };
    const data = isRHD ? ds.getRightDriverData() : ds.getLeftDriverData();
    const fo = data.getFaceOrientation();
    if (fo.getLength() < 3) return;
    for (let i = 0; i < 3; i++) {
      const raw = fo.get(i);
      const scaled = raw * (raw < 0 ? SCALES_NEG[i]! : SCALES_POS[i]!);
      face.diff[i] = Math.abs(face.vals[i]! - scaled);
      face.vals[i] = 0.8 * scaled + 0.2 * face.vals[i]!;
    }
  } catch {
    /* optional */
  }
}

/** Mirrors DriverStateRenderer._update_state (mici pose + 3X orientation). */
function extractDm(event: LogEvent, face: FaceState): DmHud | null {
  try {
    const dm = event.getDriverMonitoringState() as {
      getActivePolicy(): number;
      getIsRHD(): boolean;
      getVisionPolicyState(): {
        getFaceDetected(): boolean;
        getAwarenessPercent(): number;
        getPose(): { getPitch(): number; getYaw(): number };
      };
    };
    const active = Number(dm.getActivePolicy()) === 1; // vision
    const isRHD = Boolean(dm.getIsRHD());
    const vps = dm.getVisionPolicyState();
    const faceDetected = Boolean(vps.getFaceDetected());
    const awareness = vps.getAwarenessPercent();
    const pose = vps.getPose();
    // Device adds a fake upward pitch bias and flips yaw sign for LHD.
    const facePitch = pose.getPitch() + DEG6;
    const faceYaw = pose.getYaw() * (isRHD ? 1 : -1);
    return {
      active,
      faceDetected,
      isRHD,
      facePitch,
      faceYaw,
      awarenessUnfull: active && awareness < AWARENESS_UNFULL_PERCENT,
      poseVals: [...face.vals],
      poseDiff: [...face.diff],
    };
  } catch {
    return null;
  }
}

function extractMapHud(event: LogEvent): { roadName: string; speedLimitMs: number | null } | null {
  try {
    if (event.which() === Event_Which.LIVE_MAP_DATA_SP) {
      const m = event.getLiveMapDataSP();
      const valid = m.getSpeedLimitValid();
      const sl = m.getSpeedLimit();
      return {
        roadName: m.getRoadName() || "",
        speedLimitMs: valid && sl > 0 ? sl : null,
      };
    }
  } catch {
    /* optional */
  }
  try {
    if (event.which() === Event_Which.LONGITUDINAL_PLAN_SP) {
      const r = event.getLongitudinalPlanSP().getSpeedLimit().getResolver();
      const valid = r.getSpeedLimitValid() || r.getSpeedLimitLastValid();
      const sl = r.getSpeedLimitLast() || r.getSpeedLimit();
      return {
        roadName: "",
        speedLimitMs: valid && sl > 0 ? sl : null,
      };
    }
  } catch {
    /* optional */
  }
  return null;
}

function keep(lastT: number, t: number, minDt: number): boolean {
  return lastT < 0 || t - lastT >= minDt;
}

export async function indexOverlayBytes(
  bytes: Uint8Array,
  opts?: { yieldEvery?: number },
): Promise<OverlaySegment> {
  const raw = await decompressLog(bytes);
  const models: OverlaySegment["models"] = [];
  const car: OverlaySegment["car"] = [];
  const sd: OverlaySegment["sd"] = [];
  const sdFallback: OverlaySegment["sd"] = [];
  const ctrl: OverlaySegment["ctrl"] = [];
  const gps: OverlaySegment["gps"] = [];
  const dm: OverlaySegment["dm"] = [];
  const madsState: MadsState = { available: false, enabled: false, paused: false };
  const faceState: FaceState = { vals: [0, 0, 0], diff: [0, 0, 0] };
  let dmRHD = false;
  let lastDm = -1;
  const calib: OverlaySegment["calib"] = [];
  const radarLeads: OverlaySegment["radarLeads"] = [];
  const map: OverlaySegment["map"] = [];
  let t0: bigint | null = null;
  let frameMono0: bigint | null = null;
  let n = 0;
  let lastModel = -1;
  let lastCar = -1;
  let lastRadar = -1;
  let lastCtrl = -1;
  let lastGps = -1;
  const ctrlState: CtrlHud = {
    curvature: 0,
    desiredCurvature: 0,
    latControlType: 4,
    latActive: false,
    actuatorsTorque: 0,
    torqueValid: false,
    frictionCoeff: 0,
    latAccelFactor: 0,
  };
  const yieldEvery = opts?.yieldEvery ?? 0;

  for (const event of parseEvents(raw)) {
    n++;
    const which = event.which();

    // Camera-frame events aren't kept as samples, but their logMonoTime marks
    // the video's frame clock. Record the earliest so we can re-anchor telemetry
    // onto the same origin as video.currentTime (fixes constant overlay drift).
    if (CAMERA_ANCHOR_WHICH.has(which)) {
      const fm = event.getLogMonoTime();
      const fmBig = typeof fm === "bigint" ? fm : BigInt(Math.trunc(Number(fm)));
      if (frameMono0 == null || fmBig < frameMono0) frameMono0 = fmBig;
      if (yieldEvery && n % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
      continue;
    }

    if (
      which !== Event_Which.MODEL_V2 &&
      which !== Event_Which.DRIVING_MODEL_DATA &&
      which !== Event_Which.CAR_STATE &&
      which !== Event_Which.SELFDRIVE_STATE &&
      which !== Event_Which.SELFDRIVE_STATE_SP &&
      which !== Event_Which.CONTROLS_STATE &&
      which !== Event_Which.CAR_CONTROL &&
      which !== Event_Which.CAR_OUTPUT &&
      which !== Event_Which.LATERAL_TORQUE_PARAMETERS &&
      which !== Event_Which.RADAR_STATE &&
      which !== Event_Which.EXTRINSICS_CALIBRATION &&
      which !== Event_Which.GPS_LOCATION_EXTERNAL &&
      which !== Event_Which.GPS_LOCATION &&
      which !== Event_Which.DRIVER_MONITORING_STATE &&
      which !== Event_Which.DRIVER_STATE_V2 &&
      which !== Event_Which.LIVE_MAP_DATA_SP &&
      which !== Event_Which.LONGITUDINAL_PLAN_SP
    ) {
      if (yieldEvery && n % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
      continue;
    }

    const mono = event.getLogMonoTime();
    if (t0 == null) t0 = typeof mono === "bigint" ? mono : BigInt(Math.trunc(Number(mono)));
    const t =
      typeof mono === "bigint" ? Number(mono - t0) / 1e9 : (Number(mono) - Number(t0)) / 1e9;
    if (!Number.isFinite(t) || t < -1 || t > SEGMENT_SECONDS + 30) {
      if (yieldEvery && n % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
      continue;
    }

    try {
      if (which === Event_Which.MODEL_V2) {
        if (keep(lastModel, t, MODEL_MIN_DT)) {
          const value = extractModel(event);
          if (!value.path && models.length) value.path = models[models.length - 1]!.value.path;
          models.push({ t, value });
          lastModel = t;
        }
      } else if (which === Event_Which.DRIVING_MODEL_DATA) {
        if (keep(lastModel, t, MODEL_MIN_DT)) {
          models.push({ t, value: extractDrivingModel(event) });
          lastModel = t;
        }
      } else if (which === Event_Which.CAR_STATE) {
        if (keep(lastCar, t, CAR_MIN_DT)) {
          car.push({ t, value: extractCar(event) });
          lastCar = t;
        }
      } else if (which === Event_Which.SELFDRIVE_STATE_SP) {
        applyMads(event, madsState);
      } else if (which === Event_Which.SELFDRIVE_STATE) {
        sd.push({ t, value: extractSelfdrive(event, madsState) });
      } else if (which === Event_Which.CONTROLS_STATE) {
        applyControlsState(event, ctrlState);
        if (keep(lastCtrl, t, CAR_MIN_DT)) {
          ctrl.push({ t, value: { ...ctrlState } });
          lastCtrl = t;
        }
        try {
          const cs = event.getControlsState() as { getEnabled?: () => boolean };
          if (typeof cs.getEnabled === "function") {
            const en = cs.getEnabled();
            const derived = deriveStatus(en, madsState);
            sdFallback.push({
              t,
              value: {
                engaged: en,
                engageable: en,
                experimentalMode: false,
                alert: null,
                ssEnabled: en,
                madsAvailable: madsState.available,
                madsEnabled: madsState.enabled,
                madsPaused: madsState.paused,
                uiStatus: derived.uiStatus,
                latActive: derived.latActive,
              },
            });
          }
        } catch {
          /* optional */
        }
      } else if (which === Event_Which.CAR_CONTROL) {
        try {
          const cc = event.getCarControl() as {
            getLatActive?: () => boolean;
            getActuatorsOutput?: () => { getTorque(): number };
          };
          if (cc.getLatActive) ctrlState.latActive = Boolean(cc.getLatActive());
          if (cc.getActuatorsOutput) ctrlState.actuatorsTorque = cc.getActuatorsOutput().getTorque();
        } catch {
          /* optional */
        }
      } else if (which === Event_Which.CAR_OUTPUT) {
        try {
          const co = event.getCarOutput() as {
            getActuatorsOutput?: () => { getTorque(): number };
          };
          if (co.getActuatorsOutput) ctrlState.actuatorsTorque = co.getActuatorsOutput().getTorque();
        } catch {
          /* optional */
        }
      } else if (which === Event_Which.LATERAL_TORQUE_PARAMETERS) {
        try {
          const ltp = event.getLateralTorqueParameters() as {
            getValid?: () => boolean;
            getFrictionCoefficientFiltered?: () => number;
            getLatAccelFactorFiltered?: () => number;
          };
          if (ltp.getValid) ctrlState.torqueValid = Boolean(ltp.getValid());
          if (ltp.getFrictionCoefficientFiltered)
            ctrlState.frictionCoeff = ltp.getFrictionCoefficientFiltered();
          if (ltp.getLatAccelFactorFiltered)
            ctrlState.latAccelFactor = ltp.getLatAccelFactorFiltered();
        } catch {
          /* optional */
        }
      } else if (which === Event_Which.GPS_LOCATION_EXTERNAL || which === Event_Which.GPS_LOCATION) {
        if (keep(lastGps, t, GPS_MIN_DT)) {
          const g = extractGps(event);
          if (g) {
            gps.push({ t, value: g });
            lastGps = t;
          }
        }
      } else if (which === Event_Which.DRIVER_STATE_V2) {
        applyDriverState(event, dmRHD, faceState);
      } else if (which === Event_Which.DRIVER_MONITORING_STATE) {
        if (keep(lastDm, t, CAR_MIN_DT)) {
          const d = extractDm(event, faceState);
          if (d) {
            dmRHD = d.isRHD;
            dm.push({ t, value: d });
            lastDm = t;
          }
        }
      } else if (which === Event_Which.RADAR_STATE) {
        if (keep(lastRadar, t, RADAR_MIN_DT)) {
          radarLeads.push({ t, value: extractRadarLeads(event) });
          lastRadar = t;
        }
      } else if (which === Event_Which.EXTRINSICS_CALIBRATION) {
        const c = event.getExtrinsicsCalibration();
        if (c.hasRpyCalib() && c.getRpyCalib().getLength() >= 3) {
          const rpy: [number, number, number] = [
            c.getRpyCalib().get(0),
            c.getRpyCalib().get(1),
            c.getRpyCalib().get(2),
          ];
          let height = 1.22;
          if (c.hasHeight() && c.getHeight().getLength() > 0) height = c.getHeight().get(0);
          calib.push({ t, value: { rpy, height } });
        }
      } else if (which === Event_Which.LIVE_MAP_DATA_SP || which === Event_Which.LONGITUDINAL_PLAN_SP) {
        const hud = extractMapHud(event);
        if (hud) map.push({ t, value: hud });
      }
    } catch {
      /* skip malformed event */
    }

    if (yieldEvery && n % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
  }

  // Both anchors are on the same monotonic clock. frameOffset converts a video
  // offset into telemetry-sample time: sampleT = videoOffset + frameOffset.
  let frameOffset = 0;
  if (frameMono0 != null && t0 != null) {
    const delta = Number(frameMono0 - t0) / 1e9;
    // Guard against absurd values from truncated/mixed logs; a real offset is
    // sub-second. Anything larger means the anchor is unreliable — skip it.
    if (Number.isFinite(delta) && Math.abs(delta) < 5) frameOffset = delta;
  }

  return {
    models,
    car,
    sd: sd.length ? sd : sdFallback,
    ctrl,
    gps,
    dm,
    calib,
    radarLeads,
    map,
    frameOffset,
  };
}
