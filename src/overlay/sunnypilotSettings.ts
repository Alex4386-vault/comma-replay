/** sunnypilot Visuals page — HUD overlays we can draw in replay. */

export type ChevronInfo = 0 | 1 | 2 | 3 | 4;
export type DevUiInfo = 0 | 1 | 2 | 3;

export type SunnypilotOverlaySettings = {
  blindSpot: boolean;
  torqueBar: boolean;
  showTurnSignals: boolean;
  standstillTimer: boolean;
  rocketFuel: boolean;
  rainbowMode: boolean;
  hideVEgoUi: boolean;
  /** comma 4 only: always draw blinker icons, not just during a lane change. */
  alwaysDisplayBlinker: boolean;
  /** 0 off, 1 distance, 2 speed, 3 time, 4 all */
  chevronInfo: ChevronInfo;
  /** 0 off, 1 bottom, 2 right, 3 both */
  devUiInfo: DevUiInfo;
};

export const DEFAULT_SUNNYPILOT_OVERLAY: SunnypilotOverlaySettings = {
  blindSpot: false,
  torqueBar: false,
  showTurnSignals: false,
  standstillTimer: false,
  rocketFuel: false,
  rainbowMode: false,
  hideVEgoUi: false,
  alwaysDisplayBlinker: false,
  chevronInfo: 4,
  devUiInfo: 0,
};

export function mergeSunnypilotOverlay(
  raw: Partial<SunnypilotOverlaySettings> | undefined,
): SunnypilotOverlaySettings {
  const chevron = Number(raw?.chevronInfo);
  const dev = Number(raw?.devUiInfo);
  return {
    ...DEFAULT_SUNNYPILOT_OVERLAY,
    ...raw,
    chevronInfo: ([0, 1, 2, 3, 4].includes(chevron) ? chevron : 4) as ChevronInfo,
    devUiInfo: ([0, 1, 2, 3].includes(dev) ? dev : 0) as DevUiInfo,
  };
}
