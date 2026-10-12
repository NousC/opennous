// Watches an OAuth popup for closure WITHOUT polling popup.closed (which
// triggers Cross-Origin-Opener-Policy warnings in the browser console when
// the popup navigates to a third-party origin that sets COOP: same-origin).
//
// Strategy: listen for parent-window focus. The popup either:
//   (a) succeeds → posts a message + closes itself → focus returns to parent
//   (b) is closed manually by the user → focus returns to parent
// Either way we wait a short delay so any postMessage from (a) lands first,
// then invoke onClose. A timeout fires onClose unconditionally as a backstop.
//
// Returns a cleanup() function — call it from the postMessage handler so the
// focus listener doesn't fire a second onClose after a successful auth.

interface WatchOptions {
  onClose: () => void;
  timeoutMs?: number; // default: 5 minutes
  settleMs?: number;  // delay after focus before firing onClose (default 500ms)
}

export function watchOAuthPopup({ onClose, timeoutMs = 5 * 60 * 1000, settleMs = 500 }: WatchOptions) {
  let done = false;

  const fire = () => {
    if (done) return;
    done = true;
    cleanup();
    onClose();
  };

  const onFocus = () => {
    // Wait a tick so postMessage from the popup can land first.
    setTimeout(fire, settleMs);
  };

  const timeoutId = setTimeout(fire, timeoutMs);
  window.addEventListener('focus', onFocus);

  function cleanup() {
    window.removeEventListener('focus', onFocus);
    clearTimeout(timeoutId);
    done = true;
  }

  return cleanup;
}
