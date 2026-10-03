// Geräte-Identität + MA-Session der PWA. Beides in localStorage, KEIN Token
// (echte Absicherung kommt mit der Auth-Härtung). Die deviceId bleibt dauerhaft
// am Gerät – das Backend bindet den MA beim Login daran (deviceTrusted); ein
// Abmelden löscht nur die Session, nicht die deviceId.
import type { MaUser } from "./types";

const DEVICE_KEY = "lagerhub.deviceId";
const SESSION_KEY = "lagerhub.pwa.session";

// UUID v4. crypto.randomUUID gibt es NUR im sicheren Kontext (localhost/HTTPS);
// beim Test über http://<LAN-IP> auf dem Handy fehlt es → Fallback über
// crypto.getRandomValues (auch ohne Secure Context verfügbar).
function generateUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variante 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

// Dauerhafte Geräte-ID; beim ersten Start erzeugt.
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = generateUuid();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function loadSession(): MaUser | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MaUser;
    // token verlangen: alte Sessions von vor der Auth-Einführung (ohne token)
    // gelten als abgemeldet → sauberer Re-Login statt 401-Sackgasse.
    return parsed?.id && parsed?.token ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(user: MaUser): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

// JWT der aktuellen Session (für den Authorization-Header in api/client.ts).
export function getToken(): string | null {
  return loadSession()?.token ?? null;
}
