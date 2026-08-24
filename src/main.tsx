import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { SettingsProvider } from "@/settings";
import { App } from "@/App";
import { AuthCallback } from "@/components/AuthCallback";
import "@/index.css";

const isAuthCallback = window.location.pathname.replace(/\/$/, "") === "/auth/callback";

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <SettingsProvider>
        {isAuthCallback ? <AuthCallback /> : <App />}
        <Toaster />
      </SettingsProvider>
    </ThemeProvider>
  </StrictMode>,
);
