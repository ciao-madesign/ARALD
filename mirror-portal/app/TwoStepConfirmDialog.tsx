"use client";

import { useEffect, useId, useRef, useState } from "react";

interface TwoStepConfirmDialogProps {
  title: string;
  description: string;
  /** The exact text the operator must type to enable the confirm button (case-sensitive) — shown in `description`/the label below, never guessed or fuzzy-matched. */
  confirmWord: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A dedicated two-step confirmation dialog for a destructive/irreversible action — replaces a native
 * `window.confirm()` (P1 #6 dell'audit, Fase 5 del piano UX/UI: "nessuna doppia conferma testuale").
 * Deliberately the first of its kind in `mirror-portal/` (roadmap's own "nuovo pattern, un solo posto
 * di utilizzo iniziale") but written generic — `title`/`description`/`confirmWord`/`confirmLabel` as
 * props, not hardcoded to the Fixed Relay reboot that first needs it — so a future second destructive
 * action (this repository already has several: consegna esterna, riavvio, in principle any future
 * remote command) can reuse it instead of a second bespoke dialog or a second `confirm()`.
 *
 * Confirm only unlocks once the typed text matches `confirmWord` exactly — the wireframe's own
 * "scrivi il nome del relay per confermare" requirement, meant to force reading the name rather than
 * reflexively clicking through a dialog the way a native `confirm()` invites.
 */
export function TwoStepConfirmDialog({ title, description, confirmWord, confirmLabel, onConfirm, onCancel }: TwoStepConfirmDialogProps): JSX.Element {
  const [typed, setTyped] = useState("");
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const matches = typed.length > 0 && typed === confirmWord;

  // Escape cancels from anywhere in the dialog (the same "get out without committing" affordance a
  // native confirm()'s own Esc handling gave for free), and Tab/Shift+Tab is trapped within the
  // dialog's own focusable elements — the backdrop only blocks pointer clicks on whatever is behind
  // it, never keyboard focus, so without this a Tab press could reach a button on the page underneath
  // while the dialog is still open and, unlike a mouse click, land on and activate it directly
  // (found by review). A single document-level listener for both, rather than one per concern —
  // whichever key it is, it's read before anything on the page below the dialog could react to it.
  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      // Excludes a disabled button (normally "Conferma riavvio" itself, before the typed text
      // matches) — a disabled element is never part of the browser's own native tab order, so
      // treating it as this trap's boundary left the *previous* (enabled) element free to tab
      // straight out of the dialog onto the page underneath, since the boundary check here could
      // never see it become the active element (found by review, live: with the confirm button
      // still disabled, Tab from "Annulla" landed on a control behind the backdrop instead of
      // wrapping).
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLButtonElement | HTMLInputElement>("input, button")).filter((el) => !el.disabled);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div className="confirm-dialog-backdrop" role="presentation" onClick={onCancel}>
      {/* onClick stopPropagation only (never onKeyDown) — a keydown handler here once
          stopPropagation()-ed Escape right out of reaching the document-level listener above,
          since a React SyntheticEvent's stopPropagation() also stops the underlying native event
          from bubbling any further (found by review: Escape silently did nothing). Nothing here
          needs to guard against a keyboard event reaching the backdrop, since the backdrop only
          ever acts on its own onClick. */}
      <div ref={dialogRef} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId}>{title}</h3>
        <p>{description}</p>
        <label className="confirm-dialog-field">
          Scrivi <strong>{confirmWord}</strong> per confermare
          {/* autoFocus deliberate: the whole point of this dialog is to be typed into immediately. */}
          <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
        </label>
        <div className="confirm-dialog-actions">
          <button type="button" onClick={onCancel}>
            Annulla
          </button>
          <button type="button" className="confirm-dialog-danger" disabled={!matches} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
