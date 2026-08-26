import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Spinner } from "@/components/ui/spinner";
import { createSession } from "@/api";
import { finishLoginFromCallback } from "@/auth/oauth";

/** OAuth redirect target: /auth/callback?code=&state= */
export function AuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = finishLoginFromCallback(window.location.search);
        await createSession(payload);
        if (cancelled) return;
        navigate("/", { replace: true });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  if (error) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3 p-6">
        <p className="text-sm font-medium text-destructive">Sign-in failed</p>
        <p className="max-w-md text-center text-sm text-muted-foreground">{error}</p>
        <Link to="/" className="text-sm underline">
          Back
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      Completing sign-in…
    </div>
  );
}
