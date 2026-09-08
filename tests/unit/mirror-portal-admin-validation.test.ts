import { describe, expect, it } from "vitest";
import {
  MAX_EMAIL_LENGTH,
  MAX_ORGANIZATION_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  validateNodeDisplayName,
  validateNonEmptyId,
  validateOrganizationName,
  validatePassword,
  validateRole,
} from "../../mirror-portal/lib/admin-validation.js";

describe("mirror-portal/lib/admin-validation", () => {
  describe("normalizeEmail", () => {
    it("trims and lowercases a valid email", () => {
      expect(normalizeEmail("  Operatore@Rifugio.Example  ")).toBe("operatore@rifugio.example");
    });
    it("rejects a non-string, an empty string, a string without @, or one over the RFC length", () => {
      expect(normalizeEmail(42)).toBeUndefined();
      expect(normalizeEmail("")).toBeUndefined();
      expect(normalizeEmail("not-an-email")).toBeUndefined();
      expect(normalizeEmail("a".repeat(MAX_EMAIL_LENGTH) + "@x.com")).toBeUndefined();
    });
  });

  describe("validatePassword", () => {
    it("accepts a password within [MIN, MAX] length", () => {
      expect(validatePassword("a".repeat(MIN_PASSWORD_LENGTH))).toBe("a".repeat(MIN_PASSWORD_LENGTH));
    });
    it("rejects too short, too long, or non-string", () => {
      expect(validatePassword("short")).toBeUndefined();
      expect(validatePassword("a".repeat(MAX_PASSWORD_LENGTH + 1))).toBeUndefined();
      expect(validatePassword(12345)).toBeUndefined();
    });
  });

  describe("validateOrganizationName", () => {
    it("trims a valid name", () => {
      expect(validateOrganizationName("  CNSAS Piemonte  ")).toBe("CNSAS Piemonte");
    });
    it("rejects empty, whitespace-only, too long, or non-string", () => {
      expect(validateOrganizationName("")).toBeUndefined();
      expect(validateOrganizationName("   ")).toBeUndefined();
      expect(validateOrganizationName("a".repeat(MAX_ORGANIZATION_NAME_LENGTH + 1))).toBeUndefined();
      expect(validateOrganizationName(null)).toBeUndefined();
    });
  });

  describe("validateRole", () => {
    it("accepts exactly 'admin' or 'operatore'", () => {
      expect(validateRole("admin")).toBe("admin");
      expect(validateRole("operatore")).toBe("operatore");
    });
    it("rejects anything else, including a role-like but wrong string", () => {
      expect(validateRole("Admin")).toBeUndefined();
      expect(validateRole("superadmin")).toBeUndefined();
      expect(validateRole(undefined)).toBeUndefined();
    });
  });

  describe("validateNonEmptyId", () => {
    it("trims a valid id", () => {
      expect(validateNonEmptyId("  org-1  ")).toBe("org-1");
    });
    it("rejects empty, whitespace-only, over the max length, or non-string", () => {
      expect(validateNonEmptyId("")).toBeUndefined();
      expect(validateNonEmptyId("   ")).toBeUndefined();
      expect(validateNonEmptyId("x".repeat(201))).toBeUndefined();
      expect(validateNonEmptyId(7)).toBeUndefined();
    });
  });

  describe("validateNodeDisplayName", () => {
    it("trims a valid name", () => {
      expect(validateNodeDisplayName("  Rifugio Manuale  ")).toBe("Rifugio Manuale");
    });
    it("rejects empty, whitespace-only, or non-string — including undefined/null, since callers decide absence separately", () => {
      expect(validateNodeDisplayName("")).toBeUndefined();
      expect(validateNodeDisplayName("   ")).toBeUndefined();
      expect(validateNodeDisplayName(undefined)).toBeUndefined();
      expect(validateNodeDisplayName(null)).toBeUndefined();
    });
  });
});
