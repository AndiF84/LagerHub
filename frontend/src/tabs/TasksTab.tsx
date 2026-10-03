// Aufgabenmaske: Aufgaben anlegen/bearbeiten (Name, Priorität, Kopieren,
// Starten) inkl. Schritt-Verwaltung (anlegen, bearbeiten, löschen).
// Die Schritte sind pro Aufgabe einklappbar; bearbeiten lässt sich alles erst
// nach dem Aufklappen. "Starten" stellt die Aufgabe in den Pool (poolEnabled).
// Hinweis: Ein Schritt-NAME ist nicht editierbar (Skill = Schrittname, 1:1) –
// dafür den Fähigkeiten-Katalog im Mitarbeiter-Tab nutzen.
import { useState } from "react";
import { createPortal } from "react-dom";
import { KebabMenu } from "../components/KebabMenu";
import { useFloatingMenu } from "../components/useFloatingMenu";
import {
  useCopyTask,
  useCreateStep,
  useCreateTask,
  useDeleteStep,
  useDeleteTask,
  useReorderSteps,
  useReorderTasks,
  useRestartTask,
  useSkills,
  useTasks,
  useUpdateStep,
  useUpdateTask,
} from "../api/queries";
import type { NoteFormat, Priority, Skill, Step, Task } from "../api/types";

const PRIORITIES: Priority[] = ["HIGH", "MEDIUM", "LOW"];

// --- Fähigkeit für einen neuen Schritt wählen ------------------------------
// EINFACH-Auswahl, bewusst ohne Checkboxen: ein Schritt trägt genau eine
// Fähigkeit (Schrittname = Skillname, 1:1) – anders als ein Mitarbeiter, der
// mehrere hat (SkillMultiSelect im Mitarbeiter-Tab).
//
// Die Liste ersetzt das frühere Textfeld mit `datalist`: dort musste man erst
// tippen, um überhaupt Vorschläge zu sehen. Das Anlegen NEUER Fähigkeiten muss
// dabei erhalten bleiben – der Schritt-Endpunkt legt über den Skill-Upsert neue
// an, und ohne diesen Weg ließe sich kein Schritt mit neuem Namen mehr
// erstellen. Dafür das Suchfeld im Menü: Was es nicht findet, bietet es als
// „Neu anlegen" an.
function SkillSelect({
  skills,
  value,
  onChange,
}: {
  skills: Skill[] | undefined;
  value: string;
  onChange: (name: string) => void;
}) {
  // Gleiche Mechanik wie Kebab-Menü und Mehrfachauswahl: Portal + fixed.
  const { open, toggle, close, triggerRef, dropRef, floatStyle } = useFloatingMenu("left");
  const [filter, setFilter] = useState("");

  const term = filter.trim().toLowerCase();
  const matches = (skills ?? []).filter((s) => s.name.toLowerCase().includes(term));
  // "Neu anlegen" nur, wenn der Suchtext noch keiner vorhandenen Fähigkeit
  // exakt entspricht – sonst stünde eine Dublette zur Auswahl.
  const exact = (skills ?? []).some((s) => s.name.toLowerCase() === term);
  const canCreate = term !== "" && !exact;

  const pick = (name: string) => {
    onChange(name);
    setFilter("");
    close();
  };

  return (
    <div className="menu">
      <button
        ref={triggerRef}
        type="button"
        className="btn skill-select__trigger"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`skill-select__value${value ? "" : " skill-select__value--empty"}`}>
          {value || "Fähigkeit wählen"}
        </span>
        <span aria-hidden style={{ color: "#6b7280" }}>
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={dropRef}
            className="menu__dropdown menu__dropdown--float skill-select__menu"
            role="listbox"
            style={floatStyle}
          >
            <input
              autoFocus
              className="skill-select__search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Suchen oder neuen Namen eingeben…"
              onKeyDown={(e) => {
                // Enter nimmt den einzigen Treffer bzw. legt neu an – so bleibt
                // das schnelle Tippen aus der alten Textfeld-Lösung erhalten.
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (matches.length === 1) pick(matches[0].name);
                else if (canCreate) pick(filter.trim());
              }}
            />
            <div className="skill-select__list">
              {matches.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="menu__item skill-select__item"
                  onClick={() => pick(s.name)}
                >
                  <span className="skill-select__check" aria-hidden>
                    {s.name === value ? "✓" : ""}
                  </span>
                  {s.name}
                </button>
              ))}
              {matches.length === 0 && !canCreate && (
                <span className="muted" style={{ padding: "8px 10px" }}>
                  Keine Fähigkeiten
                </span>
              )}
            </div>
            {canCreate && (
              <button
                type="button"
                className="menu__item skill-select__create"
                onClick={() => pick(filter.trim())}
              >
                + Neu anlegen: „{filter.trim()}"
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

// --- Pflichtnotiz beim Abschluss: Konfiguration ---------------------------
// Gleiche Felder beim Anlegen und beim Bearbeiten eines Schritts, deshalb hier
// einmal. Format und Beschriftung erscheinen erst, wenn die Pflicht aktiv ist –
// ohne sie haben die beiden Felder keine Wirkung und würden nur verwirren.
function NoteRequirementFields({
  required,
  format,
  label,
  toggleText = "📝 beim Abschluss verlangen",
  onRequiredChange,
  onFormatChange,
  onLabelChange,
}: {
  required: boolean;
  format: NoteFormat;
  label: string;
  // Beschriftung der Checkbox. In der Bearbeiten-Box steht "Pflichtnotiz" schon
  // als Zeilen-Beschriftung links daneben; im Anlegeformular gibt es die nicht,
  // dort muss der Block seinen Namen selbst tragen.
  toggleText?: string;
  onRequiredChange: (v: boolean) => void;
  onFormatChange: (v: NoteFormat) => void;
  onLabelChange: (v: string) => void;
}) {
  return (
    <div className={`note-req${required ? " note-req--on" : ""}`}>
      <label className="note-req__toggle">
        <input
          type="checkbox"
          checked={required}
          onChange={(e) => onRequiredChange(e.target.checked)}
        />
        {toggleText}
      </label>

      {required && (
        <>
          <select
            className="note-req__format"
            value={format}
            onChange={(e) => onFormatChange(e.target.value as NoteFormat)}
            title="Was darf eingetragen werden?"
          >
            <option value="TEXT">Freitext</option>
            <option value="NUMBER">Zahl</option>
          </select>
          <input
            className="note-req__label"
            value={label}
            onChange={(e) => onLabelChange(e.target.value)}
            placeholder="Beschriftung, z. B. Anzahl Paletten"
            maxLength={80}
          />
        </>
      )}
    </div>
  );
}

// --- Schritt-Zeile: Anzeige / Bearbeiten / Löschen / Verschieben ----------
function StepRow({
  step,
  siblings,
  reordering,
  isDragging,
  isOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  step: Step;
  siblings: Step[];
  reordering: boolean;
  isDragging: boolean;
  isOver: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const updateStep = useUpdateStep();
  const deleteStep = useDeleteStep();
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(step.description);
  const [minWorkers, setMinWorkers] = useState(step.minWorkers?.toString() ?? "");
  const [maxWorkers, setMaxWorkers] = useState(step.maxWorkers?.toString() ?? "");
  const [predIds, setPredIds] = useState<string[]>(step.predecessors.map((p) => p.predecessor.id));
  const [noteRequired, setNoteRequired] = useState(step.noteRequired);
  const [noteFormat, setNoteFormat] = useState<NoteFormat>(step.noteFormat);
  const [noteLabel, setNoteLabel] = useState(step.noteLabel);

  const startEdit = () => {
    setDescription(step.description);
    setMinWorkers(step.minWorkers?.toString() ?? "");
    setMaxWorkers(step.maxWorkers?.toString() ?? "");
    setPredIds(step.predecessors.map((p) => p.predecessor.id));
    setNoteRequired(step.noteRequired);
    setNoteFormat(step.noteFormat);
    setNoteLabel(step.noteLabel);
    setEditing(true);
  };

  const save = () => {
    updateStep.mutate(
      {
        id: step.id,
        description,
        minWorkers: minWorkers ? Number(minWorkers) : null,
        maxWorkers: maxWorkers ? Number(maxWorkers) : null,
        predecessorIds: predIds,
        noteRequired,
        noteFormat,
        noteLabel: noteLabel.trim(),
      },
      { onSuccess: () => setEditing(false) },
    );
  };

  const togglePred = (id: string) =>
    setPredIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));

  const others = siblings.filter((s) => s.id !== step.id);

  // Bearbeiten: die Zeile wird zur Box über die volle Tabellenbreite. Als
  // Tabellenzeile mussten sich die Felder die Spaltenbreiten der Anzeige teilen –
  // die "Wartet auf"-Auswahl bekam so wenige Zentimeter, dass jeder Schrittname
  // umbrach. Als Raster (Beschriftung | Feld) hat jedes Feld die volle Breite und
  // alle Beschriftungen fluchten untereinander.
  if (editing) {
    return (
      <tr className="step-edit-row">
        <td colSpan={6}>
          <div className="step-edit">
            <div className="step-edit__head">
              <span className="step-edit__no">{step.orderIndex + 1}</span>
              <strong>{step.name}</strong>
            </div>

            <div className="step-edit__grid">
              <label htmlFor={`desc-${step.id}`}>Beschreibung</label>
              <input
                id={`desc-${step.id}`}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Beschreibung"
              />

              <label htmlFor={`min-${step.id}`}>Team</label>
              <div className="step-edit__team">
                <input
                  id={`min-${step.id}`}
                  type="number"
                  min={1}
                  value={minWorkers}
                  onChange={(e) => setMinWorkers(e.target.value)}
                  placeholder="min"
                />
                <span className="muted">bis</span>
                <input
                  type="number"
                  min={1}
                  value={maxWorkers}
                  onChange={(e) => setMaxWorkers(e.target.value)}
                  placeholder="max"
                />
                <span className="muted">MA (leer = Einzelschritt)</span>
              </div>

              <label>Wartet auf</label>
              <div>
                {others.length === 0 ? (
                  <span className="muted">Kein anderer Schritt vorhanden</span>
                ) : (
                  <div className="check-list">
                    {others.map((s) => (
                      <label key={s.id} className="check-list__item">
                        <input
                          type="checkbox"
                          checked={predIds.includes(s.id)}
                          onChange={() => togglePred(s.id)}
                        />
                        <span>{s.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Letzte Zeile der Box – die Pflichtnotiz ist die einzige
                  Einstellung, die den Abschluss blockieren kann; sie steht
                  bewusst am Ende, direkt über den Schaltflächen. */}
              <label>Pflichtnotiz</label>
              <NoteRequirementFields
                required={noteRequired}
                format={noteFormat}
                label={noteLabel}
                onRequiredChange={setNoteRequired}
                onFormatChange={setNoteFormat}
                onLabelChange={setNoteLabel}
              />
            </div>

            <div className="step-edit__actions">
              <button className="btn btn--primary" onClick={save} disabled={updateStep.isPending}>
                Speichern
              </button>
              <button className="btn" onClick={() => setEditing(false)}>
                Abbrechen
              </button>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr
      draggable={!reordering}
      onDragStart={onDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      style={{
        opacity: isDragging ? 0.4 : 1,
        boxShadow: isOver && !isDragging ? "inset 0 2px 0 #2563eb" : undefined,
        cursor: reordering ? "default" : "grab",
      }}
    >
      <td style={{ whiteSpace: "nowrap" }}>
        <span className="muted" title="Zum Verschieben ziehen" style={{ cursor: "grab" }}>
          ⠿
        </span>{" "}
        {step.orderIndex + 1}
      </td>
      <td>
        {step.name}
        {step.noteRequired && (
          <span
            className="badge"
            title={`Pflichtnotiz beim Abschluss${
              step.noteLabel ? `: ${step.noteLabel}` : ""
            } (${step.noteFormat === "NUMBER" ? "Zahl" : "Freitext"})`}
            style={{ marginLeft: 6 }}
          >
            📝 Pflichtnotiz
          </span>
        )}
      </td>
      <td className="muted">{step.description || "–"}</td>
      <td className="muted">
        {step.minWorkers && step.minWorkers >= 2
          ? `${step.minWorkers}–${step.maxWorkers ?? "?"}`
          : "Einzel"}
      </td>
      <td className="muted">
        {step.predecessors.map((p) => p.predecessor.name).join(", ") || "–"}
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        <button className="btn" onClick={startEdit}>
          Bearbeiten
        </button>{" "}
        <button
          className="btn"
          disabled={deleteStep.isPending}
          onClick={() => {
            if (confirm(`Schritt "${step.name}" löschen?`)) deleteStep.mutate(step.id);
          }}
        >
          Löschen
        </button>
      </td>
    </tr>
  );
}

// --- Formular: neuen Schritt anlegen --------------------------------------
function AddStepForm({ taskId }: { taskId: string }) {
  const createStep = useCreateStep();
  const { data: skills } = useSkills();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [minWorkers, setMinWorkers] = useState("");
  const [maxWorkers, setMaxWorkers] = useState("");
  const [noteRequired, setNoteRequired] = useState(false);
  const [noteFormat, setNoteFormat] = useState<NoteFormat>("TEXT");
  const [noteLabel, setNoteLabel] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createStep.mutate(
      {
        taskId,
        name: name.trim(),
        description: description.trim(),
        minWorkers: minWorkers ? Number(minWorkers) : null,
        maxWorkers: maxWorkers ? Number(maxWorkers) : null,
        noteRequired,
        noteFormat,
        noteLabel: noteLabel.trim(),
      },
      {
        onSuccess: () => {
          setName("");
          setDescription("");
          setMinWorkers("");
          setMaxWorkers("");
          setNoteRequired(false);
          setNoteFormat("TEXT");
          setNoteLabel("");
        },
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      className="row"
      style={{ gap: 6, justifyContent: "flex-start", marginTop: 8, flexWrap: "wrap" }}
    >
      <SkillSelect skills={skills} value={name} onChange={setName} />
      <input
        placeholder="Beschreibung"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        style={{ padding: "4px 8px", minWidth: 160 }}
      />
      <input
        type="number"
        min={1}
        placeholder="min"
        value={minWorkers}
        onChange={(e) => setMinWorkers(e.target.value)}
        style={{ width: 60, padding: "4px 6px" }}
      />
      <input
        type="number"
        min={1}
        placeholder="max"
        value={maxWorkers}
        onChange={(e) => setMaxWorkers(e.target.value)}
        style={{ width: 60, padding: "4px 6px" }}
      />
      {/* Eigene Zeile VOR dem Absenden: die Pflichtnotiz ist eine Eigenschaft
          des Schritts, gehört also zu den Feldern und nicht hinter den Button.
          Volle Breite, damit sie nicht zwischen die kurzen min/max-Felder rutscht. */}
      <div style={{ flexBasis: "100%" }}>
        <NoteRequirementFields
          required={noteRequired}
          format={noteFormat}
          label={noteLabel}
          toggleText="📝 Pflichtnotiz beim Abschluss"
          onRequiredChange={setNoteRequired}
          onFormatChange={setNoteFormat}
          onLabelChange={setNoteLabel}
        />
      </div>
      <button className="btn" type="submit" disabled={createStep.isPending}>
        + Schritt
      </button>
      <span className="muted">Vorgänger = letzter Schritt (danach editierbar)</span>
    </form>
  );
}

// --- Eine Aufgaben-Karte --------------------------------------------------
// Drag & Drop der Aufgaben-Karten. Gezogen wird NUR am Griff (⠿) im Kartenkopf,
// nicht an der ganzen Karte: in der Karte steckt die Schritt-Tabelle, deren
// Zeilen selbst ziehbar sind – zwei verschachtelte draggable-Flächen würden sich
// gegenseitig die Ereignisse wegnehmen. Abgelegt werden kann auf der ganzen Karte.
interface TaskDrag {
  isDragging: boolean;
  isOver: boolean;
  disabled: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

function TaskCard({ task, drag }: { task: Task; drag: TaskDrag }) {
  const updateTask = useUpdateTask();
  const copyTask = useCopyTask();
  const restartTask = useRestartTask();
  const deleteTask = useDeleteTask();
  const reorderSteps = useReorderSteps();

  // Neue Reihenfolge ans Backend schicken; es setzt orderIndex neu und baut die
  // "Wartet auf"-Kette neu auf.
  const applyOrder = (ids: string[]) =>
    reorderSteps.mutate({ taskId: task.id, orderedIds: ids });

  // Drag & Drop: gezogenen Schritt aus der Liste nehmen und an Zielposition
  // wieder einfügen.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const dropOn = (target: number) => {
    if (dragIndex !== null && dragIndex !== target) {
      const ids = task.steps.map((s) => s.id);
      const [moved] = ids.splice(dragIndex, 1);
      ids.splice(target, 0, moved);
      applyOrder(ids);
    }
    setDragIndex(null);
    setOverIndex(null);
  };

  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(task.name);
  const [expanded, setExpanded] = useState(false);
  // Inline-Bestätigung statt blockierendem confirm() (ein gesperrter Browser-
  // Dialog konnte sonst den Start verschlucken).
  const [confirmingStart, setConfirmingStart] = useState(false);

  const saveName = () => {
    if (!name.trim()) return;
    updateTask.mutate({ id: task.id, name: name.trim() }, { onSuccess: () => setEditingName(false) });
  };

  const startTask = () => {
    const onError = (e: unknown) => alert(`Starten fehlgeschlagen: ${String(e)}`);
    updateTask.mutate({ id: task.id, poolEnabled: true }, { onError });
    restartTask.mutate(task.id, { onError });
    setConfirmingStart(false);
  };

  return (
    <div
      className="card"
      // Ein gezogener Schritt aus der Tabelle darin blubbert ebenfalls hier
      // hoch – der Tab wertet onDragOver/onDrop nur aus, wenn eine AUFGABE
      // gezogen wird.
      onDragOver={(e) => {
        e.preventDefault();
        drag.onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        drag.onDrop();
      }}
      style={{
        opacity: drag.isDragging ? 0.4 : 1,
        boxShadow: drag.isOver && !drag.isDragging ? "inset 0 3px 0 #2563eb" : undefined,
      }}
    >
      {/* Name wächst (flex:1) und schiebt den Steuerungsblock an den rechten Rand –
          fester Anker, damit die Felder unabhängig von der Namenslänge über alle
          Karten hinweg untereinander fluchten. */}
      <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-start" }}>
        <div className="row row--start" style={{ gap: 8, flex: "1 1 auto", minWidth: 0, alignItems: "center" }}>
          <span
            className="muted"
            draggable={!drag.disabled}
            onDragStart={(e) => {
              // Firefox startet ohne gesetzte Daten gar keinen Drag.
              e.dataTransfer.setData("text/plain", task.id);
              e.dataTransfer.effectAllowed = "move";
              drag.onDragStart();
            }}
            onDragEnd={drag.onDragEnd}
            title="Zum Verschieben ziehen"
            style={{ cursor: drag.disabled ? "default" : "grab", userSelect: "none", padding: "0 2px" }}
          >
            ⠿
          </span>
          {editingName ? (
            <>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ padding: "4px 8px" }}
              />
              <button className="btn" onClick={saveName} disabled={updateTask.isPending}>
                OK
              </button>
              <button className="btn" onClick={() => setEditingName(false)}>
                Abbrechen
              </button>
            </>
          ) : (
            <strong>{task.name}</strong>
          )}
        </div>

        <div className="row" style={{ gap: 8, flexWrap: "wrap", flexShrink: 0, alignItems: "center" }}>
          <select
            value={task.priority}
            disabled={updateTask.isPending}
            onChange={(e) => updateTask.mutate({ id: task.id, priority: e.target.value as Priority })}
            style={{ width: 116 }}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            className="btn"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            title={expanded ? "Schritte einklappen" : "Schritte aufklappen"}
            style={{ minWidth: 132, textAlign: "left" }}
          >
            {expanded ? "▾" : "▸"} Schritte ({task.steps.length})
          </button>
          <label
            className="row"
            style={{ gap: 4, fontSize: 13, alignItems: "center", whiteSpace: "nowrap" }}
            title="Aufgabe nach Abschluss automatisch neu starten (bleibt im Pool)"
          >
            <input
              type="checkbox"
              checked={task.repeat}
              disabled={updateTask.isPending}
              onChange={(e) => updateTask.mutate({ id: task.id, repeat: e.target.checked })}
            />
            Wiederholen
          </label>
          {/* Fester Slot, damit "Starten" bzw. "● im Pool" über alle Karten an
              derselben Stelle steht. Die Bestätigung erscheint als eigene Leiste
              unter dem Kopf (siehe unten) – so springt hier nichts. */}
          <div style={{ minWidth: 96, display: "flex", alignItems: "center" }}>
            {task.poolEnabled ? (
              <span className="muted" style={{ fontSize: 13 }} title="Aufgabe ist im Pool/Dashboard">
                ● im Pool
              </span>
            ) : (
              <button
                className="btn"
                disabled={restartTask.isPending || updateTask.isPending}
                onClick={() => setConfirmingStart((v) => !v)}
                aria-expanded={confirmingStart}
                title="Aufgabe in den Pool stellen (laufende Zuweisungen werden zurückgesetzt)"
              >
                Starten
              </button>
            )}
          </div>
          <KebabMenu>
            {(close) => (
              <>
                <button
                  className="menu__item"
                  onClick={() => {
                    setName(task.name);
                    setEditingName(true);
                    close();
                  }}
                >
                  Umbenennen
                </button>
                <button
                  className="menu__item"
                  disabled={copyTask.isPending}
                  onClick={() => {
                    close();
                    const newName = prompt("Name der Kopie:", `${task.name} (Kopie)`);
                    if (newName?.trim()) copyTask.mutate({ id: task.id, name: newName.trim() });
                  }}
                >
                  Kopieren
                </button>
                <button
                  className="menu__item menu__item--danger"
                  disabled={deleteTask.isPending}
                  onClick={() => {
                    close();
                    if (
                      confirm(
                        `Aufgabe "${task.name}" löschen? Sie verschwindet aus Liste und Pool; der Verlauf (Statistik) bleibt erhalten.`,
                      )
                    ) {
                      deleteTask.mutate(task.id, {
                        onError: (e) => alert(`Löschen fehlgeschlagen: ${String(e)}`),
                      });
                    }
                  }}
                >
                  Löschen
                </button>
              </>
            )}
          </KebabMenu>
        </div>
      </div>

      {/* Start-Bestätigung als eigene Leiste unter dem Kopf – der Kopf bleibt
          stabil, statt dass die Steuerung beim Aufklappen nach links springt. */}
      {confirmingStart && !task.poolEnabled && (
        <div
          className="row"
          style={{
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            marginTop: 8,
            padding: "8px 10px",
            background: "var(--hover)",
            borderRadius: "var(--r-sm)",
          }}
        >
          <span className="muted" style={{ fontSize: 13 }}>
            In den Pool stellen? Laufende Zuweisungen werden zurückgesetzt.
          </span>
          <span style={{ flex: "1 1 auto" }} />
          <button
            className="btn btn--primary"
            disabled={restartTask.isPending || updateTask.isPending}
            onClick={startTask}
          >
            Ja, starten
          </button>
          <button className="btn" onClick={() => setConfirmingStart(false)}>
            Abbrechen
          </button>
        </div>
      )}

      {expanded && (
        <>
          <table style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>#</th>
                <th>Schritt</th>
                <th>Beschreibung</th>
                <th>Team</th>
                <th>Wartet auf</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {task.steps.map((step, index) => (
                <StepRow
                  key={step.id}
                  step={step}
                  siblings={task.steps}
                  reordering={reorderSteps.isPending}
                  isDragging={dragIndex === index}
                  isOver={overIndex === index}
                  onDragStart={() => setDragIndex(index)}
                  onDragOver={() => setOverIndex(index)}
                  onDrop={() => dropOn(index)}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                />
              ))}
              {task.steps.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    Noch keine Schritte.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {task.steps.length > 1 && (
            <p className="muted" style={{ margin: "8px 0 0" }}>
              Zum Sortieren Zeile ziehen (⠿). „Wartet auf" wird dabei geleert –
              danach pro Schritt neu setzbar.
            </p>
          )}

          <AddStepForm taskId={task.id} />
        </>
      )}
    </div>
  );
}

export function TasksTab() {
  const { data: tasks, isLoading, isError, error } = useTasks();
  const createTask = useCreateTask();
  const reorderTasks = useReorderTasks();

  // Drag & Drop der Aufgaben: gezogene Aufgabe aus der Liste nehmen und an der
  // Zielposition wieder einfügen (gleiches Muster wie bei den Schritten).
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const dropOn = (targetId: string) => {
    if (tasks && dragId !== null && dragId !== targetId) {
      const ids = tasks.map((t) => t.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(targetId);
      if (from !== -1 && to !== -1) {
        ids.splice(from, 1);
        ids.splice(to, 0, dragId);
        reorderTasks.mutate(ids, {
          onError: (e) => alert(`Verschieben fehlgeschlagen: ${String(e)}`),
        });
      }
    }
    setDragId(null);
    setOverId(null);
  };

  const [name, setName] = useState("");
  const [priority, setPriority] = useState<Priority>("MEDIUM");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createTask.mutate(
      { name: name.trim(), priority },
      {
        onSuccess: () => {
          setName("");
          setPriority("MEDIUM");
        },
      },
    );
  };

  return (
    <div>
      <form className="card" onSubmit={submit}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Neue Aufgabe</h2>
        <div className="row" style={{ gap: 8, justifyContent: "flex-start", flexWrap: "wrap" }}>
          <input
            placeholder="Aufgabenname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ padding: "6px 10px", minWidth: 220 }}
          />
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button className="btn" type="submit" disabled={createTask.isPending}>
            Anlegen
          </button>
          <span className="muted">Schritte fügst du danach pro Aufgabe hinzu.</span>
        </div>
        {createTask.isError && <p className="muted">Fehler: {String(createTask.error)}</p>}
      </form>

      {isLoading && <p className="muted">Lade Aufgaben…</p>}
      {isError && <p className="muted">Fehler: {String(error)}</p>}
      {tasks && tasks.length === 0 && <p className="muted">Keine Aufgaben vorhanden.</p>}

      {tasks?.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          drag={{
            isDragging: dragId === task.id,
            isOver: dragId !== null && overId === task.id,
            disabled: reorderTasks.isPending,
            onDragStart: () => setDragId(task.id),
            // Nur reagieren, wenn eine Aufgabe gezogen wird (nicht ein Schritt).
            onDragOver: () => {
              if (dragId !== null) setOverId(task.id);
            },
            onDrop: () => {
              if (dragId !== null) dropOn(task.id);
            },
            onDragEnd: () => {
              setDragId(null);
              setOverId(null);
            },
          }}
        />
      ))}
    </div>
  );
}
