import { FILE_NAMES } from "@/route/patterns";
import type { DataSource } from "@/source/types";
import type { RecordEntry } from "@/records";
import { timeToSegment, SEGMENT_SECONDS } from "@/playback/session";
import { EMPTY_FRAME, type GpsHud, type OverlayFrame } from "@/overlay/types";
import type { OverlaySegment, Timed } from "@/overlay/indexLog";
import { indexOverlayOffMain } from "@/overlay/overlayWorker";
import {
  interpCalib,
  interpCar,
  interpCtrl,
  interpDm,
  interpGps,
  interpLeads,
  interpModel,
  spanAt,
} from "@/overlay/interpolate";
import { recordCache, recordIndex } from "@/overlay/perf";

const CACHE_MAX = 8;

function standstillDuration(arr: Timed<{ vEgo: number; standstill: boolean }>[], t: number): number {
  if (arr.length === 0) return 0;
  let lo = 0;
  let hi = arr.length - 1;
  if (t < arr[0]!.t) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  const cur = arr[lo]!;
  if (!cur.value.standstill && Math.abs(cur.value.vEgo) > 0.35) return 0;
  let i = lo;
  while (i > 0) {
    const prev = arr[i - 1]!;
    if (!prev.value.standstill && Math.abs(prev.value.vEgo) > 0.35) break;
    i--;
  }
  return Math.max(0, t - arr[i]!.t);
}

async function findOverlayLog(source: DataSource, segmentDir: string): Promise<string | null> {
  const entries = await source.list(segmentDir);
  for (const name of [...FILE_NAMES.qlog, ...FILE_NAMES.rlog]) {
    const hit = entries.find((e) => e.kind === "file" && e.name === name);
    if (hit) return hit.path;
  }
  return null;
}

const emptySeg = (): OverlaySegment => ({
  models: [],
  car: [],
  sd: [],
  ctrl: [],
  gps: [],
  dm: [],
  calib: [],
  radarLeads: [],
  map: [],
  frameOffset: 0,
});

/**
 * Per-segment cereal index. Prefetches a lookahead window off the main thread
 * so playback can paint every frame from a warm cache.
 */
export class CerealTimeline {
  private source: DataSource;
  private record: RecordEntry;
  private cache = new Map<number, OverlaySegment>();
  private inflight = new Map<number, Promise<OverlaySegment>>();
  private lastRpy: [number, number, number] | null = null;
  private lastHeight = 1.22;
  private lastFrame: OverlayFrame | null = null;
  private center = 0;

  constructor(source: DataSource, record: RecordEntry) {
    this.source = source;
    this.record = record;
  }

  hasSegment(index: number): boolean {
    return this.cache.has(index);
  }

  /**
   * Keep `center` plus `ahead` future segments (and one behind) parsed.
   * Cheap to call every frame — no-ops when already cached / in flight.
   */
  prefetchWindow(center: number, ahead: number): void {
    const n = this.record.segmentPaths.length;
    if (n <= 0) return;
    this.center = Math.min(Math.max(0, center), n - 1);
    void this.ensureSegment(this.center, 0);
    for (let k = 1; k <= ahead; k++) {
      const i = this.center + k;
      if (i < n) void this.ensureSegment(i, k);
    }
    if (this.center > 0) void this.ensureSegment(this.center - 1, 20);
  }

  async ensureSegment(index: number, priority = 5): Promise<void> {
    if (index < 0 || index >= this.record.segmentPaths.length) return;
    if (this.cache.has(index)) return;
    if (this.inflight.has(index)) {
      await this.inflight.get(index);
      return;
    }
    const task = this.loadSegment(index, priority);
    this.inflight.set(index, task);
    try {
      this.cache.set(index, await task);
      this.evict();
    } finally {
      this.inflight.delete(index);
    }
  }

  stateAt(driveTime: number, interpolate = true): OverlayFrame {
    const { index, offset } = timeToSegment(driveTime, this.record.segmentPaths.length);
    const seg = this.cache.get(index);
    recordCache(index, Boolean(seg));
    if (!seg) {
      if (this.lastFrame) return { ...this.lastFrame, t: driveTime };
      return { ...EMPTY_FRAME, t: driveTime, rpy: this.lastRpy, height: this.lastHeight };
    }

    // Sample times are on the telemetry clock; the video offset is on the frame
    // clock. Shift by the segment's frameOffset so the HUD lines up with video.
    const sampleT = offset + seg.frameOffset;
    const modelSpan = spanAt(seg.models, sampleT);
    const carSpan = spanAt(seg.car, sampleT);
    const sd = spanAt(seg.sd, sampleT);
    const ctrlSpan = spanAt(seg.ctrl, sampleT);
    const calibSpan = spanAt(seg.calib, sampleT);
    const model = interpModel(modelSpan, interpolate);
    const car = interpCar(carSpan, interpolate);
    const ctrl = interpCtrl(ctrlSpan, interpolate);
    const calib = interpCalib(calibSpan, interpolate);
    const radar = interpLeads(spanAt(seg.radarLeads, sampleT), interpolate);
    const map = spanAt(seg.map, sampleT)?.lo;
    const gps = this.gpsAt(driveTime, interpolate);
    const dmSpan = spanAt(seg.dm, sampleT);
    const dm = interpDm(dmSpan, interpolate);
    if (calib) {
      this.lastRpy = calib.rpy;
      this.lastHeight = calib.height;
    }

    // Reconcile engagement/MADS status with carControl.latActive. When the log
    // has no selfdriveStateSP (MADS) messages, ss.enabled alone misses lat-only
    // engagement, so fold in carControl.latActive as the lateral ground truth.
    const sdv = sd?.lo;
    const ssEnabled = sdv?.ssEnabled ?? sdv?.engaged ?? false;
    const ctrlLat = ctrl?.latActive ?? false;
    let uiStatus: OverlayFrame["uiStatus"];
    let latActive: boolean;
    if (sdv?.madsAvailable) {
      uiStatus = sdv.uiStatus;
      latActive = sdv.latActive;
    } else if (sdv?.madsPaused) {
      uiStatus = 2;
      latActive = false;
    } else {
      const lat = ctrlLat;
      const long = ssEnabled;
      uiStatus = lat && long ? 1 : lat ? 3 : long ? 4 : 0;
      latActive = lat;
    }

    const frame: OverlayFrame = {
      t: driveTime,
      vEgo: car?.vEgo ?? this.lastFrame?.vEgo ?? null,
      engaged: sd?.lo.engaged ?? this.lastFrame?.engaged ?? null,
      engageable: sd?.lo.engageable ?? this.lastFrame?.engageable ?? false,
      experimentalMode: sd?.lo.experimentalMode ?? this.lastFrame?.experimentalMode ?? false,
      cruiseSpeed: car?.cruiseSpeed ?? this.lastFrame?.cruiseSpeed ?? null,
      aEgo: car?.aEgo ?? this.lastFrame?.aEgo ?? 0,
      steeringTorqueEps: car?.steeringTorqueEps ?? this.lastFrame?.steeringTorqueEps ?? 0,
      steeringAngleDeg: car?.steeringAngleDeg ?? this.lastFrame?.steeringAngleDeg ?? 0,
      steeringPressed: car?.steeringPressed ?? false,
      alert: sd ? sd.lo.alert : (this.lastFrame?.alert ?? null),
      standstill: car?.standstill ?? false,
      standstillDuration: standstillDuration(seg.car, sampleT),
      leftBlinker: car?.leftBlinker ?? false,
      rightBlinker: car?.rightBlinker ?? false,
      leftBlindspot: car?.leftBlindspot ?? false,
      rightBlindspot: car?.rightBlindspot ?? false,
      path: model?.path ?? this.lastFrame?.path ?? null,
      laneLines: model?.laneLines ?? [],
      roadEdges: model?.roadEdges ?? [],
      leads: (model?.leads.length ? model.leads : null) ?? radar,
      rpy: calib?.rpy ?? this.lastRpy,
      height: calib?.height ?? this.lastHeight,
      roadName: map?.roadName || this.lastFrame?.roadName || "",
      speedLimitMs: map?.speedLimitMs ?? this.lastFrame?.speedLimitMs ?? null,
      uiStatus: sd || ctrl ? uiStatus : (this.lastFrame?.uiStatus ?? 0),
      curvature: ctrl?.curvature ?? this.lastFrame?.curvature ?? 0,
      desiredCurvature: ctrl?.desiredCurvature ?? this.lastFrame?.desiredCurvature ?? 0,
      latControlType: ctrl?.latControlType ?? this.lastFrame?.latControlType ?? 4,
      latActive: sd || ctrl ? latActive : (this.lastFrame?.latActive ?? false),
      actuatorsTorque: ctrl?.actuatorsTorque ?? this.lastFrame?.actuatorsTorque ?? 0,
      torqueValid: ctrl?.torqueValid ?? this.lastFrame?.torqueValid ?? false,
      frictionCoeff: ctrl?.frictionCoeff ?? this.lastFrame?.frictionCoeff ?? 0,
      latAccelFactor: ctrl?.latAccelFactor ?? this.lastFrame?.latAccelFactor ?? 0,
      confidence: model?.confidence ?? this.lastFrame?.confidence ?? null,
      altitude: gps?.altitude ?? this.lastFrame?.altitude ?? null,
      latitude: gps?.latitude ?? this.lastFrame?.latitude ?? null,
      longitude: gps?.longitude ?? this.lastFrame?.longitude ?? null,
      bearingDeg: gps?.bearingDeg ?? this.lastFrame?.bearingDeg ?? null,
      dmActive: dm?.active ?? false,
      dmFaceDetected: dm?.faceDetected ?? false,
      dmIsRHD: dm?.isRHD ?? this.lastFrame?.dmIsRHD ?? false,
      dmFacePitch: dm?.facePitch ?? this.lastFrame?.dmFacePitch ?? 0,
      dmFaceYaw: dm?.faceYaw ?? this.lastFrame?.dmFaceYaw ?? 0,
      dmAwarenessUnfull: dm?.awarenessUnfull ?? false,
      dmPoseVals: dm?.poseVals ?? this.lastFrame?.dmPoseVals ?? [0, 0, 0],
      dmPoseDiff: dm?.poseDiff ?? this.lastFrame?.dmPoseDiff ?? [0, 0, 0],
    };
    this.lastFrame = frame;
    return frame;
  }

  /**
   * GPS at drive time, lerped between samples. Looks at neighboring cached
   * segments so gaps between sparse fixes (and segment boundaries) stay smooth.
   */
  private gpsAt(driveTime: number, interpolate: boolean): GpsHud | null {
    const n = this.record.segmentPaths.length;
    const { index } = timeToSegment(driveTime, n);
    const samples: Timed<GpsHud>[] = [];
    // Convert telemetry sample times to the video clock (subtract frameOffset)
    // so they compare correctly against driveTime.
    for (let i = Math.max(0, index - 1); i <= Math.min(n - 1, index + 1); i++) {
      const seg = this.cache.get(i);
      if (!seg) continue;
      const base = i * SEGMENT_SECONDS - seg.frameOffset;
      for (const s of seg.gps) samples.push({ t: base + s.t, value: s.value });
    }
    if (samples.length === 0) {
      for (const [i, seg] of this.cache) {
        const base = i * SEGMENT_SECONDS - seg.frameOffset;
        for (const s of seg.gps) samples.push({ t: base + s.t, value: s.value });
      }
    }
    if (samples.length === 0) return null;
    samples.sort((a, b) => a.t - b.t);
    return interpGps(spanAt(samples, driveTime), interpolate);
  }

  /** Lat/lon track from cached segments, in drive order (for the map polyline). */
  gpsPath(): [number, number][] {
    const out: [number, number][] = [];
    const n = this.record.segmentPaths.length;
    for (let i = 0; i < n; i++) {
      const seg = this.cache.get(i);
      if (!seg) continue;
      for (const sample of seg.gps) {
        const { latitude, longitude } = sample.value;
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          out.push([latitude, longitude]);
        }
      }
    }
    return out;
  }

  private evict(): void {
    while (this.cache.size > CACHE_MAX) {
      let worst = -1;
      let worstDist = -1;
      for (const key of this.cache.keys()) {
        const dist = Math.abs(key - this.center);
        if (dist <= 1) continue;
        if (dist > worstDist) {
          worstDist = dist;
          worst = key;
        }
      }
      if (worst < 0) break;
      this.cache.delete(worst);
    }
  }

  private async loadSegment(index: number, priority: number): Promise<OverlaySegment> {
    const segDir = this.record.segmentPaths[index];
    if (!segDir) return emptySeg();

    const logPath = await findOverlayLog(this.source, segDir);
    if (!logPath) {
      console.warn("[replay:overlay] no qlog/rlog in", segDir);
      return emptySeg();
    }

    let bytes: Uint8Array;
    const tRead = performance.now();
    try {
      bytes = await this.source.read(logPath);
    } catch (err) {
      console.error("[replay:overlay] read failed", logPath, err);
      return emptySeg();
    }
    const readMs = performance.now() - tRead;

    try {
      const tParse = performance.now();
      const seg = await indexOverlayOffMain(bytes, priority);
      const parseMs = performance.now() - tParse;
      recordIndex({
        at: performance.now(),
        segment: index,
        path: logPath,
        bytes: bytes.byteLength,
        readMs,
        parseMs,
        models: seg.models.length,
        car: seg.car.length,
      });
      console.info(
        "[replay:overlay]",
        logPath,
        "read",
        Math.round(readMs),
        "ms parse",
        Math.round(parseMs),
        "ms",
        (bytes.byteLength / 1e6).toFixed(2),
        "MB models",
        seg.models.length,
        "car",
        seg.car.length,
      );
      return seg;
    } catch (err) {
      console.error("[replay:overlay] index failed", logPath, err);
      return emptySeg();
    }
  }
}
