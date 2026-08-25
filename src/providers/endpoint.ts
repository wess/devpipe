/**
 * Where the control plane reaches a box daemon.
 *
 * DigitalOcean rows created before provider adapters have no explicit endpoint
 * and keep using their public hostname. Container backends publish an endpoint
 * that is meaningful only from the control-plane host.
 */
export const boxEndpoint = (box: { endpoint?: string | null; hostname: string }): string =>
  String(box.endpoint || `https://${box.hostname}`).replace(/\/$/, "")

export const boxSocketEndpoint = (box: { endpoint?: string | null; hostname: string }): string => {
  const endpoint = new URL(boxEndpoint(box))
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:"
  return endpoint.href.replace(/\/$/, "")
}
