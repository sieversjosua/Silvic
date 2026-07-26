import type { HarnessDefinition } from "@silvic/contracts";

export const harnesses = [
  {
    id: "codex",
    name: "Codex",
    kind: "application",
    applicationName: "Codex",
  },
  {
    id: "claude",
    name: "Claude Code",
    kind: "command",
    executable: "claude",
  },
  {
    id: "t3-code",
    name: "T3 Code",
    kind: "application",
    applicationNames: ["T3 Code (Nightly)", "T3 Code (Alpha)", "T3 Code"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    kind: "command",
    executable: "opencode",
  },
  {
    id: "vscode",
    name: "VS Code",
    kind: "application",
    applicationNames: ["Visual Studio Code", "Visual Studio Code - Insiders"],
  },
  {
    id: "terminal",
    name: "Terminal",
    kind: "system",
    applicationName: "Terminal",
  },
  {
    id: "finder",
    name: "Finder",
    kind: "system",
  },
] as const satisfies readonly HarnessDefinition[];

export function harnessById(id: HarnessDefinition["id"]): HarnessDefinition {
  const harness = harnesses.find((candidate) => candidate.id === id);
  if (!harness) throw new Error(`Unknown harness: ${id}`);
  return harness;
}
