import { createPkcePair, randomState } from "./pkce";
import { getAuthConfig, type OAuthProvider } from "./config";

export type { OAuthProvider } from "./config";
export { configuredProviders, loadAuthConfig, getAuthConfig } from "./config";

const PKCE_KEY = "comma-replay.pkce";

type PkcePending = {
  provider: OAuthProvider;
  verifier: string;
  state: string;
  redirectUri: string;
};

export type AuthCodePayload = {
  provider: OAuthProvider;
  code: string;
  codeVerifier: string;
  redirectUri: string;
};

function savePending(p: PkcePending): void {
  sessionStorage.setItem(PKCE_KEY, JSON.stringify(p));
}

function takePending(): PkcePending | null {
  const raw = sessionStorage.getItem(PKCE_KEY);
  sessionStorage.removeItem(PKCE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PkcePending;
  } catch {
    return null;
  }
}

function clientId(provider: OAuthProvider): string {
  const c = getAuthConfig();
  return provider === "google" ? c.googleClientId : c.githubClientId;
}

/** Start PKCE authorize redirect (Client ID only; no token exchange in the browser). */
export async function startLogin(provider: OAuthProvider): Promise<void> {
  const id = clientId(provider);
  if (!id) throw new Error(`${provider} client id not configured (missing at build time)`);

  const { verifier, challenge } = await createPkcePair();
  const state = randomState();
  const redirectUri = getAuthConfig().redirectUri;
  savePending({ provider, verifier, state, redirectUri });

  const url = new URL(
    provider === "google"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://github.com/login/oauth/authorize",
  );
  url.searchParams.set("client_id", id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  if (provider === "google") {
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");
  } else {
    url.searchParams.set("scope", "read:user user:email");
  }

  window.location.assign(url.toString());
}

/** Validate callback query + PKCE state; return code payload for POST /auth/session. */
export function finishLoginFromCallback(search: string): AuthCodePayload {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const err = params.get("error");
  if (err) {
    throw new Error(params.get("error_description") || err);
  }
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) throw new Error("missing code or state");

  const pending = takePending();
  if (!pending || pending.state !== state) {
    throw new Error("invalid or expired OAuth state");
  }

  return {
    provider: pending.provider,
    code,
    codeVerifier: pending.verifier,
    redirectUri: pending.redirectUri,
  };
}
