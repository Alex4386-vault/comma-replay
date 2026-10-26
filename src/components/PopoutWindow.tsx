import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Open a popup window. Call this straight from a click handler: browsers only
 * allow popups during a user gesture, and opening one consumes that gesture.
 */
export function openPopoutWindow(name: string, width = 1000, height = 820): Window | null {
  return window.open("", name, `popup,width=${width},height=${height}`);
}

/** Copy stylesheets into the popup, with absolute URLs (fonts, chunk CSS). */
function cloneStyle(node: Node, into: Document): void {
  if (node instanceof HTMLStyleElement) {
    into.head.appendChild(node.cloneNode(true));
  } else if (node instanceof HTMLLinkElement && node.rel === "stylesheet") {
    const link = into.createElement("link");
    link.rel = "stylesheet";
    link.href = node.href;
    into.head.appendChild(link);
  }
}

/**
 * Renders `children` into an already opened popup (see openPopoutWindow) via a
 * portal, so the panel keeps sharing this page's React state (playback clock,
 * data source, auth) while it sits on another screen. `onClosed` fires when
 * the user closes the window.
 */
export function PopoutWindow({
  win,
  title,
  onClosed,
  children,
}: {
  win: Window;
  title: string;
  onClosed: () => void;
  children: ReactNode;
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  /** The window currently rendered into; null once unmounted. */
  const current = useRef<Window | null>(null);

  useEffect(() => {
    current.current = win;
    const doc = win.document;
    // A window reused by name keeps its old DOM; start from a clean head/body.
    doc.head.replaceChildren();
    doc.title = title;
    const meta = doc.createElement("meta");
    meta.name = "viewport";
    meta.content = "width=device-width, initial-scale=1";
    doc.head.appendChild(meta);
    for (const node of document.head.querySelectorAll("style, link[rel=stylesheet]")) {
      cloneStyle(node, doc);
    }
    doc.documentElement.className = document.documentElement.className;
    doc.documentElement.style.cssText = document.documentElement.style.cssText;
    doc.body.className = document.body.className;
    doc.body.style.margin = "0";
    const root = doc.createElement("div");
    root.className = "flex h-svh flex-col bg-background p-2 text-foreground";
    doc.body.replaceChildren(root);

    // Keep styles (dev HMR, lazily loaded CSS) and the theme class in step.
    const headObserver = new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach((n) => cloneStyle(n, doc));
    });
    headObserver.observe(document.head, { childList: true });
    const themeObserver = new MutationObserver(() => {
      doc.documentElement.className = document.documentElement.className;
      doc.documentElement.style.cssText = document.documentElement.style.cssText;
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });

    const onWindowClosed = () => onClosedRef.current();
    win.addEventListener("pagehide", onWindowClosed);
    // The popup has nothing to show without this page; close it with us.
    const onParentHide = () => win.close();
    window.addEventListener("pagehide", onParentHide);

    setContainer(root);
    return () => {
      current.current = null;
      headObserver.disconnect();
      themeObserver.disconnect();
      // Unhook first: closing it ourselves is not the user closing it.
      win.removeEventListener("pagehide", onWindowClosed);
      window.removeEventListener("pagehide", onParentHide);
      setContainer(null);
      // Close unless we were remounted onto this same window: StrictMode
      // remounts right away, and a closed popup can't reopen without a click.
      setTimeout(() => {
        if (current.current !== win) win.close();
      }, 0);
    };
  }, [win, title]);

  return container ? createPortal(children, container) : null;
}
