/** App path helpers for device / drive URLs. */

export function devicePath(deviceId: string): string {
  return `/devices/${encodeURIComponent(deviceId)}`;
}

export function drivePath(deviceId: string, recordId: string): string {
  return `/devices/${encodeURIComponent(deviceId)}/drives/${encodeURIComponent(recordId)}`;
}
