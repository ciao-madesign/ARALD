import { LogoutButton } from "./LogoutButton";

interface PortalHeaderProps {
  userEmail: string;
  roleLabel: string;
  /** Which tab is currently open — highlights it and marks it `aria-current` for the other tab's link. */
  active: "elenco" | "mappa";
  /** Adds a third "Pannello Admin" tab, right-aligned — only Admin ARALD sessions get one (`session.user.role === "admin"`, checked by the caller, never by this component reading the session itself). */
  isAdmin?: boolean;
}

/**
 * Shared header + "Elenco"/"Mappa" tab nav for the two screens covered by the 11-13 settembre 2026
 * restyle (docs/security.md voce #75) — extracted out of app/page.tsx once app/mappa/page.tsx needed
 * the identical bar, rather than duplicating the markup a second time. Login and Admin keep their own
 * simpler headers, unchanged — this component was never designed for them (no design canvas mockup
 * covers those two screens), so out of scope here rather than force-fitting it.
 */
export function PortalHeader({ userEmail, roleLabel, active, isAdmin }: PortalHeaderProps): JSX.Element {
  return (
    <>
      <header className="top">
        <div className="top-inner">
          <div className="brand">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="1.6" aria-hidden="true">
              <circle cx="6" cy="18" r="2.4" />
              <circle cx="18" cy="18" r="2.4" />
              <circle cx="12" cy="6" r="2.4" />
              <line x1="7.9" y1="16.6" x2="10.3" y2="7.6" />
              <line x1="16.1" y1="16.6" x2="13.7" y2="7.6" />
              <line x1="8.4" y1="18" x2="15.6" y2="18" />
            </svg>
            <div className="brand-title">ARALD — Specchio Emergency Portal</div>
          </div>
          <div className="account">
            <div className="account-name">
              {userEmail}
              <span className="role-pill">{roleLabel}</span>
            </div>
            <LogoutButton />
          </div>
        </div>
      </header>
      <nav className="tabs">
        <div className="tabs-inner">
          <a href="/" className={active === "elenco" ? "tab active" : "tab"} aria-current={active === "elenco" ? "page" : undefined}>
            Elenco
          </a>
          <a href="/mappa" className={active === "mappa" ? "tab active" : "tab"} aria-current={active === "mappa" ? "page" : undefined}>
            Mappa
          </a>
          {isAdmin && (
            <a href="/admin" className="tab" style={{ marginLeft: "auto" }}>
              Pannello Admin
            </a>
          )}
        </div>
      </nav>
    </>
  );
}
