// Gemeinsame Mechanik für aufklappende Menüs (Kebab-Menü, Mehrfachauswahl).
//
// Warum aufwendiger als ein absolut positioniertes Dropdown: die Menüs stehen in
// Tabellenzellen, und `table` hat `overflow: hidden` (nötig, damit die abgerundeten
// Tabellenecken greifen). Ein absolut positioniertes Menü wird davon abgeschnitten –
// bei den unteren Zeilen fast vollständig. Deshalb hängt der Inhalt per Portal am
// <body> (Aufrufer) und wird hier `fixed` aus dem Rechteck des Auslösers platziert:
// klappt nach oben, wenn unten kein Platz ist, und bleibt im Fenster.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const GAP = 6; // Abstand zwischen Auslöser und Menü
const EDGE = 8; // Mindestabstand zum Fensterrand

export type MenuAlign = "left" | "right";

export function useFloatingMenu<T extends HTMLElement = HTMLButtonElement>(align: MenuAlign = "right") {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<T>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    setPos(null);
  };
  const toggle = () => (open ? close() : setOpen(true));

  // Nach dem Einhängen messen und platzieren (vor dem Paint, damit nichts springt).
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      const drop = dropRef.current;
      if (!t || !drop) return;
      const h = drop.offsetHeight;
      const w = drop.offsetWidth;
      const fitsBelow = window.innerHeight - t.bottom >= h + GAP + EDGE;
      const top = fitsBelow ? t.bottom + GAP : Math.max(EDGE, t.top - h - GAP);
      const wanted = align === "left" ? t.left : t.right - w;
      const left = Math.max(EDGE, Math.min(wanted, window.innerWidth - w - EDGE));
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true); // capture: auch bei inneren Scrollern
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align]);

  // Schließen bei Klick außerhalb (Auslöser UND Portal-Inhalt zählen als „innen“) oder Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || dropRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Vor der ersten Messung unsichtbar, damit das Menü nicht kurz oben links aufblitzt.
  const floatStyle: CSSProperties = {
    top: pos?.top ?? 0,
    left: pos?.left ?? 0,
    visibility: pos ? "visible" : "hidden",
  };

  return { open, toggle, close, triggerRef, dropRef, floatStyle };
}
