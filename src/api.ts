/** Base URL for replay-server. Empty = same origin. */
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

export type AuthUser = {
  id: string;
  email?: string;
  name?: string;
  provider: string;
  avatarUrl?: string;
};

export type AuthProviders = { google: boolean; github: boolean };

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
  });
}

export async function fetchProviders(): Promise<AuthProviders> {
  const res = await apiFetch("/auth/providers");
  if (!res.ok) return { google: false, github: false };
  return res.json();
}

export async function fetchMe(): Promise<AuthUser | null> {
  const res = await apiFetch("/api/me");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`me: ${res.status}`);
  return res.json();
}

export function signInUrl(provider: "google" | "github"): string {
  return `${API_BASE}/auth/${provider}`;
}

export async function logout(): Promise<void> {
  await apiFetch("/auth/logout", { method: "POST" });
}

/** Server tree is always {user_id}/{device_id}/{record_id}. */
export async function fetchDevices(): Promise<string[]> {
  const res = await apiFetch("/api/devices");
  if (!res.ok) throw new Error(`devices: ${res.status}`);
  const body = (await res.json()) as { devices?: string[] };
  return body.devices ?? [];
}

export async function fetchRecords(deviceId: string): Promise<string[]> {
  const res = await apiFetch(`/api/devices/${encodeURIComponent(deviceId)}/records`);
  if (!res.ok) throw new Error(`records: ${res.status}`);
  const body = (await res.json()) as { records?: string[] };
  return body.records ?? [];
}
