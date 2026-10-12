import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./index.css";
import { initPostHog } from "./lib/posthog";

// Auth is mounted inside App (contexts/auth/select.tsx): ClerkProvider on Cloud,
// Supabase Auth on self-host, fixtures in preview (lib/preview.ts). A Clerk build
// with no VITE_CLERK_PUBLISHABLE_KEY still fails loud — ClerkAuthProvider throws.

// Ensure root element exists before rendering
const rootElement = document.getElementById("root");
if (!rootElement) {
  console.error("Root element not found!");
  document.body.innerHTML = '<div style="padding: 20px; font-family: sans-serif;"><h1>Error: Root element not found</h1><p>Please check that index.html contains a div with id="root"</p></div>';
  throw new Error("Root element not found");
}

// Initialize PostHog before rendering the app (non-blocking)
try {
initPostHog();
} catch (error) {
  console.error("Failed to initialize PostHog:", error);
  // Don't block app rendering if PostHog fails
}

// Stale-chunk self-heal. After a deploy the server serves a fresh index.html whose
// lazy chunks have new hashed names (Galaxy-*.js etc). A tab left open across the
// deploy still holds the old chunk map, so opening a lazy route fetches a chunk that
// no longer exists and Vite fires `vite:preloadError` (the import promise rejects with
// "Failed to fetch dynamically imported module"). We force a one-shot reload to pull
// the new index.html. The sessionStorage timestamp guards against a reload loop when
// the failure is NOT a stale chunk (e.g. the network is genuinely down).
function reloadOnceForStaleChunk() {
  try {
    const KEY = "chunk-reload-ts";
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 10_000) return; // already reloaded recently — don't loop
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable — reload anyway (loop risk is negligible)
  }
  window.location.reload();
}

window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault(); // suppress the default throw; we own the recovery
  reloadOnceForStaleChunk();
});

window.addEventListener("unhandledrejection", (event) => {
  const msg = String((event.reason && event.reason.message) || event.reason || "");
  if (/dynamically imported module|Importing a module script failed/i.test(msg)) {
    reloadOnceForStaleChunk();
  }
});

// Render the app with error boundary
try {
  const root = createRoot(rootElement);
  root.render(<App />);
} catch (error) {
  console.error("Failed to render React app:", error);
  rootElement.innerHTML = `
    <div style="padding: 40px; font-family: sans-serif; text-align: center;">
      <h1 style="color: #dc2626; margin-bottom: 16px;">Application Error</h1>
      <p style="color: #6b7280; margin-bottom: 24px;">Failed to initialize the application.</p>
      <button onclick="window.location.reload()" style="padding: 12px 24px; background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 16px;">
        Reload Page
      </button>
      ${import.meta.env.DEV ? `<pre style="margin-top: 24px; padding: 16px; background: #f3f4f6; border-radius: 6px; text-align: left; overflow: auto;">${error instanceof Error ? error.stack : String(error)}</pre>` : ''}
    </div>
  `;
  throw error;
}