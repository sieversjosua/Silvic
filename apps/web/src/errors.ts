/**
 * Electron wraps anything thrown inside an IPC handler with the channel it
 * travelled on, so a refused branch name arrives as "Error invoking remote
 * method 'silvic:environment:create': Error: Branch x already exists". Nobody
 * asked to invoke a remote method; they asked for a plot. The sentence Silvic
 * wrote is the only part worth showing.
 */
export function failureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    raw
      .replace(/^Error invoking remote method '[^']*':\s*/, "")
      // Whatever the wrapper leaves behind still names its own class first.
      .replace(/^[A-Za-z]*Error:\s*/, "")
      .trim() || "Something went wrong, and said nothing about what."
  );
}

/**
 * Failures the branch field caused and can fix. They belong against the input
 * rather than in a banner at the far end of the dialog.
 */
export function concernsBranch(message: string): boolean {
  return /branch/i.test(message);
}
