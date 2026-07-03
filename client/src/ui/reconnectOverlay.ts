// Small standalone "reconnecting…" indicator (T11 client reconnect).
//
// DOM-based (not a Phaser GameObject) so it renders above whatever scene is
// currently active without any scene needing to own or recreate it — the
// element is a lazily-created singleton `<div>` appended to `document.body`.
// `net.ts` is the only caller (show on socket close / backoff, hide on a
// successful reconnect), but any scene could call these too since the
// module has no scene-scoped state.

const OVERLAY_ID = "frogtato-reconnect-overlay";

function ensureOverlay(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined;
  let el = document.getElementById(OVERLAY_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.textContent = "Reconnecting…";
    Object.assign(el.style, {
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "6px 16px",
      background: "rgba(20, 32, 28, 0.9)",
      color: "#e8f5e9",
      fontFamily: "sans-serif",
      fontSize: "14px",
      fontWeight: "bold",
      borderRadius: "6px",
      border: "1px solid #4caf50",
      zIndex: "10000",
      pointerEvents: "none",
      display: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
  }
  return el;
}

export function showReconnectOverlay(): void {
  const el = ensureOverlay();
  if (el) el.style.display = "block";
}

export function hideReconnectOverlay(): void {
  const el = ensureOverlay();
  if (el) el.style.display = "none";
}
