import { clearApiToken, getApiToken, setApiToken } from "@/auth/token";
import { configuredProviders } from "@/auth/oauth";

/** Base URL for the Go API (`server/`). Empty = same origin. */
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
  const headers = new Headers(init?.headers);
  const token = getApiToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
}

/** Providers come from FE Client IDs (not the API). */
export function fetchProviders(): AuthProviders {
  return configuredProviders();
}

export async function createSession(
  provider: "google" | "github",
  accessToken: string,
): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ provider, accessToken }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `session: ${res.status}`);
  }
  const body = (await res.json()) as { token?: string; user?: AuthUser };
  if (!body.token || !body.user) throw new Error("session: missing token or user");
  setApiToken(body.token);
  return body.user;
}

export async function fetchMe(): Promise<AuthUser | null> {
  if (!getApiToken()) return null;
  const res = await apiFetch("/api/me");
  if (res.status === 401) {
    clearApiToken();
    return null;
  }
  if (!res.ok) throw new Error(`me: ${res.status}`);
  return res.json();
}

export async function logout(): Promise<void> {
  try {
    if (getApiToken()) {
      await apiFetch("/auth/logout", { method: "POST" });
    }
  } finally {
    clearApiToken();
  }
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
