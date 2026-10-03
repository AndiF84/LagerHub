// DTO-Typen der PWA – Teilmenge der Backend-Antworten, wächst mit den
// Meilensteinen. Bewusst eigenständig (die PWA teilt vorerst keinen Code mit
// dem Manager-Frontend).
export type Role = "ADMIN" | "MANAGER" | "OFFICE" | "WORKER";

export interface Skill {
  id: string;
  name: string;
}

// Angemeldeter Mitarbeiter, wie ihn `POST /api/employees/login` liefert
// (nur die Felder, die die PWA braucht – weitere werden ignoriert).
export interface MaUser {
  id: string;
  name: string;
  role: Role;
  skills: { skill: Skill }[];
  // JWT aus /employees/login; wird bei jeder Anfrage im Authorization-Header
  // mitgeschickt (siehe api/client.ts).
  token: string;
}

// --- Pool (M2) – Teilmenge der Antwort von `GET /api/pool?employeeId=` ---
export type StepStatus = "LOCKED" | "OPEN" | "WAITING" | "ACTIVE" | "PAUSED" | "DONE";
export type AssignmentState = "OFFERED" | "ACTIVE" | "PAUSED" | "DONE" | "REJECTED";

// Ein Eintrag im append-only Notiz-Verlauf eines Schritts (M3).
export interface NoteEntry {
  id: string;
  authorType: "MA" | "MANAGER" | "OFFICE" | "ADMIN";
  authorName: string;
  text: string;
  at: string;
  // Pflichtnotiz beim Abschluss statt freier Notiz (PoolStep.noteRequired).
  // Optional: Einträge aus der Zeit davor haben die Felder nicht.
  kind?: "COMPLETION";
  value?: number; // nur bei noteFormat NUMBER
  label?: string; // Beschriftung zum Zeitpunkt der Eingabe
}

// Erwartete Form der Pflichtnotiz beim Abschluss.
export type NoteFormat = "TEXT" | "NUMBER";

// Zuweisung an einem Schritt (mit MA, damit die PWA „meine" Zuweisung erkennt).
export interface PoolAssignment {
  id: string;
  state: AssignmentState;
  employee: { id: string; name: string };
}

export interface PoolStep {
  id: string;
  name: string;
  minWorkers: number | null;
  maxWorkers: number | null;
  startedAt: string | null;
  // Seit wann ist der Schritt abholbar (Status OPEN)? Basis für „wartet seit X".
  // null = gesperrt oder Aufgabe nicht im Pool.
  availableAt: string | null;
  skill: Skill;
  // Append-only Notiz-Verlauf des aktuellen Laufs (M3).
  notes: NoteEntry[];
  // Pflichtnotiz beim Abschluss: ohne sie weist das Backend den Abschluss ab.
  noteRequired: boolean;
  noteFormat: NoteFormat;
  noteLabel: string;
  // Nur die für die Anzeige relevanten States (ACTIVE/PAUSED/OFFERED).
  assignments: PoolAssignment[];
  // Der Pool-Endpunkt liefert den abgeleiteten Schritt-Status stets mit.
  computedStatus: StepStatus;
}

export interface PoolTask {
  id: string;
  name: string;
  priority: Priority;
  steps: PoolStep[];
  stepsTotal: number;
  stepsDone: number;
}

export type Priority = "HIGH" | "MEDIUM" | "LOW";

// Betriebs-Einstellungen (Singleton). Die PWA liest nur `escalationMins`; die
// übrigen Felder sind der Vollständigkeit halber typisiert.
export interface Settings {
  workStart: string;
  workEnd: string;
  escalationMins: number;
  journalRetentionDays: number;
}
