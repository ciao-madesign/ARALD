import { describe, expect, it } from "vitest";
import { generateAutostartCommand, SCHEDULED_TASK_NAME } from "../../packaging/autostart-windows.js";

describe("generateAutostartCommand", () => {
  it("produces a well-formed schtasks /create command", () => {
    const command = generateAutostartCommand({ execPath: "C:\\Program Files\\ARALD\\arald-portable.exe", args: ["--id", "MyNode", "--portable"] });
    expect(command).toContain(`schtasks /create /tn "${SCHEDULED_TASK_NAME}"`);
    expect(command).toContain("/sc onlogon");
    expect(command).toContain("arald-portable.exe\\\" --id MyNode --portable");
  });

  it("escapes an inner double quote so the whole /tr value stays a single well-formed string", () => {
    const command = generateAutostartCommand({ execPath: "C:\\ARALD\\arald-portable.exe", args: ["--id", 'My "Node"'] });
    expect(command).toContain('\\"My \\"Node\\"\\"');
  });
});
