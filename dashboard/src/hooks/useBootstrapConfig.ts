import { useCallback, useEffect, useState } from 'react'

/**
 * Shared bootstrap form state for the Setup page.
 *
 * BKL-ARCH-01: Region-aware. On mount, fetches the region list from
 * `/api/settings/regions` and the POD config for the first region from
 * `/api/settings/pod-config?region=<id>`. Switching regions re-fetches the
 * POD config. POD labels come from settings.json via the API — no hardcoded
 * label mapping in frontend code.
 */
export interface RegionSummary {
  id: string
  label: string
  type: string
}

export interface UseBootstrapConfigResult {
  /** Currently selected POD key (e.g. "WEST_COMM_CORP_NORTHWEST"). */
  selectedPod: string
  /** Update the selected POD. `sfReportId` auto-fills from the map. */
  setSelectedPod: (pod: string) => void
  /** Auto-filled Salesforce report ID for the selected POD (read-only to the UI). */
  sfReportId: string
  /** POD → SF report ID map for the active region. */
  podSfReportMap: Record<string, string>
  /** POD → label map for the active region (driven by settings.json). */
  podLabels: Record<string, string>
  /** Territory sheet URL for the active region. */
  territorySheetUrl: string
  /** Bare sheet ID extracted from territorySheetUrl, or empty string if not available. */
  territorySheetId: string
  /** Parent Drive folder ID for SF bookings sheets, or empty string if not configured. */
  podBookingsFolderId: string
  /** Update the local podBookingsFolderId state — e.g. after the user validates
   *  and persists a corrected folder via POST /api/sf-bookings/pod-folder. */
  setPodBookingsFolderId: (folderId: string) => void
  /** Derived POD options from podSfReportMap keys, with labels from `podLabels`. */
  podOptions: ReadonlyArray<{ value: string; label: string }>
  /** Available regions, loaded from `/api/settings/regions`. */
  regions: ReadonlyArray<RegionSummary>
  /** Currently selected region id. */
  selectedRegion: string
  /** Update the selected region. POD config will re-fetch. */
  setSelectedRegion: (region: string) => void
  /** True while the initial map fetch is in-flight. */
  loading: boolean
  /** Fetch error message, if the map failed to load. */
  error: string | null
}

interface PodConfigResponse {
  podBookingsFolderId: string | null
  podSfReports: Record<string, string>
  podLabels?: Record<string, string>
  territorySheetUrl: string | null
}

interface RegionsResponse {
  regions: RegionSummary[]
}

export function useBootstrapConfig(): UseBootstrapConfigResult {
  const [selectedPod, setSelectedPodState] = useState<string>('')
  const [podSfReportMap, setPodSfReportMap] = useState<Record<string, string>>({})
  const [podLabels, setPodLabels] = useState<Record<string, string>>({})
  const [territorySheetUrl, setTerritorySheetUrl] = useState<string>('')
  const [podBookingsFolderId, setPodBookingsFolderId] = useState<string>('')
  const [regions, setRegions] = useState<RegionSummary[]>([])
  const [selectedRegion, setSelectedRegionState] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  // Fetch region list once on mount
  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    fetch('/api/settings/regions', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`regions: ${res.status}`)
        const json = (await res.json()) as RegionsResponse
        if (cancelled) return
        const list = Array.isArray(json.regions) ? json.regions : []
        setRegions(list)
        if (list.length > 0 && !selectedRegion) {
          setSelectedRegionState(list[0].id)
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof Error && e.name === 'AbortError') return
        // Don't fail loud — fall back to default region behavior
        // eslint-disable-next-line no-console
        console.warn('useBootstrapConfig: regions fetch failed', e)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fetch POD config whenever the selected region changes (or on mount with empty selection)
  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setLoading(true)
    setError(null)
    const url = selectedRegion
      ? `/api/settings/pod-config?region=${encodeURIComponent(selectedRegion)}`
      : '/api/settings/pod-config'
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`pod-config: ${res.status}`)
        const json = (await res.json()) as PodConfigResponse
        if (cancelled) return
        setPodSfReportMap(json.podSfReports ?? {})
        setPodLabels(json.podLabels ?? {})
        setTerritorySheetUrl(json.territorySheetUrl ?? '')
        setPodBookingsFolderId(json.podBookingsFolderId ?? '')
        // Reset POD selection when region changes — old POD won't exist in new region
        setSelectedPodState('')
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof Error && e.name === 'AbortError') return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [selectedRegion])

  const setSelectedPod = useCallback((pod: string) => {
    setSelectedPodState(pod)
  }, [])

  const setSelectedRegion = useCallback((region: string) => {
    setSelectedRegionState(region)
  }, [])

  const sfReportId = selectedPod ? (podSfReportMap[selectedPod] ?? '') : ''

  // Extract bare sheet ID from territorySheetUrl
  const territorySheetId = (() => {
    const match = territorySheetUrl.match(/spreadsheets\/d\/([^/]+)/)
    return match ? match[1] : ''
  })()

  // Derive sorted POD options from the map keys, using server-supplied labels
  const podOptions: ReadonlyArray<{ value: string; label: string }> = Object.keys(podSfReportMap)
    .sort()
    .map(key => ({
      value: key,
      label: podLabels[key] ?? key,
    }))

  return {
    selectedPod,
    setSelectedPod,
    sfReportId,
    podSfReportMap,
    podLabels,
    territorySheetUrl,
    territorySheetId,
    podBookingsFolderId,
    setPodBookingsFolderId,
    podOptions,
    regions,
    selectedRegion,
    setSelectedRegion,
    loading,
    error,
  }
}
