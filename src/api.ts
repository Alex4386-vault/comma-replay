import { clearApiToken, getApiToken, setApiToken } from "@/auth/token";
import { configuredProviders, getAuthConfig } from "@/auth/config";

export function apiBase(): string {
  return getAuthConfig().apiBase;
}

export const API_BASE = apiBase();

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
  return fetch(`${apiBase()}${path}`, {
    ...init,
    headers,
  });
}

export function fetchProviders(): AuthProviders {
  return configuredProviders();
}

export async function createSession(payload: {
  provider: "google" | "github";
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<AuthUser> {
  const res = await fetch(`${apiBase()}/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
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

export async function fetchDevices(): Promise<string[]> {
  const res = await apiFetch("/api/devices");
  if (!res.ok) throw new Error(`devices: ${res.status}`);
  const body = (await res.json()) as { devices?: string[] | null };
  return body.devices ?? [];
}

export async function fetchRecords(deviceId: string): Promise<string[]> {
  const res = await apiFetch(`/api/devices/${encodeURIComponent(deviceId)}/records`);
  if (!res.ok) throw new Error(`records: ${res.status}`);
  const body = (await res.json()) as { records?: string[] | null };
  return body.records ?? [];
}

export type RecordFileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
};

export async function fetchRecordFiles(
  deviceId: string,
  recordId: string,
): Promise<RecordFileEntry[]> {
  const res = await apiFetch(
    `/api/devices/${encodeURIComponent(deviceId)}/records/${encodeURIComponent(recordId)}/files`,
  );
  if (!res.ok) throw new Error(`files: ${res.status}`);
  const body = (await res.json()) as { files?: RecordFileEntry[] | null };
  return body.files ?? [];
}

export async function fetchRecordFileResponse(
  deviceId: string,
  recordId: string,
  rel: string,
  init?: RequestInit,
): Promise<Response> {
  const clean = rel.replace(/^\/+/, "");
  const path =
    `/api/devices/${encodeURIComponent(deviceId)}` +
    `/records/${encodeURIComponent(recordId)}` +
    `/files/${clean.split("/").map(encodeURIComponent).join("/")}`;
  return apiFetch(path, init);
}
