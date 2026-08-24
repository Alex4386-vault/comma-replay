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

export async function exchangeCodeForAccessToken(
  provider: OAuthProvider,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<string> {
  const id = clientId(provider);
  if (!id) throw new Error(`${provider} client id not configured (missing at build time)`);

  if (provider === "google") {
    const body = new URLSearchParams({
      client_id: id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`google token: ${res.status} ${text}`);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error("google token: missing access_token");
    return json.access_token;
  }

  const body = new URLSearchParams({
    client_id: id,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`github token: ${res.status} ${text}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (json.error || !json.access_token) {
    throw new Error(json.error_description || json.error || "github token: missing access_token");
  }
  return json.access_token;
}

export async function finishLoginFromCallback(search: string): Promise<{
  provider: OAuthProvider;
  accessToken: string;
}> {
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

  const accessToken = await exchangeCodeForAccessToken(
    pending.provider,
    code,
    pending.verifier,
    pending.redirectUri,
  );
  return { provider: pending.provider, accessToken };
}
