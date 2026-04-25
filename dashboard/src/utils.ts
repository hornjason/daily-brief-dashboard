/** Returns the VNC URL for the current environment based on app host and port. */
export function getVncUrl(opts?: { reconnect?: boolean }): string {
  const host = window.location.hostname
  const port = window.location.port
  const vncPort = port === '7776' ? 6083 : port === '7778' ? 6081 : 6080
  if (opts?.reconnect) {
    return `http://${host}:${vncPort}/vnc.html?autoconnect=true&reconnect=true`
  }
  return `http://${host}:${vncPort}/vnc.html?autoconnect=1&resize=scale`
}
