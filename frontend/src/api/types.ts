// Typen spiegeln die Antworten der bestehenden /api/*-Endpunkte wider.

export type Priority = "HIGH" | "MEDIUM" | "LOW";
// Rolle steuert die Oberfläche: ADMIN = volles Dashboard (nur über geheime PIN,
// kein MA-Datensatz), MANAGER = Dashboard ohne Statistik, OFFICE = abgespecktes
// Büro-Dashboard, WORKER = Lager/PWA. Nicht: ob der MA einsetzbar ist.
export type Role = "ADMIN" | "MANAGER" | "OFFICE" | "WORKER";
export type TaskStatus = "OPEN" | "RUNNING" | "COMPLETED";
export type StepStatus = "LOCKED" | "OPEN" | "WAITING" | "ACTIVE" | "PAUSED" | "DONE";
export type AssignmentState = "OFFERED" | "ACTIVE" | "PAUSED" | "DONE" | "REJECTED";

export interface Skill {
  id: string;
  name: string;
}

export interface Assignment {
  id: string;
  state: AssignmentState;
  pausedReason: string | null;
  employee: { id: string; name: string };
}

export interface StepPredecessorRel {
  predecessor: { id: string; name: string };
}

// Ein Eintrag im Notiz-Verlauf eines Schritts (append-only). MA/Manager tragen
// Probleme, Mengen etc. ein.
export interface NoteEntry {
  id: string;
  authorType: "MA" | "MANAGER" | "OFFICE" | "ADMIN";
  authorName: string;
  text: string;
  at: string;
  // Pflichtnotiz beim Abschluss statt freier Notiz (Step.noteRequired).
  // Optional: Einträge aus der Zeit davor haben die Felder nicht.
  kind?: "COMPLETION";
  value?: number; // nur bei noteFormat NUMBER
  label?: string; // Beschriftung zum Zeitpunkt der Eingabe
}

// Erwartete Form der Pflichtnotiz beim Abschluss.
export type NoteFormat = "TEXT" | "NUMBER";

export interface Step {
  id: string;
  name: string;
  description: string;
  orderIndex: number;
  minWorkers: number | null;
  maxWorkers: number | null;
  startedAt: string | null;
  // Seit wann ist der Schritt abholbar (Status OPEN)? Basis für „wartet seit X".
  // null = gesperrt oder Aufgabe nicht im Pool.
  availableAt: string | null;
  notes: NoteEntry[];
  // Pflichtnotiz beim Abschluss: ohne sie weist das Backend den Abschluss ab.
  noteRequired: boolean;
  noteFormat: NoteFormat;
  noteLabel: string;
  skill: Skill;
  assignments: Assignment[];
  predecessors: StepPredecessorRel[];
  computedStatus?: StepStatus; // nur im Pool-Endpunkt enthalten
}

export interface Task {
  id: string;
  name: string;
  priority: Priority;
  status: TaskStatus;
  poolEnabled: boolean;
  repeat: boolean;
  orderIndex: number; // Platz im Aufgaben-Tab (Drag & Drop)
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: Step[];
  // Nur im Pool-Endpunkt: Fortschritt über alle Schritte der Aufgabe.
  stepsTotal?: number;
  stepsDone?: number;
}

// Angemeldeter Dashboard-Nutzer (aus /employees/pin-login). Enthält das
// JWT-`token`, das der Client bei jeder Anfrage im Authorization-Header mitschickt
// (siehe api/client.ts); die Rolle steuert zusätzlich die Tab-Sichtbarkeit.
export interface SessionUser {
  id: string;
  name: string;
  role: Role;
  token: string;
}

// --- Erinnerungen ---------------------------------------------------------
// Wiederkehrende Dinge, an die jemand denken muss. Tagesgenau (kein Zeitpunkt):
// faellig ist alles mit dueDate <= heute, das steht dann im Dashboard-Banner.
export type RepeatRule = "NONE" | "DAILY" | "WEEKLY" | "MONTHLY" | "INTERVAL";
export type ReminderDecision = "DONE" | "POSTPONED" | "POOLED" | "OBSOLETE";

export interface Reminder {
  id: string;
  title: string;
  description: string;
  dueDate: string;
  repeatRule: RepeatRule;
  intervalDays: number | null;
  weekday: number | null;
  dayOfMonth: number | null;
  skillId: string | null;
  skill: Skill | null;
  taskId: string | null;
  task: { id: string; name: string; poolEnabled: boolean; deletedAt: string | null } | null;
  active: boolean;
  createdAt: string;
}

// Eine getroffene Entscheidung - der Journal-Eintrag dazu.
export interface ReminderEvent {
  id: string;
  reminderId: string | null;
  reminderTitle: string;
  decision: ReminderDecision;
  decidedByName: string;
  decidedById: string | null;
  decidedAt: string;
  postponedTo: string | null;
}

export interface Employee {
  id: string;
  name: string;
  pin: string;
  role: Role;
  deviceId: string | null;
  deviceTrusted: boolean;
  present: boolean;
  // Steuerquelle für present: null = Auto (Crewmeister-Stempelstatus), true/false =
  // manuell gepinnt (gewinnt gegen den Sync; z. B. Handy vergessen).
  presenceOverride: boolean | null;
  // Zuordnung zur Crewmeister-Zeiterfassung (numerische userId dort); null = keine.
  crewmeisterUserId: number | null;
  skills: { skill: Skill }[];
  status?: "active" | "free";
  currentStep?: { stepId: string; stepName: string; taskName: string } | null;
}

// Ein Crewmeister-Mitglied (aus /employees/crewmeister-members) für die manuelle
// Zuordnung im Mitarbeiter-Tab.
export interface CrewmeisterMember {
  userId: number;
  name: string;
  email: string;
  disabled: boolean;
}

export interface Settings {
  workStart: string; // "HH:mm"
  workEnd: string; // "HH:mm"
  escalationMins: number;
  // Pause, in der die Eskalation schweigt. Gleiche Zeiten = keine Pause.
  breakStart: string; // "HH:mm"
  breakEnd: string; // "HH:mm"
  // Aufbewahrungsdauer der Tagesjournale in Tagen; 0 = deaktiviert.
  journalRetentionDays: number;
}

export interface StatsSummary {
  // Heute erledigte Arbeitsschritte (Summe der Schritte abgeschlossener Läufe)
  stepsCompletedToday: number;
  activeEmployees: number;
  poolTasksOpen: number;
  avgDurationMinutes: number | null;
}

export interface TasksByStatus {
  open: number;
  running: number;
  completed: number;
}

export interface EmployeeLoad {
  employeeId: string;
  name: string;
  // Aktuell bearbeitete Aufgabe/Schritt (null = arbeitet gerade an nichts)
  currentTask: string | null;
  currentStep: string | null;
  // Pausenbereinigter Start der laufenden Zuweisung (ISO); für die mitlaufende
  // Uhr: aktuelle Zeit = jetzt − currentSince. null, wenn nichts aktiv.
  currentSince: string | null;
  // Heutige Netto-Zeit OHNE die laufende Zuweisung (in ms); das Frontend tickt
  // die laufende Zuweisung live obendrauf.
  activeBaseMs: number;
}

// Schritt eines abgeschlossenen Durchlaufs mit eingefrorenem Notiz-Verlauf.
// Ein beteiligter MA an einem Schritt mit seinen Zeiten (Netto = Brutto − Pausen).
// activeMinutes ist null, falls der Schritt-Lauf keine Start-/Endzeit hatte.
export interface JournalWorker {
  employeeId: string;
  name: string;
  activeMinutes: number | null;
  pausedMinutes: number;
}

export interface JournalStep {
  id: string;
  name: string;
  // Zeit, die am Schritt gearbeitet wurde (Team-Zeit einmal, ohne
  // Unterbrechungen); null = keine auswertbaren Zeiten im Snapshot.
  durationMinutes: number | null;
  notes: NoteEntry[];
  workers: JournalWorker[];
}

// Tagesjournal: ein abgeschlossener Aufgaben-Durchlauf (aus TaskRun).
export interface JournalEntry {
  id: string;
  taskName: string;
  startedAt: string;
  finishedAt: string;
  // Summe der Schritt-Dauern (nicht Ende − Start: Liegezeiten zählen nicht).
  durationMinutes: number;
  participants: string[];
  steps: JournalStep[];
}

// Ein Journal-Tag in der Historie (Datum + Anzahl Durchläufe).
export interface JournalDay {
  date: string; // YYYY-MM-DD
  count: number;
}

// Historie-Auswertung: aktive Zeit/Anzahl je MA über einen Zeitraum (aus WorkLog).
export interface EmployeeHistoryRow {
  employeeId: string;
  name: string;
  activeMinutes: number; // Netto-aktive Zeit im Zeitraum
  stepCount: number; // übernommene Schritte
  taskCount: number; // beteiligte Durchläufe
  avgStepMinutes: number; // Ø Netto-Zeit je Schritt
}

// Durchsatz je Tag (Tage ohne Läufe als 0).
export interface ThroughputDay {
  day: string; // YYYY-MM-DD
  runCount: number;
  avgMinutes: number;
}

// Ø Durchlaufdauer je Aufgabentyp im Zeitraum.
export interface AvgByTask {
  taskName: string;
  runCount: number;
  avgMinutes: number;
}

export interface ThroughputResult {
  perDay: ThroughputDay[];
  avgByTask: AvgByTask[];
}

// Ø Netto-Zeit je Arbeitsschritt (aus WorkLog), gruppiert nach (Aufgabe, Schritt).
export interface StepDuration {
  taskName: string;
  stepName: string;
  count: number; // Anzahl der Vorkommen im Zeitraum
  avgMinutes: number; // Ø Netto-Aktivzeit je Vorkommen
  minMinutes: number;
  maxMinutes: number;
}

export interface StepDurationsResult {
  steps: StepDuration[];
}

// --- MA-Detail-Auswertung (ein MA + Zeitraum), aus /stats/employee-detail ---
// "Wechsel" = switchCount (wie OFT der MA gewechselt/unterbrochen hat, nicht die
// Dauer; Feierabend zählt nicht; alte Läufe = 0).
// "inaktiv" = nicht an LagerHub-Schritten eingeloggt; null, wenn keine echte
// Arbeitszeit aus Crewmeister vorliegt (siehe crewmeister.available).
export interface EmployeeDetailTotals {
  activeMinutes: number;
  switchCount: number;
  inactiveMinutes: number | null;
  stepCount: number;
  runCount: number;
  stepTypeCount: number;
}

export interface EmployeeDetailByStep {
  stepName: string;
  count: number;
  totalActiveMinutes: number;
  avgActiveMinutes: number;
  avgSwitchCount: number;
  minActiveMinutes: number;
  maxActiveMinutes: number;
}

export interface EmployeeDetailOccurrence {
  runId: string;
  stepName: string;
  taskName: string;
  date: string; // YYYY-MM-DD
  activeMinutes: number;
  switchCount: number;
  notes: NoteEntry[];
}

export interface EmployeeDetailByTask {
  taskName: string;
  count: number;
  activeMinutes: number;
  sharePercent: number;
}

export interface EmployeeDetailPerDay {
  date: string; // YYYY-MM-DD
  stepCount: number;
  activeMinutes: number;
  inactiveMinutes: number | null;
}

export interface EmployeeDetail {
  employeeId: string;
  name: string;
  crewmeisterUserId: number | null;
  from: string;
  to: string;
  // available=false → inaktive Zeit konnte nicht berechnet werden (reason erklärt warum).
  crewmeister: { available: boolean; reason?: string };
  totals: EmployeeDetailTotals;
  byStep: EmployeeDetailByStep[];
  occurrences: EmployeeDetailOccurrence[];
  byTask: EmployeeDetailByTask[];
  perDay: EmployeeDetailPerDay[];
}
