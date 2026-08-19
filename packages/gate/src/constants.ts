/** Where pf delivers loopback 443 traffic. */
export const GATE_HTTPS_PORT = 42_443;
/** Where pf delivers loopback 80 traffic; answers with a redirect to https. */
export const GATE_HTTP_PORT = 42_080;

/** The gate's own reserved hostname, used by health checks and the doctor. */
export const GATE_HOST = "silvic-gate.localhost";

export const LAUNCH_AGENT_LABEL = "dev.silvic.gate";
/** How a gate process is recognised in `ps` output, orphans included. */
export const GATE_SCRIPT_NAME = "gate.mjs";
export const PF_DAEMON_LABEL = "dev.silvic.gate.pf";
/**
 * macOS's stock /etc/pf.conf evaluates `rdr-anchor "com.apple/*"`, so an
 * anchor filed under that namespace needs no edit to the main ruleset. Pow
 * and puma-dev shipped on the same mechanism.
 */
export const PF_ANCHOR = "com.apple/250.SilvicGate";
export const PF_ANCHOR_FILE = "/etc/pf.anchors/dev.silvic.gate";

export const CA_COMMON_NAME = "Silvic Gate CA";
