// Dashboard-Session: wer ist gerade am PC angemeldet. In localStorage gehalten,
// inkl. JWT-`token` (siehe getToken) – dieses schickt api/client.ts bei jeder
// Anfrage mit, das Backend prüft es serverseitig. Die Rolle steuert zusätzlich
// die Tab-Sichtbarkeit.
import type { Role, SessionUser } from "./types";

const STORAGE_KEY = "lagerhub.session";

export function loadSession(): SessionUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionUser;
    // token verlangen: alte Sessions von vor der Auth-Einführung (ohne token)
    // gelten als abgemeldet → sauberer Re-Login statt 401-Sackgasse.
    if (!parsed?.id || !parsed?.role || !parsed?.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(user: SessionUser): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// JWT der aktuellen Session (für den Authorization-Header in api/client.ts).
export function getToken(): string | null {
  return loadSession()?.token ?? null;
}

// Welche Tabs darf welche Rolle sehen.
//   ADMIN   – volles Dashboard (alle Tabs); nur über geheime PIN erreichbar
//   MANAGER – Dashboard ohne Statistik und ohne Einstellungen
//   OFFICE  – abgespeckt: Dashboard, Aufgaben, Historie
//   WORKER  – Lager nutzt die PWA, hat im Dashboard nichts (leer)
//
// `settings` ist bewusst ADMIN-exklusiv: dort hängen Betriebsparameter, die auf
// alle wirken (Arbeitszeiten, Eskalations-Schwelle, Pause, Journal-Aufbewahrung).
// Serverseitig deckt sich das mit `authAdmin` auf PATCH /settings – die
// Tab-Filterung hier ist nur Komfort, die echte Sperre sitzt im Backend.
export type TabId =
  | "pool"
  | "tasks"
  | "employees"
  | "reminders"
  | "stats"
  | "history"
  | "settings";

// `reminders` sehen alle Dashboard-Rollen: das Buero soll faellige
// Erinnerungen genauso abhaken koennen wie der Manager (jede Entscheidung
// wird ohnehin namentlich protokolliert). Anlegen/Aendern bleibt serverseitig
// bei MANAGER/ADMIN (authManager), der Tab blendet es fuer OFFICE aus.
export const TAB_ACCESS: Record<Role, TabId[]> = {
  ADMIN: ["pool", "tasks", "employees", "reminders", "stats", "history", "settings"],
  MANAGER: ["pool", "tasks", "employees", "reminders", "history"],
  OFFICE: ["pool", "tasks", "reminders", "history"],
  WORKER: [],
};

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  OFFICE: "Büro",
  WORKER: "Lager",
};
