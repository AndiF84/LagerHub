// Schlanker Fetch-Wrapper – relative /api-URLs (Dev über den Vite-Proxy, in
// Produktion gleicher Origin auf dem Firmenserver). Spiegelt bewusst den Wrapper
// des Manager-Frontends, damit beide Apps konsistent bleiben. Wird in den
// folgenden Meilensteinen (Pool, Angebote, Push) ausgebaut.
import { getToken, clearSession } from "./session";
import type { MaUser, PoolTask, Settings } from "./types";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Content-Type nur bei vorhandenem Body setzen (Fastify lehnt leeren JSON-Body sonst ab).
  const headers = new Headers(init.headers);
  if (init.body != null) headers.set("Content-Type", "application/json");

  // JWT der Session mitschicken, falls angemeldet. Der Geräte-Login selbst läuft ohne.
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`/api${path}`, { ...init, headers });

  // Token abgelaufen/ungültig (nur wenn wir eins geschickt haben): Session
  // verwerfen und neu laden → App zeigt den LoginScreen. Beim Login (kein Token)
  // fällt 401 = falscher PIN normal als Fehler durch.
  if (res.status === 401 && token) {
    clearSession();
    location.reload();
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = typeof body?.error === "string" ? body.error : JSON.stringify(body);
    } catch {
      detail = res.statusText;
    }
    throw new Error(`${res.status} ${path}: ${detail}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  // PIN-Login der PWA mit Gerätebindung (anders als das Dashboard-/pin-login):
  // bindet/vertraut das Gerät und liefert den MA. 401 = ungültiger PIN, 403 =
  // Gerät einem anderen MA zugeordnet.
  deviceLogin: (pin: string, deviceId: string) =>
    request<MaUser>("/employees/login", {
      method: "POST",
      body: JSON.stringify({ pin, deviceId }),
    }),

  // Pool des MA: nach seinen Fähigkeiten gefilterte, freigegebene Schritte. Die
  // PWA schickt IMMER die eigene employeeId mit – ein WORKER wird serverseitig
  // ohnehin auf sein Token gezwungen, aber MANAGER/OFFICE, die in der PWA
  // mitarbeiten, würden sonst ungefiltert ALLE Schritte sehen (der Server filtert
  // für Nicht-WORKER nur nach dem übergebenen Wert).
  getPool: (employeeId: string) =>
    request<PoolTask[]>(`/pool?employeeId=${encodeURIComponent(employeeId)}`),

  // Betriebs-Einstellungen (nur lesend). Gebraucht wird daraus `escalationMins`
  // als Schwelle für die Alters-Ampel eines wartenden Schritts – derselbe Wert,
  // auf den auch die Eskalation im Backend feuert. Lesen ist dafür auf `authAny`
  // gestellt (backend/src/routes/settings.ts), Schreiben bleibt Manager-only.
  getSettings: () => request<Settings>("/settings"),

  // Selbst-Login des MA auf einen Schritt (atomar via FOR UPDATE im Backend).
  // Identität kommt aus dem Token – nur stepId senden.
  assignSelf: (stepId: string) =>
    request("/assignments", {
      method: "POST",
      body: JSON.stringify({ stepId }),
    }),

  // Eigene Zuweisung abschließen / unterbrechen (UI: „Unterbrechung") / fortsetzen.
  // `note` ist die Pflichtnotiz bei Schritten mit noteRequired – das Backend
  // weist den Abschluss ohne sie mit 400 ab und hängt sie sonst als Notiz an.
  complete: (assignmentId: string, note?: string) =>
    request(`/assignments/${assignmentId}/complete`, {
      method: "POST",
      ...(note !== undefined && { body: JSON.stringify({ note }) }),
    }),
  // Body {} nötig: der Handler parst den Body (reason, mit Default) – ohne Body
  // wirft Zod (undefined). Wie im Manager-Frontend leeres Objekt senden.
  pause: (assignmentId: string) =>
    request(`/assignments/${assignmentId}/pause`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  resume: (assignmentId: string) =>
    request(`/assignments/${assignmentId}/resume`, { method: "POST" }),
  // Noch nicht gestarteten (Team-)Schritt wieder verlassen – Platz freigeben,
  // ohne Arbeitszeit zu buchen (vor Beginn Team-Umbesetzung).
  leave: (assignmentId: string) =>
    request(`/assignments/${assignmentId}/leave`, { method: "POST" }),

  // Manager-Angebot annehmen (→ ACTIVE) oder ablehnen (→ REJECTED) – M3.
  acceptOffer: (assignmentId: string) =>
    request(`/assignments/${assignmentId}/accept`, { method: "POST" }),
  rejectOffer: (assignmentId: string) =>
    request(`/assignments/${assignmentId}/reject`, { method: "POST" }),

  // MA-Notiz an den Schritt-Verlauf anhängen. Der Autor (MA) leitet das Backend
  // aus dem Token ab (WORKER → MA-Eintrag) – kein employeeId nötig.
  addNote: (stepId: string, text: string) =>
    request(`/steps/${stepId}/notes`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  // Web Push (M4): VAPID-Public-Key holen (public), Geräte-Abo speichern/abmelden.
  // employeeId leitet das Backend aus dem Token ab.
  getVapidPublicKey: () => request<{ publicKey: string | null }>("/push/vapid-public-key"),
  subscribePush: (subscription: PushSubscriptionJSON) =>
    request<{ id: string }>("/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription }),
    }),
  unsubscribePush: (endpoint: string) =>
    request("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) }),
};

export { request };
