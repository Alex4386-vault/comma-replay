export type OAuthProvider = "google" | "github";

export type AuthConfig = {
  apiBase: string;
  googleClientId: string;
  githubClientId: string;
  redirectUri: string;
};

declare const __BAKED_API_BASE__: string;
declare const __BAKED_GOOGLE_CLIENT_ID__: string;
declare const __BAKED_GITHUB_CLIENT_ID__: string;

/** Values are string-literal–baked by vite `define` at build time. */
export function getAuthConfig(): AuthConfig {
  return {
    apiBase: __BAKED_API_BASE__,
    googleClientId: __BAKED_GOOGLE_CLIENT_ID__,
    githubClientId: __BAKED_GITHUB_CLIENT_ID__,
    redirectUri: `${window.location.origin}/auth/callback`,
  };
}

export function configuredProviders(): { google: boolean; github: boolean } {
  const c = getAuthConfig();
  return {
    google: Boolean(c.googleClientId),
    github: Boolean(c.githubClientId),
  };
}

export async function loadAuthConfig(): Promise<AuthConfig> {
  return getAuthConfig();
}
