// TanStack-Query-Datenlayer der PWA. REST ist die Quelle der Wahrheit; das
// WebSocket-Signal (useRealtime) invalidiert die betroffenen Keys. Wie im
// Manager-Frontend invalidieren die Assignment-Mutationen NICHT selbst –
// das WS-Event (ASSIGNMENT_CHANGED) übernimmt das (sonst doppelte Refetches).
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { PoolTask, Settings } from "./types";

export const queryKeys = {
  // Pool ist pro MA gefiltert; der Key trägt die employeeId. WS-Invalidierung
  // trifft per Prefix ["pool"] alle MA-Pools.
  pool: ["pool"] as const,
  poolFor: (employeeId: string) => ["pool", employeeId] as const,
  settings: ["settings"] as const,
};

// Einstellungen ändern sich selten (Schwellwert für die Alters-Ampel) – lange
// Frische, damit nicht jeder Pool-Refetch sie mitzieht. SETTINGS_UPDATED
// invalidiert sie bei Bedarf (useRealtime).
export function useSettings() {
  return useQuery<Settings>({
    queryKey: queryKeys.settings,
    queryFn: api.getSettings,
    staleTime: 5 * 60_000,
  });
}

export function usePool(employeeId: string | undefined) {
  return useQuery<PoolTask[]>({
    queryKey: queryKeys.poolFor(employeeId ?? ""),
    // Eigene employeeId mitschicken → auch MANAGER/OFFICE in der PWA sehen nur die
    // zu ihren Fähigkeiten passenden Schritte (WORKER erzwingt der Server per Token).
    queryFn: () => api.getPool(employeeId!),
    enabled: !!employeeId,
  });
}

// Selbst-Login auf einen Schritt (Identität kommt aus dem Token).
export function useAssignSelf() {
  return useMutation({
    mutationFn: (stepId: string) => api.assignSelf(stepId),
  });
}

// Eigene Zuweisung abschließen / unterbrechen / fortsetzen (per Assignment-ID).
export function useCompleteAssignment() {
  return useMutation({
    mutationFn: (vars: { id: string; note?: string }) => api.complete(vars.id, vars.note),
  });
}
export function usePauseAssignment() {
  return useMutation({ mutationFn: (id: string) => api.pause(id) });
}
export function useResumeAssignment() {
  return useMutation({ mutationFn: (id: string) => api.resume(id) });
}
// Noch nicht gestarteten (Team-)Schritt wieder verlassen (WAITING). Kein
// self-invalidate – ASSIGNMENT_CHANGED (in useRealtime) aktualisiert den Pool.
export function useLeaveAssignment() {
  return useMutation({ mutationFn: (id: string) => api.leave(id) });
}

// Manager-Angebot annehmen / ablehnen (M3). Kein self-invalidate – das WS-Event
// (ASSIGNMENT_CHANGED / ASSIGNMENT_REJECTED) aktualisiert den Pool.
export function useAcceptOffer() {
  return useMutation({ mutationFn: (id: string) => api.acceptOffer(id) });
}
export function useRejectOffer() {
  return useMutation({ mutationFn: (id: string) => api.rejectOffer(id) });
}

// MA-Notiz anhängen (M3). Autor kommt aus dem Token. Wie im Dashboard ohne
// self-invalidate – STEP_NOTE_UPDATED (in useRealtime) invalidiert den Pool.
export function useAddNote() {
  return useMutation({
    mutationFn: (vars: { stepId: string; text: string }) =>
      api.addNote(vars.stepId, vars.text),
  });
}
