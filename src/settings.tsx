import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  DEFAULT_SUNNYPILOT_OVERLAY,
  mergeSunnypilotOverlay,
  type SunnypilotOverlaySettings,
} from "@/overlay/sunnypilotSettings";

export type { SunnypilotOverlaySettings };

export type DriveFilter = "all" | "video" | "complete";

export type AppSettings = {
  reverseGeocode: boolean;
  useMetric: boolean;
  showMap: boolean;
  showCan: boolean;
  /** CAN inspector in its own window instead of beside the video. */
  canPopout: boolean;
  /** Drive list: hide drives with no synced logs or video. */
  hideEmptyDrives: boolean;
  /** Drive list: "video" = has any video, "complete" = every segment has video and logs. */
  driveFilter: DriveFilter;
  overlayMetrics: boolean;
  disableOverlayInterpolation: boolean;
  sunnypilotOverlay: SunnypilotOverlaySettings;
};

const STORAGE_KEY = "comma-replay.settings";

const DEFAULT_SETTINGS: AppSettings = {
  reverseGeocode: false,
  useMetric: true,
  showMap: false,
  showCan: false,
  canPopout: false,
  hideEmptyDrives: true,
  driveFilter: "all",
  overlayMetrics: false,
  disableOverlayInterpolation: false,
  sunnypilotOverlay: { ...DEFAULT_SUNNYPILOT_OVERLAY },
};

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, sunnypilotOverlay: { ...DEFAULT_SUNNYPILOT_OVERLAY } };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      reverseGeocode: Boolean(parsed.reverseGeocode),
      useMetric: parsed.useMetric ?? DEFAULT_SETTINGS.useMetric,
      showMap: Boolean(parsed.showMap),
      showCan: Boolean(parsed.showCan),
      canPopout: Boolean(parsed.canPopout),
      hideEmptyDrives: parsed.hideEmptyDrives ?? DEFAULT_SETTINGS.hideEmptyDrives,
      driveFilter:
        parsed.driveFilter === "video" || parsed.driveFilter === "complete" ? parsed.driveFilter : "all",
      overlayMetrics: Boolean(parsed.overlayMetrics),
      disableOverlayInterpolation: Boolean(parsed.disableOverlayInterpolation),
      sunnypilotOverlay: mergeSunnypilotOverlay(parsed.sunnypilotOverlay),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, sunnypilotOverlay: { ...DEFAULT_SUNNYPILOT_OVERLAY } };
  }
}

function saveSettings(settings: AppSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

type SettingsContextValue = {
  settings: AppSettings;
  setSettings: (patch: Partial<AppSettings>) => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<AppSettings>(() => loadSettings());

  const setSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      if (patch.sunnypilotOverlay) {
        next.sunnypilotOverlay = { ...prev.sunnypilotOverlay, ...patch.sunnypilotOverlay };
      }
      saveSettings(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ settings, setSettings }), [settings, setSettings]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings requires SettingsProvider");
  return ctx;
}
