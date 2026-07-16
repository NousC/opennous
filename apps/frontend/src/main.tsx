import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initPostHog } from "./lib/posthog";

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
