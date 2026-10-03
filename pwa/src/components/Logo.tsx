// Marken-Logo (identisch zum Manager-Dashboard): isometrischer „Lager"-Würfel
// (Gold-Deckel + zwei Weißtöne) plus Wortmarke „LagerHub". Sitzt links in der
// Navy-Topbar; Farben bewusst als Hex (Kontrast auf Navy).
export function Logo() {
  return (
    <span className="logo" aria-label="LagerHub by Andinsky">
      <svg className="logo__mark" viewBox="0 0 40 40" width="26" height="26" aria-hidden="true">
        <path d="M20 5 32.5 12.5 20 20 7.5 12.5Z" fill="#eec643" />
        <path d="M7.5 12.5 20 20 20 35 7.5 27.5Z" fill="#ffffff" fillOpacity="0.95" />
        <path d="M32.5 12.5 20 20 20 35 32.5 27.5Z" fill="#ffffff" fillOpacity="0.62" />
      </svg>
      <span className="logo__word">
        <span className="logo__name">
          Lager<span className="logo__accent">Hub</span>
        </span>
        <span className="logo__by">
          by <span className="logo__by-accent">Andinsky</span>
        </span>
      </span>
    </span>
  );
}
