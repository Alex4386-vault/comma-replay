import type { OverlayStyle } from "@/playback/session";

export type Vec3Path = {
  x: number[];
  y: number[];
  z: number[];
};

export type OverlayLead = {
  x: number;
  y: number;
  prob: number;
  /** Relative speed (lead − ego), m/s. */
  vRel: number;
};

export type CarHud = {
  vEgo: number;
  cruiseSpeed: number | null;
  aEgo: number;
  steeringTorqueEps: number;
  steeringAngleDeg: number;
  steeringPressed: boolean;
  standstill: boolean;
  leftBlinker: boolean;
  rightBlinker: boolean;
  leftBlindspot: boolean;
  rightBlindspot: boolean;
};

/** lateralControlState.which(): pid=0, angle=1, torque=2, curvature=3, other=4 */
export type LatControlType = 0 | 1 | 2 | 3 | 4;

/** Derived from controlsState / carControl / carOutput / lateralTorqueParameters. */
export type CtrlHud = {
  curvature: number;
  desiredCurvature: number;
  latControlType: LatControlType;
  latActive: boolean;
  actuatorsTorque: number;
  torqueValid: boolean;
  frictionCoeff: number;
  latAccelFactor: number;
};

/** GPS-derived developer UI fields. */
export type GpsHud = {
  altitude: number | null;
};

/** Driver monitoring (mici DMoji + 3X face). */
export type DmHud = {
  /** activePolicy == vision. */
  active: boolean;
  faceDetected: boolean;
  isRHD: boolean;
  /** Head pose, radians (already sign-adjusted for UI convention). mici cone. */
  facePitch: number;
  faceYaw: number;
  /** Awareness < 95% while active → cone fades toward orange. */
  awarenessUnfull: boolean;
  /** Smoothed + scaled head pose [yaw, pitch, roll] (device driver_pose_vals). */
  poseVals: [number, number, number];
  /** Per-sample pose delta, for 3X arc thickness (device driver_pose_diff). */
  poseDiff: [number, number, number];
};

/** selfdriveState.alertSize: none=0, small=1, mid=2, full=3 */
export type OverlayAlert = {
  text1: string;
  text2: string;
  size: 1 | 2 | 3;
  status: 0 | 1 | 2;
  /** Event name from selfdriveState.alertType, e.g. "laneChange/warning". */
  alertType: string;
};

/**
 * UI engagement status, mirroring sunnypilot UIStatus.
 * disengaged=0, engaged=1, override=2, latOnly=3, longOnly=4
 */
export type UiStatus = 0 | 1 | 2 | 3 | 4;

export type SelfdriveHud = {
  engaged: boolean;
  engageable: boolean;
  experimentalMode: boolean;
  alert: OverlayAlert | null;
  /** Full-system engaged (ss.enabled). */
  ssEnabled: boolean;
  /** MADS present on this vehicle. */
  madsAvailable: boolean;
  /** MADS lateral engaged. */
  madsEnabled: boolean;
  /** MADS paused/overriding → lateral suspended. */
  madsPaused: boolean;
  uiStatus: UiStatus;
  /** Lateral control actively steering (drives path/lane/wheel/torque visuals). */
  latActive: boolean;
};

export type OverlayFrame = {
  /** Seconds from drive start. */
  t: number;
  vEgo: number | null;
  engaged: boolean | null;
  engageable: boolean;
  experimentalMode: boolean;
  cruiseSpeed: number | null;
  aEgo: number;
  steeringTorqueEps: number;
  steeringAngleDeg: number;
  steeringPressed: boolean;
  alert: OverlayAlert | null;
  standstill: boolean;
  standstillDuration: number;
  leftBlinker: boolean;
  rightBlinker: boolean;
  leftBlindspot: boolean;
  rightBlindspot: boolean;
  path: Vec3Path | null;
  laneLines: { path: Vec3Path; prob: number }[];
  roadEdges: { path: Vec3Path; std: number }[];
  leads: OverlayLead[];
  rpy: [number, number, number] | null;
  height: number;
  roadName: string;
  speedLimitMs: number | null;
  // Engagement (MADS-aware).
  uiStatus: UiStatus;
  // Control / torque telemetry (developer UI + mici torque bar).
  curvature: number;
  desiredCurvature: number;
  latControlType: LatControlType;
  /** Lateral control actively steering (MADS-aware; drives path/lane/wheel/torque). */
  latActive: boolean;
  actuatorsTorque: number;
  torqueValid: boolean;
  frictionCoeff: number;
  latAccelFactor: number;
  /** Model confidence in [0,1] for mici confidence ball. null when unknown. */
  confidence: number | null;
  altitude: number | null;
  // Driver monitoring (mici DMoji + 3X face).
  dmActive: boolean;
  dmFaceDetected: boolean;
  dmIsRHD: boolean;
  dmFacePitch: number;
  dmFaceYaw: number;
  dmAwarenessUnfull: boolean;
  /** Smoothed + scaled head pose [yaw, pitch, roll], for 3X 3D face. */
  dmPoseVals: [number, number, number];
  /** Per-sample pose delta, for 3X arc thickness. */
  dmPoseDiff: [number, number, number];
};

export type Viewport = {
  width: number;
  height: number;
  content: { x: number; y: number; w: number; h: number };
  useMetric?: boolean;
  sunnypilot?: import("@/overlay/sunnypilotSettings").SunnypilotOverlaySettings;
};

export type OverlayPainter = {
  id: OverlayStyle;
  label: string;
  paint(ctx: CanvasRenderingContext2D, frame: OverlayFrame, viewport: Viewport): void;
};

export const EMPTY_FRAME: OverlayFrame = {
  t: 0,
  vEgo: null,
  engaged: null,
  engageable: false,
  experimentalMode: false,
  cruiseSpeed: null,
  aEgo: 0,
  steeringTorqueEps: 0,
  steeringAngleDeg: 0,
  steeringPressed: false,
  alert: null,
  standstill: false,
  standstillDuration: 0,
  leftBlinker: false,
  rightBlinker: false,
  leftBlindspot: false,
  rightBlindspot: false,
  path: null,
  laneLines: [],
  roadEdges: [],
  leads: [],
  rpy: null,
  height: 1.22,
  roadName: "",
  speedLimitMs: null,
  uiStatus: 0,
  curvature: 0,
  desiredCurvature: 0,
  latControlType: 4,
  latActive: false,
  actuatorsTorque: 0,
  torqueValid: false,
  frictionCoeff: 0,
  latAccelFactor: 0,
  confidence: null,
  altitude: null,
  dmActive: false,
  dmFaceDetected: false,
  dmIsRHD: false,
  dmFacePitch: 0,
  dmFaceYaw: 0,
  dmAwarenessUnfull: false,
  dmPoseVals: [0, 0, 0],
  dmPoseDiff: [0, 0, 0],
};
