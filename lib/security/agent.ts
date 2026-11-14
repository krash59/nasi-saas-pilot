/**
 * BDD_F08_01 / DIR §7.2: agents never perform HITL approval actions.
 * Agent service identities present the `x-nasi-agent-token` header (or an `nasi_agent_` bearer).
 * Any such request to a HITL route is refused before it reaches a handler, so no record is created.
 */
export const AGENT_HEADER = "x-nasi-agent-token";

export function isAgentRequest(headers: Headers): boolean {
  if (headers.has(AGENT_HEADER)) return true;
  const auth = headers.get("authorization") ?? "";
  return /^bearer\s+nasi_agent_/i.test(auth);
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const HITL: [RegExp, string[]][] = [
  [new RegExp(`^/api/projects/${UUID}/design/summary$`, "i"), ["POST", "PUT", "DELETE"]], // confirm/approve summary, authorize/end implementation
  [new RegExp(`^/api/projects/${UUID}/dir/approve$`, "i"), ["POST"]],                     // approve DIR
  [new RegExp(`^/api/projects/${UUID}/release-authorization$`, "i"), ["POST"]],           // ACT_05A
  [/^\/api\/account\/offboard$/i, ["POST"]],                                                // account closure
];

export function isHitlRoute(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  return HITL.some(([re, methods]) => methods.includes(m) && re.test(pathname));
}
