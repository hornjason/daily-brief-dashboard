// dashboard/src/hooks/useVncLogin.ts
//
// Reusable VNC login popup manager. Encapsulates the synchronous window.open
// call (must be inside the click handler before any await to avoid popup
// blockers), polls a status endpoint to detect login completion, and detects
// user-closed windows via window.closed.
//
// Used by RH Portal, Salesforce, and Tableau connect handlers to ensure
// consistent popup behavior (popup window features instead of '_blank' tab).
import { useRef, useCallback, useEffect } from 'react'

interface UseVncLoginOptions {
  /** Poll this endpoint every 2s to check if login completed */
  statusEndpoint: string
  /** Called with true if login succeeded, false if window closed without login */
  onClose: (sessionDetected: boolean) => void
  /** Max wait ms before auto-canceling (default 120s) */
  timeoutMs?: number
}

interface UseVncLoginReturn {
  vncRef: React.MutableRefObject<Window | null>
  openVnc: (url: string, name: string) => void
  isOpen: boolean
  cancel: () => void
}

export function useVncLogin({ statusEndpoint, onClose, timeoutMs = 120_000 }: UseVncLoginOptions): UseVncLoginReturn {
  const vncRef = useRef<Window | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closedRef = useRef(false)

  const cleanup = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null }
    closedRef.current = false
  }, [])

  const cancel = useCallback(() => {
    vncRef.current?.close()
    vncRef.current = null
    cleanup()
    onClose(false)
  }, [cleanup, onClose])

  const openVnc = useCallback((url: string, name: string) => {
    // MUST be synchronous — called inside click handler before any await
    vncRef.current = window.open(url, name, 'width=1280,height=900')
    closedRef.current = false

    pollRef.current = setInterval(async () => {
      // window.closed detection — if user closed the popup
      if (vncRef.current?.closed) {
        cleanup()
        const res = await fetch(statusEndpoint).then(r => r.json()).catch(() => null)
        const sessionActive = res?.hasSession === true || res?.sessionValid === true
        vncRef.current = null
        onClose(sessionActive)
        return
      }
      // Check session status
      try {
        const res = await fetch(statusEndpoint).then(r => r.json())
        const sessionActive = res?.hasSession === true || res?.sessionValid === true
        if (sessionActive && !res?.loginInProgress) {
          vncRef.current?.close()
          vncRef.current = null
          cleanup()
          onClose(true)
        }
      } catch { /* network error, keep polling */ }
    }, 2_000)

    timeoutRef.current = setTimeout(() => {
      vncRef.current?.close()
      vncRef.current = null
      cleanup()
      onClose(false)
    }, timeoutMs)
  }, [statusEndpoint, onClose, cleanup, timeoutMs])

  useEffect(() => () => cleanup(), [cleanup])

  return {
    vncRef,
    openVnc,
    isOpen: vncRef.current !== null && !vncRef.current?.closed,
    cancel,
  }
}
