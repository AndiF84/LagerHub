// Web-Push-Abo der PWA (M4). Fragt die Benachrichtigungs-Berechtigung an,
// abonniert über den Service Worker (`sw.ts`) beim Browser-Push-Dienst und meldet
// das Abo beim Backend an (`POST /push/subscribe`; employeeId aus dem Token).
// Push braucht einen Secure Context (HTTPS oder localhost) – über LAN-`http://` ist
// es nicht verfügbar (→ Zustand "blocked-insecure").
import { api } from "./client";

export type PushState =
  | "unsupported" // Browser kann kein Push
  | "blocked-insecure" // kein Secure Context (z. B. http://<LAN-IP>)
  | "denied" // Nutzer hat Benachrichtigungen abgelehnt (nur in Browser-Settings änderbar)
  | "prompt" // möglich, aber (noch) nicht aktiviert
  | "enabled"; // aktiv abonniert

export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    window.isSecureContext
  );
}

// VAPID-Key (base64url) → Uint8Array für applicationServerKey. Über einen
// expliziten ArrayBuffer, damit der Typ zur BufferSource-Erwartung von
// pushManager.subscribe passt (nicht der ArrayBufferLike-Default).
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// Aktuellen Zustand ermitteln (für die UI beim Laden).
export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) {
    return typeof window !== "undefined" && !window.isSecureContext ? "blocked-insecure" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "enabled" : "prompt";
}

// Berechtigung anfragen (MUSS aus einer Nutzer-Geste kommen), abonnieren, ans
// Backend melden. Liefert den neuen Zustand.
export async function enablePush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "prompt";

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api.getVapidPublicKey();
    if (!publicKey) throw new Error("Server ist ohne VAPID-Key konfiguriert.");
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  await api.subscribePush(sub.toJSON());
  return "enabled";
}

// Abo lokal und serverseitig entfernen (best effort). Beim Abmelden aufrufen,
// damit auf einem Gerät nicht der vorige MA weiter Pushes bekommt.
export async function disablePush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api.unsubscribePush(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  return "prompt";
}
