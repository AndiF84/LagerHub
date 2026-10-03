// ---------------------------------------------------------------------------
// Crewmeister-Zeiterfassung (v3-API) – liefert die ECHTE Arbeitszeit pro MA/Tag.
//
// Quelle der Wahrheit für die "inaktive Zeit" der MA-Detail-Auswertung:
//   inaktiv(Tag) = Crewmeister-WORKING_TIME(Tag) − Σ LagerHub-Schritt-Aktivzeit(Tag)
//
// Auth: POST /api/v3/auth/user/ {username,password} -> { token } (JWT, Bearer).
// Daten: GET /api/v3/timetracking/durations  (Pflicht-Filter crewId, geschlossene
//        date-Range; wir nehmen nur type==WORKING_TIME).
// Mapping: GET /api/v3/platform-app/members  (userId/name/email je Mitglied).
//
// "Best effort" wie der Push-Service: fehlt die Konfiguration, wird der Client als
// nicht konfiguriert gemeldet (kein Crash). Netzwerk-/API-Fehler werfen eine
// CrewmeisterError, die der aufrufende Endpoint in eine sanfte Antwort übersetzt.
// ---------------------------------------------------------------------------

const BASE_URL = (process.env.CREWMEISTER_BASE_URL ?? "https://api.crewmeister.com").replace(/\/+$/, "");
const USER = process.env.CREWMEISTER_USER;
const PASSWORD = process.env.CREWMEISTER_PASSWORD;
const CREW_ID = process.env.CREWMEISTER_CREW_ID;

export class CrewmeisterError extends Error {}

/** True, wenn alle Pflicht-Zugangsdaten vorhanden sind. */
export function crewmeisterConfigured(): boolean {
  return Boolean(USER && PASSWORD && CREW_ID);
}

// --- Token-Cache (in-memory). JWT wird bei 401 einmalig erneuert. ----------
let cachedToken: string | null = null;

async function authenticate(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v3/auth/user/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new CrewmeisterError(`Crewmeister-Login fehlgeschlagen (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new CrewmeisterError("Crewmeister-Login lieferte kein Token");
  cachedToken = data.token;
  return data.token;
}

async function getToken(): Promise<string> {
  return cachedToken ?? authenticate();
}

/**
 * Authentifizierter GET. Bei 401 wird das Token einmalig erneuert und der Aufruf
 * wiederholt (JWT abgelaufen). Liefert die geparste JSON-Antwort.
 */
async function apiGet<T>(path: string, search: Record<string, string>): Promise<T> {
  if (!crewmeisterConfigured()) {
    throw new CrewmeisterError("Crewmeister ist nicht konfiguriert (.env CREWMEISTER_*)");
  }
  const url = `${BASE_URL}${path}?${new URLSearchParams(search).toString()}`;

  let token = await getToken();
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    token = await authenticate(); // Token erneuern und einmal erneut versuchen
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) {
    throw new CrewmeisterError(`Crewmeister-Abruf fehlgeschlagen: ${path} (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}

// --- gemeinsames Page-Format der v3-API ------------------------------------
interface Page<T> {
  content: T[];
  hasNextPage: boolean;
}

/** Lädt alle Seiten eines paginierten Endpoints zusammen. */
async function fetchAllPages<T>(path: string, baseSearch: Record<string, string>): Promise<T[]> {
  const PAGE_SIZE = 500;
  const out: T[] = [];
  for (let page = 0; ; page++) {
    const data = await apiGet<Page<T>>(path, {
      ...baseSearch,
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    out.push(...data.content);
    if (!data.hasNextPage) break;
  }
  return out;
}

/**
 * ISO-8601-Dauer (z. B. "PT8H", "PT2H43M55S", "PT30M") -> Minuten (gerundet).
 * Negative Werte (Diff-Typen) werden vorzeichenrichtig geparst.
 */
export function isoDurationToMinutes(iso: string): number {
  // Crewmeister setzt das Vorzeichen ans Bauteil ("PT-3H"); ISO-8601 erlaubt es
  // auch global ("-PT3H"). Beide Schreibweisen werden unterstützt.
  const m = /^(-?)PT(?:(-?\d+)H)?(?:(-?\d+)M)?(?:(-?\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3] ?? 0);
  const seconds = Number(m[4] ?? 0);
  return sign * (hours * 60 + minutes + seconds / 60);
}

// --- Mitglieder (für die manuelle MA-Zuordnung im Dashboard) ----------------
interface CmMemberRaw {
  userId: number;
  name: string;
  email: string;
  disabled: boolean;
}

export interface CrewmeisterMember {
  userId: number;
  name: string;
  email: string;
  disabled: boolean;
}

export async function getMembers(): Promise<CrewmeisterMember[]> {
  const raw = await fetchAllPages<CmMemberRaw>("/api/v3/platform-app/members", {
    filter: `crewId==${CREW_ID}`,
  });
  return raw
    .map((m) => ({ userId: m.userId, name: (m.name ?? "").trim(), email: m.email ?? "", disabled: m.disabled }))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

// --- Live-Anwesenheit (gerade eingestempelt) -------------------------------
interface CmStampRaw {
  userId: number;
  stampStatus: string;
}

/**
 * Menge der userIds, die GERADE eingestempelt sind. Ein offener Stempel
 * (stampStatus==OPEN) bedeutet, dass die Arbeitstag-Kette läuft (noch kein
 * CLOCK_OUT); Pausen (START_BREAK) zählen weiter als anwesend. Nach dem
 * Ausstempeln wird die Kette CLOSED → der MA taucht hier nicht mehr auf.
 */
export async function getPresentUserIds(): Promise<Set<number>> {
  const stamps = await fetchAllPages<CmStampRaw>("/api/v3/timetracking/stamps", {
    filter: `crewId==${CREW_ID};stampStatus==OPEN`,
  });
  return new Set(stamps.map((s) => s.userId));
}

// --- Arbeitszeit pro (userId, Tag) -----------------------------------------
interface CmDurationRaw {
  userId: number;
  date: string; // "YYYY-MM-DD"
  type: string;
  duration: string; // ISO-8601
}

/** userId -> (dayKey "YYYY-MM-DD" -> Netto-Arbeitsminuten WORKING_TIME) */
export type WorkingMinutesMap = Map<number, Map<string, number>>;

// Ein realer Tag kann nicht mehr als 24 h Arbeitszeit haben; alles darüber ist
// ein Korrektur-Artefakt (in den Echtdaten sahen wir einen PT33H...-Eintrag).
const MAX_MINUTES_PER_DAY = 24 * 60;

/**
 * Liefert die echte Netto-Arbeitszeit (type==WORKING_TIME) je MA und Tag im
 * Zeitraum [from, to] (beide inklusive, "YYYY-MM-DD"). Optional auf eine einzelne
 * Crewmeister-userId eingeschränkt.
 */
export async function getWorkingMinutes(
  from: string,
  to: string,
  userId?: number,
): Promise<WorkingMinutesMap> {
  const filterParts = [`crewId==${CREW_ID}`, `date=ge=${from}`, `date=le=${to}`];
  if (userId !== undefined) filterParts.push(`userId==${userId}`);

  const rows = await fetchAllPages<CmDurationRaw>("/api/v3/timetracking/durations", {
    filter: filterParts.join(";"),
  });

  const result: WorkingMinutesMap = new Map();
  for (const row of rows) {
    if (row.type !== "WORKING_TIME") continue;
    let minutes = isoDurationToMinutes(row.duration);
    if (minutes < 0) continue;
    if (minutes > MAX_MINUTES_PER_DAY) {
      console.warn(
        `[crewmeister] Ausreißer ignoriert/gekappt: userId=${row.userId} ${row.date} ${row.duration}`,
      );
      minutes = MAX_MINUTES_PER_DAY;
    }
    let byDay = result.get(row.userId);
    if (!byDay) {
      byDay = new Map();
      result.set(row.userId, byDay);
    }
    // Mehrere WORKING_TIME-Einträge je Tag aufsummieren.
    byDay.set(row.date, (byDay.get(row.date) ?? 0) + minutes);
  }
  return result;
}
