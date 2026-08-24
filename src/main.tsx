import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { SettingsProvider } from "@/settings";
import { App } from "@/App";
import "@/index.css";

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <SettingsProvider>
        <App />
        <Toaster />
      </SettingsProvider>
    </ThemeProvider>
  </StrictMode>,
);
