const TOKEN_KEY = "comma-replay.apiToken";

export function getApiToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setApiToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearApiToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}
