// Zentrale Query-Keys + TanStack-Query-Hooks. Die REST-API ist die Quelle der
// Wahrheit; der WebSocket invalidiert nur diese Keys (siehe useRealtime).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ReminderInput, type StepInput, type StepPatch } from "./client";
import type { Priority, ReminderDecision, Role, Settings, Task } from "./types";

export const queryKeys = {
  tasks: ["tasks"] as const,
  pool: ["pool"] as const,
  employees: ["employees"] as const,
  crewmeisterMembers: ["crewmeister-members"] as const,
  skills: ["skills"] as const,
  statsSummary: ["stats", "summary"] as const,
  tasksByStatus: ["stats", "tasks-by-status"] as const,
  employeeLoad: ["stats", "employee-load"] as const,
  // Prefix "stats" → wird durch bestehende ["stats"]-Invalidierung (z. B. bei
  // TASK_COMPLETED) automatisch mit aktualisiert.
  journal: ["stats", "journal"] as const,
  journalDays: ["stats", "journal", "days"] as const,
  journalByDate: (date: string) => ["stats", "journal", "date", date] as const,
  employeeHistory: (from: string, to: string) =>
    ["stats", "employee-history", from, to] as const,
  throughput: (from: string, to: string) => ["stats", "throughput", from, to] as const,
  stepDurations: (from: string, to: string) => ["stats", "step-durations", from, to] as const,
  employeeDetail: (employeeId: string, from: string, to: string) =>
    ["stats", "employee-detail", employeeId, from, to] as const,
  settings: ["settings"] as const,
  reminders: ["reminders"] as const,
  remindersDue: ["reminders", "due"] as const,
  // Prefix "stats" wie das uebrige Journal: eine ["stats"]-Invalidierung
  // (z. B. TASK_COMPLETED, JOURNAL_UPDATED) frischt die Entscheidungen mit auf.
  journalReminders: ["stats", "journal", "reminders"] as const,
  journalRemindersByDate: (date: string) =>
    ["stats", "journal", "reminders", date] as const,
};

// --- Queries ---

export const useTasks = () => useQuery({ queryKey: queryKeys.tasks, queryFn: api.listTasks });

export const usePool = () => useQuery({ queryKey: queryKeys.pool, queryFn: api.listPool });

export const useEmployees = () =>
  useQuery({ queryKey: queryKeys.employees, queryFn: api.listEmployees });

// Crewmeister-Mitglieder für die MA-Zuordnung. Bei 503 (nicht konfiguriert/
// erreichbar) nicht endlos retryen – der Tab zeigt dann einen Hinweis.
export const useCrewmeisterMembers = () =>
  useQuery({
    queryKey: queryKeys.crewmeisterMembers,
    queryFn: api.crewmeisterMembers,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

export const useSkills = () => useQuery({ queryKey: queryKeys.skills, queryFn: api.listSkills });

export const useStatsSummary = () =>
  useQuery({ queryKey: queryKeys.statsSummary, queryFn: api.statsSummary });

export const useTasksByStatus = () =>
  useQuery({ queryKey: queryKeys.tasksByStatus, queryFn: api.tasksByStatus });

export const useEmployeeLoad = () =>
  useQuery({ queryKey: queryKeys.employeeLoad, queryFn: api.employeeLoad });

export const useJournal = () =>
  useQuery({ queryKey: queryKeys.journal, queryFn: api.journal });

export const useJournalDays = () =>
  useQuery({ queryKey: queryKeys.journalDays, queryFn: api.journalDays });

// Einträge eines bestimmten Tages – nur laden, wenn ein Tag ausgewählt ist.
export const useJournalByDate = (date: string | null) =>
  useQuery({
    queryKey: queryKeys.journalByDate(date ?? ""),
    queryFn: () => api.journalByDate(date as string),
    enabled: !!date,
  });

// Historie-Auswertungen über einen Zeitraum (Schlüssel enthält from/to → neuer
// Zeitraum = Refetch). Prefix "stats" → wird bei TASK_COMPLETED mit aktualisiert.
export const useEmployeeHistory = (from: string, to: string) =>
  useQuery({
    queryKey: queryKeys.employeeHistory(from, to),
    queryFn: () => api.employeeHistory({ from, to }),
  });

export const useThroughput = (from: string, to: string) =>
  useQuery({
    queryKey: queryKeys.throughput(from, to),
    queryFn: () => api.throughput({ from, to }),
  });

export const useStepDurations = (from: string, to: string) =>
  useQuery({
    queryKey: queryKeys.stepDurations(from, to),
    queryFn: () => api.stepDurations({ from, to }),
  });

// MA-Detail-Auswertung – nur laden, wenn ein konkreter MA gewählt ist ("Alle" = "").
export const useEmployeeDetail = (employeeId: string, from: string, to: string) =>
  useQuery({
    queryKey: queryKeys.employeeDetail(employeeId, from, to),
    queryFn: () => api.employeeDetail({ employeeId, from, to }),
    enabled: !!employeeId,
  });

// --- Mutations ---
// Nach Erfolg wird nicht manuell gepatcht – das passende WS-Event löst die
// Invalidierung aus. Zur Sicherheit (z. B. Event verpasst) invalidieren wir
// zusätzlich direkt.

// Tasks & Steps. Invalidieren bewusst tasks + pool (+ stats), da sich Status/
// Pool-Sichtbarkeit aus denselben Daten ableiten.
function invalidateTaskViews(qc: ReturnType<typeof useQueryClient>, withStats = false) {
  qc.invalidateQueries({ queryKey: queryKeys.tasks });
  qc.invalidateQueries({ queryKey: queryKeys.pool });
  if (withStats) qc.invalidateQueries({ queryKey: ["stats"] });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; priority?: Priority }) => api.createTask(body),
    onSuccess: () => invalidateTaskViews(qc, true),
  });
}

export function useCopyTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; name: string }) => api.copyTask(vars.id, vars.name),
    onSuccess: () => invalidateTaskViews(qc),
  });
}

export function useRestartTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.restartTask(id),
    onSuccess: () => invalidateTaskViews(qc, true),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess: () => invalidateTaskViews(qc, true),
  });
}

export function useCreateStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StepInput) => api.createStep(body),
    onSuccess: () => invalidateTaskViews(qc),
  });
}

export function useUpdateStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string } & StepPatch) => {
      const { id, ...body } = vars;
      return api.updateStep(id, body);
    },
    onSuccess: () => invalidateTaskViews(qc),
  });
}

export function useDeleteStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteStep(id),
    onSuccess: () => invalidateTaskViews(qc),
  });
}

// Aufgaben-Reihenfolge (Drag & Drop im Aufgaben-Tab). Optimistisch: die Liste
// springt sofort an den neuen Platz, statt bis zur Server-Antwort an der alten
// Stelle zu stehen und dann zu springen. Bei Fehler (z. B. 409, weil parallel
// eine Aufgabe dazukam) wird neu geladen.
export function useReorderTasks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: string[]) => api.reorderTasks(orderedIds),
    onMutate: async (orderedIds) => {
      await qc.cancelQueries({ queryKey: queryKeys.tasks });
      const prev = qc.getQueryData<Task[]>(queryKeys.tasks);
      if (prev) {
        const byId = new Map(prev.map((t) => [t.id, t]));
        qc.setQueryData<Task[]>(
          queryKeys.tasks,
          orderedIds.map((id) => byId.get(id)).filter((t): t is Task => !!t),
        );
      }
    },
    onSettled: () => invalidateTaskViews(qc),
  });
}

export function useReorderSteps() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { taskId: string; orderedIds: string[] }) =>
      api.reorderSteps(vars.taskId, vars.orderedIds),
    onSuccess: () => invalidateTaskViews(qc),
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      priority?: Priority;
      poolEnabled?: boolean;
      repeat?: boolean;
      name?: string;
    }) => {
      const { id, ...body } = vars;
      return api.updateTask(id, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks });
      qc.invalidateQueries({ queryKey: queryKeys.pool });
    },
  });
}

// Zuweisungen (Einsetzen/Annehmen/Ablehnen/Pause/Fortsetzen/Erledigt):
// KEINE manuelle Invalidierung. Jede dieser Aktionen löst im Backend ein
// WS-Event aus (ASSIGNMENT_OFFERED/_CHANGED/_REJECTED, ggf. weitere wie
// STEP_TIMER_STARTED/TASK_UPDATED), das in useRealtime gebündelt die betroffenen
// Keys invalidiert – und zwar für ALLE Clients. Eine zusätzliche Invalidierung
// hier verdoppelte sonst jeden Refetch (Mutation-Welle + Event-Welle).

export function useOfferAssignment() {
  return useMutation({
    mutationFn: (vars: { employeeId: string; stepId: string }) =>
      api.offerAssignment(vars.employeeId, vars.stepId),
  });
}

export function useAcceptAssignment() {
  return useMutation({
    mutationFn: (id: string) => api.acceptAssignment(id),
  });
}

export function useRejectAssignment() {
  return useMutation({
    mutationFn: (id: string) => api.rejectAssignment(id),
  });
}

export function usePauseAssignment() {
  return useMutation({
    mutationFn: (id: string) => api.pauseAssignment(id),
  });
}

export function useResumeAssignment() {
  return useMutation({
    mutationFn: (id: string) => api.resumeAssignment(id),
  });
}

export function useCompleteAssignment() {
  return useMutation({
    mutationFn: (vars: { id: string; note?: string }) =>
      api.completeAssignment(vars.id, vars.note),
  });
}

// Notiz-Mutationen: KEINE manuelle Invalidierung. Das Backend publiziert
// STEP_NOTE_UPDATED bzw. JOURNAL_UPDATED/_DELETED, was in useRealtime gebündelt
// die passenden Keys (pool bzw. ["stats"]) für alle Clients invalidiert.

export function useAddStepNote() {
  return useMutation({
    mutationFn: (vars: { stepId: string; text: string }) =>
      api.addStepNote(vars.stepId, vars.text),
  });
}

export function useAddJournalNote() {
  return useMutation({
    mutationFn: (vars: { runId: string; stepId: string; text: string }) =>
      api.addJournalNote(vars.runId, vars.stepId, vars.text),
  });
}

export function useDeleteJournalDay() {
  return useMutation({
    mutationFn: (date: string) => api.deleteJournalDay(date),
  });
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createSkill(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.skills }),
  });
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; name: string }) => api.updateSkill(vars.id, vars.name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.skills });
      qc.invalidateQueries({ queryKey: queryKeys.employees });
      // Schrittnamen werden mit umbenannt (1:1) → Aufgaben/Pool aktualisieren
      qc.invalidateQueries({ queryKey: queryKeys.tasks });
      qc.invalidateQueries({ queryKey: queryKeys.pool });
    },
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSkill(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.skills });
      qc.invalidateQueries({ queryKey: queryKeys.employees });
    },
  });
}

// Dashboard-PIN-Anmeldung. Reine Aktion ohne Cache-Bezug (kein invalidate).
export function usePinLogin() {
  return useMutation({ mutationFn: (pin: string) => api.pinLogin(pin) });
}

export const useSettings = () =>
  useQuery({ queryKey: queryKeys.settings, queryFn: api.getSettings });

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Settings>) => api.updateSettings(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings }),
  });
}

export function useCreateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; skillIds?: string[]; present?: boolean; role?: Role }) =>
      api.createEmployee(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.employees }),
  });
}

export function useUpdateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      name?: string;
      skillIds?: string[];
      present?: boolean;
      role?: Role;
      crewmeisterUserId?: number | null;
      presenceOverride?: boolean | null;
    }) => {
      const { id, ...body } = vars;
      return api.updateEmployee(id, body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.employees }),
  });
}

export function useResetDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.resetDevice(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.employees }),
  });
}

export function useDeleteEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteEmployee(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.employees });
      // Auslastungs-Statistik bezieht sich auf Mitarbeiter
      qc.invalidateQueries({ queryKey: ["stats"] });
    },
  });
}

// --- Erinnerungen ---------------------------------------------------------

export const useReminders = () =>
  useQuery({ queryKey: queryKeys.reminders, queryFn: api.listReminders });

// Faellige Erinnerungen fuers Dashboard-Banner.
export const useDueReminders = () =>
  useQuery({ queryKey: queryKeys.remindersDue, queryFn: api.listDueReminders });

// Entscheidungen des Tages (ohne date = heute) fuers Tagesjournal.
export const useJournalReminders = (date?: string) =>
  useQuery({
    queryKey: date ? queryKeys.journalRemindersByDate(date) : queryKeys.journalReminders,
    queryFn: () => api.journalReminders(date),
  });

export const useCreateReminder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReminderInput) => api.createReminder(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.reminders });
    },
  });
};

export const useUpdateReminder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Partial<ReminderInput> & { active?: boolean }) =>
      api.updateReminder(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.reminders });
    },
  });
};

export const useDeleteReminder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteReminder(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.reminders });
    },
  });
};

// Entscheidung ueber eine faellige Erinnerung. Invalidiert NICHT selbst - das
// Backend publiziert REMINDER_UPDATED + JOURNAL_UPDATED, die EVENT_MAP raeumt
// beides ab (gleiche Regel wie bei den Assignment-Mutationen).
export const useDecideReminder = () =>
  useMutation({
    mutationFn: ({ id, decision, days }: { id: string; decision: ReminderDecision; days?: number }) =>
      api.decideReminder(id, decision, days),
  });
