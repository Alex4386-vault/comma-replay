import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { SettingsProvider } from "@/settings";
import { App } from "@/App";
import { AuthCallback } from "@/components/AuthCallback";
import "@/index.css";

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <SettingsProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="*" element={<App />} />
          </Routes>
        </BrowserRouter>
        <Toaster />
      </SettingsProvider>
    </ThemeProvider>
  </StrictMode>,
);
