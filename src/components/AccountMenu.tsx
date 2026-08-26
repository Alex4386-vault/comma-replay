import { useState, type FormEvent } from "react";
import { SettingsIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AuthUser } from "@/api";
import { useSettings } from "@/settings";
import type { ChevronInfo, DevUiInfo } from "@/overlay/sunnypilotSettings";

type AccountMenuProps = {
  user: AuthUser | null;
  onLogout: () => void;
};

export function AccountMenu({ user, onLogout }: AccountMenuProps) {
  const { settings, setSettings } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState(settings);
  const initials = (user?.name || user?.email || "?").slice(0, 1).toUpperCase();

  function openSettings() {
    setDraft(settings);
    setSettingsOpen(true);
  }

  function onSettingsSubmit(e: FormEvent) {
    e.preventDefault();
    setSettings(draft);
    setSettingsOpen(false);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="rounded-full outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            title={user ? user.name || user.email || "Account" : "Account"}
          >
            <Avatar size="sm">
              {user?.avatarUrl ? (
                <AvatarImage src={user.avatarUrl} alt={user.name || user.email || ""} />
              ) : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuGroup>
            {user ? (
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">
                    {user.name || user.email || user.id}
                  </span>
                  {user.email ? (
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      {user.email}
                    </span>
                  ) : null}
                </div>
              </DropdownMenuLabel>
            ) : (
              <DropdownMenuLabel>Account</DropdownMenuLabel>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                openSettings();
              }}
            >
              <SettingsIcon />
              Settings
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {user ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" onSelect={() => onLogout()}>
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="gap-0 p-0 sm:max-w-lg">
          <form onSubmit={onSettingsSubmit}>
            <DialogHeader className="gap-1.5 border-b px-5 py-4">
              <DialogTitle>Settings</DialogTitle>
              <DialogDescription>
                Preferences for this browser. Press Enter to save.
              </DialogDescription>
            </DialogHeader>

            <div className="flex max-h-[min(70vh,36rem)] flex-col gap-4 overflow-y-auto px-5 py-4">
              {user ? (
                <div className="flex flex-col gap-0.5 text-sm">
                  <span className="text-xs text-muted-foreground">Signed in as</span>
                  <span className="font-medium">{user.name || "—"}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {user.email || user.id}
                  </span>
                </div>
              ) : null}

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="setting-metric">Use metric</FieldLabel>
                  <FieldDescription>Show distance in kilometers instead of miles.</FieldDescription>
                </FieldContent>
                <Switch
                  id="setting-metric"
                  checked={draft.useMetric}
                  onCheckedChange={(checked) =>
                    setDraft((d) => ({ ...d, useMetric: checked }))
                  }
                />
              </Field>

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="setting-geocode">Reverse geocode</FieldLabel>
                  <FieldDescription>
                    Resolve GPS locks to place names (server-cached when signed in; off by default).
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="setting-geocode"
                  checked={draft.reverseGeocode}
                  onCheckedChange={(checked) =>
                    setDraft((d) => ({ ...d, reverseGeocode: checked }))
                  }
                />
              </Field>

              <div className="flex flex-col gap-3 border-t pt-4">
                <div>
                  <h2 className="text-sm font-medium">sunnypilot overlay settings</h2>
                  <p className="text-xs text-muted-foreground">
                    Applied when the player overlay is set to comma 3X sunnypilot. Matches the Visuals
                    HUD toggles (road name and chime alerts are not replayed).
                  </p>
                </div>
                {(
                  [
                    ["showTurnSignals", "Display turn signals", "Amber arrows when blinkers are on."],
                    ["blindSpot", "Show blind spot warnings", "BSM markers when carState reports a blind-spot vehicle."],
                    ["torqueBar", "Steering arc", "Arc at the bottom from steeringTorqueEps while engaged."],
                    ["rocketFuel", "Real-time acceleration bar", "Left-side bar from aEgo."],
                    ["standstillTimer", "Standstill timer", "HUD timer while the car is stopped."],
                    ["rainbowMode", "Tesla rainbow mode", "Rainbow path fill. Cosmetic only."],
                    ["hideVEgoUi", "Speedometer: hide from onroad", "Hide the large speed readout."],
                    ["alwaysDisplayBlinker", "comma 4: always display blinker", "Show turn-signal icons whenever the blinker is on, not just during a lane change."],
                  ] as const
                ).map(([key, title, desc]) => (
                  <Field key={key} orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor={`sp-${key}`}>{title}</FieldLabel>
                      <FieldDescription>{desc}</FieldDescription>
                    </FieldContent>
                    <Switch
                      id={`sp-${key}`}
                      checked={draft.sunnypilotOverlay[key]}
                      onCheckedChange={(checked) =>
                        setDraft((d) => ({
                          ...d,
                          sunnypilotOverlay: { ...d.sunnypilotOverlay, [key]: checked },
                        }))
                      }
                    />
                  </Field>
                ))}
                <Field>
                  <FieldContent>
                    <FieldLabel>Display metrics below chevron</FieldLabel>
                    <FieldDescription>Distance, lead speed, and/or time-to-collision under the lead marker.</FieldDescription>
                    <Select
                      value={String(draft.sunnypilotOverlay.chevronInfo)}
                      onValueChange={(value) =>
                        setDraft((d) => ({
                          ...d,
                          sunnypilotOverlay: {
                            ...d.sunnypilotOverlay,
                            chevronInfo: Number(value) as ChevronInfo,
                          },
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">Off</SelectItem>
                        <SelectItem value="1">Distance</SelectItem>
                        <SelectItem value="2">Speed</SelectItem>
                        <SelectItem value="3">Time</SelectItem>
                        <SelectItem value="4">All</SelectItem>
                      </SelectContent>
                    </Select>
                  </FieldContent>
                </Field>
                <Field>
                  <FieldContent>
                    <FieldLabel>Developer UI</FieldLabel>
                    <FieldDescription>vEgo, aEgo, and torque on the overlay.</FieldDescription>
                    <Select
                      value={String(draft.sunnypilotOverlay.devUiInfo)}
                      onValueChange={(value) =>
                        setDraft((d) => ({
                          ...d,
                          sunnypilotOverlay: {
                            ...d.sunnypilotOverlay,
                            devUiInfo: Number(value) as DevUiInfo,
                          },
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">Off</SelectItem>
                        <SelectItem value="1">Bottom</SelectItem>
                        <SelectItem value="2">Right</SelectItem>
                        <SelectItem value="3">Right &amp; Bottom</SelectItem>
                      </SelectContent>
                    </Select>
                  </FieldContent>
                </Field>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSettingsOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Done</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
