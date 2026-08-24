import { FolderOpenIcon, LogInIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { API_BASE, type AuthProviders } from "@/api";
import { startLogin, type OAuthProvider } from "@/auth/oauth";

type SourcePickerTabsProps = {
  providers: AuthProviders | null;
  onOpenLocal: () => void;
};

export function SourcePickerTabs({ providers, onOpenLocal }: SourcePickerTabsProps) {
  const signInAvailable = Boolean(providers?.google || providers?.github);
  const defaultTab = signInAvailable ? "signin" : "local";

  async function onSignIn(provider: OAuthProvider) {
    try {
      await startLogin(provider);
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md rounded-xl border bg-card p-6">
      <Tabs defaultValue={defaultTab}>
        <TabsList className="mb-4 w-full">
          <TabsTrigger value="signin" className="flex-1">
            Sign in
          </TabsTrigger>
          <TabsTrigger value="local" className="flex-1">
            Local
          </TabsTrigger>
        </TabsList>

        <TabsContent value="signin" className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Browse recordings from the server at{" "}
            <code className="font-mono text-xs">{"{user_id}/{device_id}/{record_id}"}</code>.
          </p>
          <div className="flex flex-col gap-2">
            {providers?.google ? (
              <Button type="button" onClick={() => onSignIn("google")}>
                <LogInIcon data-icon="inline-start" />
                Sign in with Google
              </Button>
            ) : null}
            {providers?.github ? (
              <Button type="button" variant="outline" onClick={() => onSignIn("github")}>
                <LogInIcon data-icon="inline-start" />
                Sign in with GitHub
              </Button>
            ) : null}
            {!signInAvailable ? (
              <Button
                type="button"
                variant="outline"
                disabled
                title={`Rebuild with VITE_GOOGLE_CLIENT_ID / VITE_GITHUB_CLIENT_ID. API: ${API_BASE || "(empty)"}`}
              >
                Sign in unavailable
              </Button>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent value="local" className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Open a folder from this machine. You will choose{" "}
            <code className="font-mono text-xs">{"{record_id}"}</code> or{" "}
            <code className="font-mono text-xs">{"{device_id}/{record_id}"}</code> layout first.
          </p>
          <Button type="button" variant="outline" onClick={onOpenLocal}>
            <FolderOpenIcon data-icon="inline-start" />
            Bring your own directory
          </Button>
        </TabsContent>
      </Tabs>
    </div>
  );
}
