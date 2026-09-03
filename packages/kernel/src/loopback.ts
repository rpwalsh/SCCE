/** Loopback host check shared by every surface that validates a local endpoint (Ollama host, server URL). */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.every(value => value >= 0 && value <= 255) && octets[0] === 127;
}
