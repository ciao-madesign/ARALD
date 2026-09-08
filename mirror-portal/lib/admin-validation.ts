/**
 * Pure validation for everything the Admin panel (`app/admin/`) accepts from
 * an HTTP request body — kept separate from `lib/auth-db.ts` (which trusts
 * its inputs, same split as `arald-backend/node-client.ts` validating raw
 * HTTP vs. `postgres-sync.ts` trusting the already-validated shape) so each
 * rule is testable without a database or a request object.
 */

export const MAX_EMAIL_LENGTH = 320; // RFC 5321 §4.5.3.1.3
export const MAX_ORGANIZATION_NAME_LENGTH = 200;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200; // bounds the scrypt input, never a multi-MB "password" from a malformed request
export const MAX_NODE_DISPLAY_NAME_LENGTH = 200;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) return undefined;
  return EMAIL_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function validatePassword(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) return undefined;
  return value;
}

export function validateOrganizationName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ORGANIZATION_NAME_LENGTH) return undefined;
  return trimmed;
}

export function validateRole(value: unknown): "admin" | "operatore" | undefined {
  return value === "admin" || value === "operatore" ? value : undefined;
}

export function validateNonEmptyId(value: unknown, maxLength = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

/**
 * Validates a display name that was actually supplied — the field itself is
 * optional, but that's the caller's decision (check `value !== undefined &&
 * value !== null` before calling this) so this function's `undefined`
 * return always means "invalid", never "absent, and that's fine".
 */
export function validateNodeDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NODE_DISPLAY_NAME_LENGTH) return undefined;
  return trimmed;
}
