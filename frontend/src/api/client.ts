// Schlanker Fetch-Wrapper. URLs sind relativ – im Dev über den Vite-Proxy,
// in Produktion über denselben Origin wie das ausgelieferte Frontend.
import { getToken, clearSession } from "./session";
import type {
  CrewmeisterMember,
  Employee,
  EmployeeDetail,
  EmployeeHistoryRow,
  EmployeeLoad,
  JournalDay,
  JournalEntry,
  NoteFormat,
  Priority,
  Reminder,
  ReminderDecision,
  RepeatRule,
  ReminderEvent,
  Role,
  SessionUser,
  Settings,
  Skill,
  StatsSummary,
  Step,
  Task,
  TasksByStatus,
  ThroughputResult,
  StepDurationsResult,
} from "./types";

// Hängt optionale from/to-Parameter ("YYYY-MM-DD") an einen Pfad.
function withRange(path: string, range?: { from?: string; to?: string }): string {
  const q = new URLSearchParams();
  if (range?.from) q.set("from", range.from);
  if (range?.to) q.set("to", range.to);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export interface ReminderInput {
  title: string;
  description?: string;
  dueDate: string; // "YYYY-MM-DD"
  repeatRule?: RepeatRule;
  intervalDays?: number | null;
  weekday?: number | null;
  dayOfMonth?: number | null;
  skillId?: string | null;
}

export interface StepInput {
  taskId: string;
  name: string;
  description?: string;
  minWorkers?: number | null;
  maxWorkers?: number | null;
  predecessorIds?: string[];
  noteRequired?: boolean;
  noteFormat?: NoteFormat;
  noteLabel?: string;
}

export interface StepPatch {
  description?: string;
  minWorkers?: number | null;
  maxWorkers?: number | null;
  predecessorIds?: string[];
  noteRequired?: boolean;
  noteFormat?: NoteFormat;
  noteLabel?: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Content-Type nur bei vorhandenem Body setzen. Fastify lehnt
  // "application/json" mit leerem Body sonst mit 400 ab (z. B. DELETE, POST ohne Body).
  const headers = new Headers(init.headers);
  if (init.body != null) headers.set("Content-Type", "application/json");

  // JWT der Session mitschicken, falls angemeldet. Der PIN-Login selbst läuft ohne.
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`/api${path}`, { ...init, headers });

  // Token abgelaufen/ungültig (nur wenn wir eins geschickt haben): Session
  // verwerfen und neu laden → App zeigt den LoginScreen. Beim PIN-Login (kein
  // Token) fällt 401 = falscher PIN normal als Fehler durch.
  if (res.status === 401 && token) {
    clearSession();
    location.reload();
  }

  if (!res.ok) {
    let detail = "";
    try {
      // Backend liefert Fehler als { error: "..." } – diese lesbare Meldung
      // bevorzugen, sonst auf den rohen Body / Statustext zurückfallen.
      const body = await res.json();
      detail = typeof body?.error === "string" ? body.error : JSON.stringify(body);
    } catch {
      detail = res.statusText;
    }
    throw new Error(`${res.status} ${path}: ${detail}`);
  }
  // 204/leere Antworten abfangen
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  // Tasks
  listTasks: () => request<Task[]>("/tasks"),
  createTask: (body: { name: string; priority?: Priority }) =>
    request<Task>("/tasks", { method: "POST", body: JSON.stringify(body) }),
  updateTask: (
    id: string,
    body: { priority?: Priority; poolEnabled?: boolean; repeat?: boolean; name?: string },
  ) => request<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  copyTask: (id: string, name: string) =>
    request<Task>(`/tasks/${id}/copy`, { method: "POST", body: JSON.stringify({ name }) }),
  restartTask: (id: string) => request<Task>(`/tasks/${id}/restart`, { method: "POST" }),
  deleteTask: (id: string) => request<void>(`/tasks/${id}`, { method: "DELETE" }),

  // Steps
  createStep: (body: StepInput) =>
    request<Step>("/steps", { method: "POST", body: JSON.stringify(body) }),
  updateStep: (id: string, body: StepPatch) =>
    request<Step>(`/steps/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteStep: (id: string) => request<void>(`/steps/${id}`, { method: "DELETE" }),
  reorderTasks: (orderedIds: string[]) =>
    request<void>("/tasks/reorder", {
      method: "POST",
      body: JSON.stringify({ orderedIds }),
    }),
  reorderSteps: (taskId: string, orderedIds: string[]) =>
    request<void>("/steps/reorder", {
      method: "POST",
      body: JSON.stringify({ taskId, orderedIds }),
    }),
  // Notiz an den Verlauf eines Schritts anhängen (Manager ohne employeeId).
  // Autor (Manager) leitet das Backend aus dem Token ab – kein employeeId nötig.
  addStepNote: (stepId: string, text: string) =>
    request<Step>(`/steps/${stepId}/notes`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  // Pool
  listPool: () => request<Task[]>("/pool"),

  // Zuweisungen (Manager-Angebot + Annehmen/Ablehnen)
  offerAssignment: (employeeId: string, stepId: string) =>
    request<unknown>("/assignments/offer", {
      method: "POST",
      body: JSON.stringify({ employeeId, stepId }),
    }),
  acceptAssignment: (id: string) =>
    request<unknown>(`/assignments/${id}/accept`, { method: "POST" }),
  rejectAssignment: (id: string) =>
    request<unknown>(`/assignments/${id}/reject`, { method: "POST" }),
  pauseAssignment: (id: string) =>
    request<unknown>(`/assignments/${id}/pause`, { method: "POST", body: JSON.stringify({}) }),
  resumeAssignment: (id: string) =>
    request<unknown>(`/assignments/${id}/resume`, { method: "POST" }),
  // `note` ist die Pflichtnotiz bei Schritten mit noteRequired – das Backend
  // weist den Abschluss ohne sie mit 400 ab und hängt sie sonst als Notiz an.
  completeAssignment: (id: string, note?: string) =>
    request<unknown>(`/assignments/${id}/complete`, {
      method: "POST",
      ...(note !== undefined && { body: JSON.stringify({ note }) }),
    }),

  // Dashboard-Anmeldung per PIN (ohne Geräte-Bindung). Liefert Rolle + Name.
  pinLogin: (pin: string) =>
    request<SessionUser>("/employees/pin-login", {
      method: "POST",
      body: JSON.stringify({ pin }),
    }),

  // Employees
  listEmployees: () => request<Employee[]>("/employees"),
  createEmployee: (body: { name: string; skillIds?: string[]; present?: boolean; role?: Role }) =>
    request<Employee>("/employees", { method: "POST", body: JSON.stringify(body) }),
  updateEmployee: (
    id: string,
    body: {
      name?: string;
      skillIds?: string[];
      present?: boolean;
      role?: Role;
      crewmeisterUserId?: number | null;
      presenceOverride?: boolean | null;
    },
  ) => request<Employee>(`/employees/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  resetDevice: (id: string) =>
    request<Employee>(`/employees/${id}/reset-device`, { method: "POST" }),
  deleteEmployee: (id: string) => request<void>(`/employees/${id}`, { method: "DELETE" }),
  // Crewmeister-Mitglieder für die Zuordnung (503, wenn nicht konfiguriert/erreichbar).
  crewmeisterMembers: () => request<CrewmeisterMember[]>("/employees/crewmeister-members"),

  // Skills
  listSkills: () => request<Skill[]>("/skills"),
  createSkill: (name: string) =>
    request<Skill>("/skills", { method: "POST", body: JSON.stringify({ name }) }),
  updateSkill: (id: string, name: string) =>
    request<Skill>(`/skills/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteSkill: (id: string) => request<void>(`/skills/${id}`, { method: "DELETE" }),

  // Stats
  statsSummary: () => request<StatsSummary>("/stats"),
  tasksByStatus: () => request<TasksByStatus>("/stats/tasks-by-status"),
  employeeLoad: () => request<EmployeeLoad[]>("/stats/employee-load"),
  journal: () => request<JournalEntry[]>("/stats/journal"),
  journalDays: () => request<JournalDay[]>("/stats/journal/days"),
  journalByDate: (date: string) =>
    request<JournalEntry[]>(`/stats/journal?date=${encodeURIComponent(date)}`),
  // Admin trägt eine Notiz in der Historie nach (an einen Schritt eines Laufs).
  addJournalNote: (runId: string, stepId: string, text: string) =>
    request<JournalEntry>(`/stats/journal/${runId}/notes`, {
      method: "POST",
      body: JSON.stringify({ stepId, text }),
    }),
  deleteJournalDay: (date: string) =>
    request<{ deleted: number }>(`/stats/journal/${encodeURIComponent(date)}`, { method: "DELETE" }),
  // Historie-Auswertungen über einen Zeitraum (Default serverseitig: letzte 7 Tage).
  employeeHistory: (range?: { from?: string; to?: string }) =>
    request<EmployeeHistoryRow[]>(withRange("/stats/employee-history", range)),
  throughput: (range?: { from?: string; to?: string }) =>
    request<ThroughputResult>(withRange("/stats/throughput", range)),
  stepDurations: (range?: { from?: string; to?: string }) =>
    request<StepDurationsResult>(withRange("/stats/step-durations", range)),
  // MA-Detail-Auswertung: ein Mitarbeiter + Zeitraum (Default serverseitig 7 Tage).
  employeeDetail: (params: { employeeId: string; from?: string; to?: string }) => {
    const q = new URLSearchParams({ employeeId: params.employeeId });
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    return request<EmployeeDetail>(`/stats/employee-detail?${q.toString()}`);
  },

  // Erinnerungen
  listReminders: () => request<Reminder[]>("/reminders"),
  // Nur die faelligen (heute oder frueher) - fuers Dashboard-Banner.
  listDueReminders: () => request<Reminder[]>("/reminders/due"),
  createReminder: (body: ReminderInput) =>
    request<Reminder>("/reminders", { method: "POST", body: JSON.stringify(body) }),
  updateReminder: (id: string, body: Partial<ReminderInput> & { active?: boolean }) =>
    request<Reminder>(`/reminders/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteReminder: (id: string) => request<void>(`/reminders/${id}`, { method: "DELETE" }),
  // Entscheidung ueber eine faellige Erinnerung; `days` nur bei POSTPONED (1-7).
  decideReminder: (id: string, decision: ReminderDecision, days?: number) =>
    request<Reminder>(`/reminders/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, ...(days ? { days } : {}) }),
    }),
  // Entscheidungen eines Tages (ohne date = heute) - fuers Tagesjournal.
  journalReminders: (date?: string) =>
    request<ReminderEvent[]>(
      date ? `/stats/journal/reminders?date=${encodeURIComponent(date)}` : "/stats/journal/reminders",
    ),

  // Settings
  getSettings: () => request<Settings>("/settings"),
  updateSettings: (body: Partial<Settings>) =>
    request<Settings>("/settings", { method: "PATCH", body: JSON.stringify(body) }),
};
