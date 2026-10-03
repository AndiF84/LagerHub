// Mitarbeiter-Tab: Live-Status, neuer MA mit Auto-PIN, Geräte-Reset,
// Bearbeiten bestehender MA (Name + Fähigkeiten) sowie Fähigkeiten-Katalog
// (anlegen / umbenennen / löschen).
import { useState } from "react";
import { createPortal } from "react-dom";
import {
  useCreateEmployee,
  useCreateSkill,
  useCrewmeisterMembers,
  useDeleteEmployee,
  useDeleteSkill,
  useEmployees,
  useResetDevice,
  useSkills,
  useUpdateEmployee,
  useUpdateSkill,
} from "../api/queries";
import type { CrewmeisterMember, Employee, Role, Skill } from "../api/types";
import { KebabMenu } from "../components/KebabMenu";
import { useFloatingMenu } from "../components/useFloatingMenu";

// Rolle steuert die Oberfläche (nicht die Einsetzbarkeit): Lager arbeitet über die
// PWA, Büro/Manager über das Dashboard (abgespeckt bzw. voll).
const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "WORKER", label: "Lager (PWA)" },
  { value: "OFFICE", label: "Büro (Dashboard)" },
  { value: "MANAGER", label: "Manager" },
];
const roleLabel = (role: Role) => ROLE_OPTIONS.find((o) => o.value === role)?.label ?? role;

// Anwesenheits-Schiebeschalter: grün = anwesend, rot = abwesend; klickbar.
function PresenceToggle({
  present,
  disabled,
  onChange,
}: {
  present: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className="toggle"
      title={
        present
          ? "Anwesend – klicken für abwesend (Urlaub/Krank)"
          : "Abwesend – klicken für anwesend"
      }
    >
      <input
        type="checkbox"
        checked={present}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle__track" />
      <span className="toggle__thumb" />
    </label>
  );
}

// Anwesenheits-Zelle: Schiebeschalter + (bei Crewmeister-Zuordnung) Modus-Anzeige.
// Ein Klick auf den Schalter "pinnt" den Wert manuell (gewinnt gegen den Sync);
// der [Auto]-Button stellt zurück auf Crewmeister-Steuerung.
function PresenceControl({
  emp,
  disabled,
  onSet,
  onAuto,
}: {
  emp: Employee;
  disabled?: boolean;
  onSet: (value: boolean) => void;
  onAuto: () => void;
}) {
  const hasCrewmeister = emp.crewmeisterUserId != null;
  const pinned = emp.presenceOverride != null;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <PresenceToggle present={emp.present} disabled={disabled} onChange={onSet} />
      {hasCrewmeister &&
        (pinned ? (
          <>
            <span className="muted" style={{ fontSize: 11 }} title="Manuell gesetzt – Crewmeister wird ignoriert">
              manuell
            </span>
            <button
              className="btn"
              style={{ padding: "1px 6px", fontSize: 11 }}
              disabled={disabled}
              title="Wieder automatisch aus Crewmeister steuern"
              onClick={onAuto}
            >
              Auto
            </button>
          </>
        ) : (
          <span className="muted" style={{ fontSize: 11 }} title="Automatisch aus Crewmeister">
            auto
          </span>
        ))}
    </div>
  );
}

// Kompaktes Dropdown zur Mehrfachauswahl: ein Button öffnet ein kleines,
// scrollbares Checkbox-Menü. Jede Fähigkeit einzeln an-/abklickbar, ohne
// Shift/Strg (anders als ein natives <select multiple>).
function SkillMultiSelect({
  skills,
  value,
  onChange,
}: {
  skills: Skill[] | undefined;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  // Gleiche Mechanik wie das Kebab-Menü: Portal + fixed, sonst schneidet das
  // `overflow: hidden` der Tabelle das Menü in der Bearbeiten-Zeile ab.
  const { open, toggle: toggleOpen, triggerRef, dropRef, floatStyle } = useFloatingMenu("left");

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  const selectedNames = skills?.filter((s) => value.includes(s.id)).map((s) => s.name) ?? [];
  const label =
    selectedNames.length === 0
      ? "Fähigkeiten wählen"
      : selectedNames.length <= 2
        ? selectedNames.join(", ")
        : `${selectedNames.length} ausgewählt`;

  return (
    <div className="menu">
      <button
        ref={triggerRef}
        type="button"
        className="btn"
        onClick={toggleOpen}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          minWidth: 220,
          maxWidth: 280,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: selectedNames.length === 0 ? "#6b7280" : undefined,
          }}
        >
          {label}
        </span>
        <span aria-hidden style={{ color: "#6b7280" }}>
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={dropRef}
            className="menu__dropdown menu__dropdown--float"
            role="listbox"
            style={{ ...floatStyle, minWidth: 220, maxHeight: 200, overflowY: "auto" }}
          >
            {skills && skills.length > 0 ? (
              skills.map((s) => (
                <label
                  key={s.id}
                  className="menu__item"
                  style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                >
                  <input type="checkbox" checked={value.includes(s.id)} onChange={() => toggle(s.id)} />
                  {s.name}
                </label>
              ))
            ) : (
              <span className="muted" style={{ padding: "8px 10px" }}>
                Keine Fähigkeiten
              </span>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

// --- Eine Mitarbeiterzeile mit Anzeige-/Bearbeiten-Modus ------------------
function EmployeeRow({
  emp,
  skills,
  members,
  membersError,
}: {
  emp: Employee;
  skills: Skill[] | undefined;
  members: CrewmeisterMember[] | undefined;
  membersError: boolean;
}) {
  const updateEmployee = useUpdateEmployee();
  const resetDevice = useResetDevice();
  const deleteEmployee = useDeleteEmployee();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(emp.name);
  const [role, setRole] = useState<Role>(emp.role);
  const [skillIds, setSkillIds] = useState<string[]>(emp.skills.map((s) => s.skill.id));
  const [crewmeisterUserId, setCrewmeisterUserId] = useState<number | null>(emp.crewmeisterUserId);

  // Anzeigename der Crewmeister-Zuordnung (oder "#<id>", falls die Liste fehlt).
  const memberLabel = (uid: number | null): string | null => {
    if (uid == null) return null;
    return members?.find((m) => m.userId === uid)?.name ?? `#${uid}`;
  };

  // Auswahlliste: nur aktive Mitglieder (übersichtlicher). Ausnahme: ein bereits
  // zugeordnetes, inzwischen deaktiviertes Mitglied bleibt drin – sonst hätte das
  // Feld keinen passenden Eintrag und zeigte "Keine", obwohl die Zuordnung steht.
  const memberOptions = members?.filter((m) => !m.disabled || m.userId === crewmeisterUserId);

  const startEdit = () => {
    setName(emp.name);
    setRole(emp.role);
    setSkillIds(emp.skills.map((s) => s.skill.id));
    setCrewmeisterUserId(emp.crewmeisterUserId);
    setEditing(true);
  };

  const save = () => {
    if (!name.trim()) return;
    updateEmployee.mutate(
      { id: emp.id, name: name.trim(), role, skillIds, crewmeisterUserId },
      { onSuccess: () => setEditing(false) },
    );
  };

  // Schalter klicken = Anwesenheit manuell pinnen (gewinnt gegen den Sync).
  const setPresence = (value: boolean) =>
    updateEmployee.mutate({ id: emp.id, present: value, presenceOverride: value });
  // Zurück auf Crewmeister-Steuerung (Backend rechnet present sofort neu).
  const setAuto = () => updateEmployee.mutate({ id: emp.id, presenceOverride: null });

  if (editing) {
    return (
      <tr>
        <td>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ padding: "4px 8px" }} />
        </td>
        <td>{emp.pin}</td>
        <td>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            style={{ padding: "4px 8px" }}
          >
            {ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </td>
        <td colSpan={3}>
          <SkillMultiSelect skills={skills} value={skillIds} onChange={setSkillIds} />
        </td>
        <td className="muted">{emp.deviceTrusted ? "verbunden" : "–"}</td>
        <td style={{ textAlign: "center" }}>
          <PresenceControl emp={emp} disabled={updateEmployee.isPending} onSet={setPresence} onAuto={setAuto} />
        </td>
        <td>
          {membersError ? (
            <span className="muted" title="Crewmeister nicht erreichbar/konfiguriert">
              n. verfügbar
            </span>
          ) : (
            <select
              value={crewmeisterUserId ?? ""}
              onChange={(e) => setCrewmeisterUserId(e.target.value ? Number(e.target.value) : null)}
              style={{ padding: "4px 8px", maxWidth: 180 }}
            >
              <option value="">Keine</option>
              {memberOptions?.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                  {m.disabled ? " (inaktiv)" : ""}
                </option>
              ))}
            </select>
          )}
        </td>
        <td>
          <button className="btn" onClick={save} disabled={updateEmployee.isPending}>
            Speichern
          </button>{" "}
          <button className="btn" onClick={() => setEditing(false)}>
            Abbrechen
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{emp.name}</td>
      <td>{emp.pin}</td>
      <td>{roleLabel(emp.role)}</td>
      <td className="muted">{emp.skills.map((s) => s.skill.name).join(", ") || "–"}</td>
      <td>
        <span className={`badge badge--${emp.status ?? "free"}`}>
          {emp.status === "active" ? "aktiv" : "frei"}
        </span>
      </td>
      <td className="muted">
        {emp.currentStep ? `${emp.currentStep.taskName} · ${emp.currentStep.stepName}` : "–"}
      </td>
      <td className="muted">{emp.deviceTrusted ? "verbunden" : "–"}</td>
      <td style={{ textAlign: "center" }}>
        <PresenceControl emp={emp} disabled={updateEmployee.isPending} onSet={setPresence} onAuto={setAuto} />
      </td>
      <td className="muted">{memberLabel(emp.crewmeisterUserId) ?? "–"}</td>
      <td style={{ whiteSpace: "nowrap" }}>
        <KebabMenu>
          {(close) => (
            <>
              <button
                className="menu__item"
                onClick={() => {
                  close();
                  startEdit();
                }}
              >
                Bearbeiten
              </button>
              <button
                className="menu__item"
                disabled={resetDevice.isPending || !emp.deviceTrusted}
                onClick={() => {
                  close();
                  resetDevice.mutate(emp.id);
                }}
              >
                Gerät zurücksetzen
              </button>
              <button
                className="menu__item menu__item--danger"
                disabled={deleteEmployee.isPending || emp.status === "active"}
                title={emp.status === "active" ? "Aktiv arbeitender Mitarbeiter kann nicht gelöscht werden" : undefined}
                onClick={() => {
                  if (confirm(`Mitarbeiter "${emp.name}" wirklich löschen?`)) {
                    close();
                    deleteEmployee.mutate(emp.id);
                  }
                }}
              >
                Löschen
              </button>
            </>
          )}
        </KebabMenu>
        {deleteEmployee.isError && <div className="muted">{String(deleteEmployee.error)}</div>}
      </td>
    </tr>
  );
}

// --- Katalog-Zeile: umbenennen / löschen ----------------------------------
function SkillCatalogRow({ skill }: { skill: Skill }) {
  const updateSkill = useUpdateSkill();
  const deleteSkill = useDeleteSkill();
  const [name, setName] = useState(skill.name);

  const dirty = name.trim() !== skill.name && name.trim() !== "";

  return (
    <div className="row" style={{ gap: 8, justifyContent: "flex-start", marginBottom: 6 }}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ padding: "4px 8px", minWidth: 200 }}
      />
      <button
        className="btn"
        disabled={!dirty || updateSkill.isPending}
        onClick={() => updateSkill.mutate({ id: skill.id, name: name.trim() })}
      >
        Umbenennen
      </button>
      <button
        className="btn"
        disabled={deleteSkill.isPending}
        onClick={() => {
          if (confirm(`Fähigkeit "${skill.name}" löschen?`)) deleteSkill.mutate(skill.id);
        }}
      >
        Löschen
      </button>
      {updateSkill.isError && <span className="muted">{String(updateSkill.error)}</span>}
      {deleteSkill.isError && <span className="muted">{String(deleteSkill.error)}</span>}
    </div>
  );
}

// --- Formular „Neuer Mitarbeiter" -----------------------------------------
// Eigener lokaler Tipp-State (name, skillIds), damit Tastendrücke nicht die
// gesamte Mitarbeiter-Tabelle in EmployeesTab neu rendern.
function NewEmployeeForm({ skills }: { skills: Skill[] | undefined }) {
  const createEmployee = useCreateEmployee();

  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("WORKER");
  const [skillIds, setSkillIds] = useState<string[]>([]);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createEmployee.mutate(
      { name: name.trim(), role, skillIds },
      {
        onSuccess: () => {
          setName("");
          setRole("WORKER");
          setSkillIds([]);
        },
      },
    );
  };

  return (
    <form className="card" onSubmit={handleCreate}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Neuer Mitarbeiter</h2>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-start" }}>
        <input
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ padding: "6px 10px", minWidth: 200 }}
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          title="Rolle: Lager arbeitet über die PWA, Büro/Manager über das Dashboard"
          style={{ padding: "6px 10px" }}
        >
          {ROLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div>
          <SkillMultiSelect skills={skills} value={skillIds} onChange={setSkillIds} />
          {(!skills || skills.length === 0) && (
            <div className="muted" style={{ maxWidth: 220, marginTop: 4 }}>
              Noch keine Fähigkeiten – lege unten eine an.
            </div>
          )}
        </div>
        <button className="btn" type="submit" disabled={createEmployee.isPending}>
          Anlegen (Auto-PIN)
        </button>
      </div>
      {createEmployee.isError && <p className="muted">Fehler: {String(createEmployee.error)}</p>}
    </form>
  );
}

export function EmployeesTab() {
  const { data: employees, isLoading, isError, error } = useEmployees();
  const { data: skills } = useSkills();
  const { data: members, isError: membersError } = useCrewmeisterMembers();
  const createSkill = useCreateSkill();

  const [newSkill, setNewSkill] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);

  const handleAddSkill = () => {
    const trimmed = newSkill.trim();
    if (!trimmed) return;
    createSkill.mutate(trimmed, {
      onSuccess: () => {
        setNewSkill("");
      },
    });
  };

  return (
    <div>
      <NewEmployeeForm skills={skills} />

      <div className="card">
        <h2 style={{ fontSize: 16, margin: 0 }}>
          <button
            className="btn"
            type="button"
            onClick={() => setCatalogOpen((v) => !v)}
            aria-expanded={catalogOpen}
            title={catalogOpen ? "Katalog einklappen" : "Katalog aufklappen"}
            style={{ fontSize: 16, fontWeight: 600 }}
          >
            {catalogOpen ? "▾" : "▸"} Fähigkeiten-Katalog ({skills?.length ?? 0})
          </button>
        </h2>

        {catalogOpen && (
          <>
            <div
              className="row"
              style={{ gap: 8, justifyContent: "flex-start", margin: "12px 0" }}
            >
              <input
                placeholder="Neue Fähigkeit"
                value={newSkill}
                onChange={(e) => setNewSkill(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddSkill();
                  }
                }}
                style={{ padding: "6px 10px", minWidth: 200 }}
              />
              <button
                className="btn"
                type="button"
                onClick={handleAddSkill}
                disabled={createSkill.isPending || !newSkill.trim()}
              >
                + Fähigkeit anlegen
              </button>
              {createSkill.isError && (
                <span className="muted">Fehler: {String(createSkill.error)}</span>
              )}
            </div>

            {skills && skills.length === 0 && <p className="muted">Noch keine Fähigkeiten.</p>}
            {skills?.map((s) => (
              <SkillCatalogRow key={s.id} skill={s} />
            ))}
            <p className="muted" style={{ marginBottom: 0 }}>
              Hinweis: Umbenennen ändert auch die zugehörigen Schrittnamen (1:1). Eine von Schritten
              benutzte Fähigkeit lässt sich nicht löschen.
            </p>
          </>
        )}
      </div>

      {isLoading && <p className="muted">Lade Mitarbeiter…</p>}
      {isError && <p className="muted">Fehler: {String(error)}</p>}

      {employees && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>PIN</th>
              <th>Rolle</th>
              <th>Fähigkeiten</th>
              <th>Status</th>
              <th>Aktuell</th>
              <th>Gerät</th>
              <th>Anwesend</th>
              <th>Crewmeister</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {employees.map((emp) => (
              <EmployeeRow
                key={emp.id}
                emp={emp}
                skills={skills}
                members={members}
                membersError={membersError}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
