// Wiederverwendbares Kebab-Menü (⋯) für seltenere Zeilen-Aktionen.
// Öffnet ein Dropdown und schließt bei Klick außerhalb oder Escape.
// children ist eine Render-Funktion, die `close` erhält (zum Schließen nach Klick).
//
// Das Dropdown hängt per Portal am <body> und wird von `useFloatingMenu` platziert –
// in der Tabellenzelle würde es sonst vom `overflow: hidden` der Tabelle geklippt.
import { type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFloatingMenu } from "./useFloatingMenu";

export function KebabMenu({ children }: { children: (close: () => void) => ReactNode }) {
  const { open, toggle, close, triggerRef, dropRef, floatStyle } = useFloatingMenu("right");

  return (
    <div className="menu">
      <button
        ref={triggerRef}
        className="btn menu__trigger"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Weitere Aktionen"
      >
        ⋯
      </button>
      {open &&
        createPortal(
          <div ref={dropRef} className="menu__dropdown menu__dropdown--float" role="menu" style={floatStyle}>
            {children(close)}
          </div>,
          document.body,
        )}
    </div>
  );
}
