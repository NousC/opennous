// Gmail + Google Calendar with the install's own Google OAuth app (self-host, GET-765).
//
// The API says per workspace whether Google connects natively or through Composio. A Cloud
// build never asks: it is always Composio.
//
// The flow: ask the API for Google's consent URL, open it in a popup, wait for the API's hand-off
// page to post a one-time completion code (to this app's origin only), acknowledge it so the
// popup does not burn it, then finish the connection here, with this member's own session. The
// server saves only for the member and workspace that started the flow, so a consent link
// forwarded to someone else connects nothing.
import { HAS_CLOUD } from "@/lib/cloud";
import { watchOAuthPopup } from "@/lib/oauthPopup";

export type GoogleProduct = "gmail_oauth" | "google_calendar";
export const isGoogleProduct = (name: string | undefined | null): name is GoogleProduct =>
  name === "gmail_oauth" || name === "google_calendar";

/** True when this workspace connects Google with the install's own OAuth app. */
export async function fetchGoogleNative(apiUrl: string, token: string, workspaceId: string): Promise<boolean> {
  if (HAS_CLOUD || !token || !workspaceId) return false;
  try {
    const r = await fetch(`${apiUrl}/api/oauth/google/mode?workspace_id=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return false;
    const d = await r.json();
    return d?.mode === "native";
  } catch {
    return false;
  }
}

export type GoogleConnectResult =
  | { ok: true; connectionId: string }
  | { ok: false; message: string }
  | { ok: false; closed: true };

const ERROR_TEXT: Record<string, string> = {
  access_denied: "Google sign-in was cancelled.",
  scope_not_granted: "Google did not grant the read access OpenNous needs. Connect again and leave the permission ticked.",
  invalid_state: "This sign-in expired. Start the connection again.",
};

/** Run the native Google connect for one product. `getToken` reads the current session token. */
export async function connectNativeGoogle(opts: {
  apiUrl: string;
  workspaceId: string;
  provider: GoogleProduct;
  getToken: () => string;
}): Promise<GoogleConnectResult> {
  const { apiUrl, workspaceId, provider, getToken } = opts;
  const resp = await fetch(`${apiUrl}/api/oauth/google/${provider}/authorize?workspace_id=${workspaceId}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.authUrl) return { ok: false, message: data.message || "Couldn't start the Google connection." };

  const w = 600, h = 700;
  window.open(data.authUrl, `${provider}Google`, `width=${w},height=${h},left=${window.screenX + (window.outerWidth - w) / 2},top=${window.screenY + (window.outerHeight - h) / 2}`);

  return new Promise<GoogleConnectResult>((resolve) => {
    let settled = false;
    let completing = false;
    let cleanup: (() => void) | null = null;
    const done = (r: GoogleConnectResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      cleanup?.();
      resolve(r);
    };
    const apiOrigin = new URL(apiUrl || "/", window.location.href).origin;
    const onMessage = async (e: MessageEvent) => {
      if (e.data?.type !== "oauth-callback") return;
      // The code comes from the API's hand-off page; a refusal (cancelled, expired) comes from the
      // app's own oauth-callback.html and carries no code.
      const fromApi = e.origin === apiOrigin;
      const fromApp = e.origin === window.location.origin && !e.data.completionCode;
      if (!fromApi && !fromApp) return;
      // Tell the hand-off page the code arrived, or it cancels the sign-in after a few seconds.
      if (e.data.completionCode) {
        try { (e.source as Window | null)?.postMessage({ type: "google-oauth-ack", code: e.data.completionCode }, e.origin); } catch { /* popup gone */ }
      }
      window.removeEventListener("message", onMessage);
      cleanup?.();
      completing = true;
      if (!e.data.completionCode) {
        done({ ok: false, message: ERROR_TEXT[e.data.error] || "Google didn't approve the connection." });
        return;
      }
      try {
        const r = await fetch(`${apiUrl}/api/oauth/google/complete?workspace_id=${workspaceId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ code: e.data.completionCode, workspace_id: workspaceId }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok) done({ ok: true, connectionId: d.connection_id });
        else done({ ok: false, message: d.message || "Google didn't complete the connection." });
      } catch {
        done({ ok: false, message: "Google didn't complete the connection." });
      }
    };
    window.addEventListener("message", onMessage);
    // Popup closed with no message: nothing was saved.
    cleanup = watchOAuthPopup({ onClose: () => { setTimeout(() => { if (!completing) done({ ok: false, closed: true }); }, 1500); } });
  });
}
