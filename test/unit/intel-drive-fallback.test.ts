/**
 * BKL-INTEL-DRIVE-FOLDER regression test
 *
 * Verifies that when findCustomerDriveFolder throws (no matching Drive folder),
 * the intelligence pipeline:
 *   1. Completes with status 'complete_no_drive_folder' (not 'error')
 *   2. Caches the generated content locally (company + industry markdown)
 *   3. Does NOT discard the generated content
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// We test the pipeline in isolation by mocking the Gemini + Drive calls.
// Import after mocks are set up so module-level state is clean.

describe('BKL-INTEL-DRIVE-FOLDER: intelligence pipeline Drive folder miss', () => {
  let tmpDir: string
  let cacheDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `intel-drive-test-${Date.now()}`)
    cacheDir = join(tmpDir, 'cache')
    mkdirSync(cacheDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('sets status to complete_no_drive_folder when findCustomerDriveFolder throws', async () => {
    // Dynamically import so we can mock dependencies before module evaluation
    // is fully cached. We use module-level mock injection via the exported
    // function surface rather than trying to intercept ES module imports.

    const intel = await import('../../src/account-intelligence.ts')

    // Initialize persistence so setJob can write to disk
    intel.initJobPersistence(cacheDir)

    // Build a minimal customer object (no driveFolderId — triggers Drive lookup)
    const customer = {
      name: 'Musarubra Us',
      ae: 'Test AE',
      driveFolderId: undefined,
    } as any

    // Stub identifyIndustry, generateCompanyIntelligence, generateIndustryAnalysis
    // by spying on the exported functions. Since runIntelligencePipeline calls these
    // from within the same module, we need to mock them at the module boundary.
    // The practical approach: mock writeIntelligenceDocs to throw (the real call
    // in the pipeline wraps this in a try/catch) and verify the job status.

    // Use spyOn to replace writeIntelligenceDocs on the module export
    const writeDocsSpy = spyOn(intel, 'writeIntelligenceDocs').mockRejectedValue(
      new Error('No Drive folder found for customer Musarubra Us — no per-customer or AE folder ID')
    )

    // Also mock the Gemini-calling functions to return minimal content without
    // making real network calls
    const identifySpy = spyOn(intel, 'identifyIndustry').mockResolvedValue({
      industry: 'Cybersecurity',
      segment: 'Endpoint Security',
      description: 'A test company',
      competitors: ['CrowdStrike', 'Palo Alto Networks', 'SentinelOne'],
    })
    const companySpy = spyOn(intel, 'generateCompanyIntelligence').mockResolvedValue(
      '## Company Intelligence\nTest company brief content for Musarubra Us.'
    )
    const industrySpy = spyOn(intel, 'generateIndustryAnalysis').mockResolvedValue(
      '## Industry Analysis\nTest industry analysis for Cybersecurity.'
    )
    // cacheIndustryResult writes to customers.json — mock it so we don't need
    // the real file system state for customers.json
    const cacheIndustrySpy = spyOn(intel, 'cacheIndustryResult').mockImplementation(() => {})

    // Add customer to the in-memory customer list via the server-state mock
    // runIntelligencePipeline reads from the 'customers' export of server-state.
    // Since we can't easily swap that, we'll add via a customers array mock.
    // The cleanest approach: mock the entire module's customer lookup by
    // patching server-state. However that requires mocking across modules.
    //
    // Instead, verify behavior indirectly: if identifyIndustry is called and
    // writeIntelligenceDocs throws, the job must end as complete_no_drive_folder.
    // We trigger this by verifying the spy chain works end-to-end.

    // The customer lookup from server-state.customers will fail if not set up.
    // We patch the server-state module's customers array:
    const serverState = await import('../../src/server-state.ts')
    const origCustomers = [...serverState.customers]
    serverState.customers.push(customer)

    try {
      const jobId = await intel.runIntelligencePipeline('Musarubra Us', true)
      expect(jobId).toBe('Musarubra Us')

      // Pipeline is async — wait for it to complete
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          const status = intel.getJobStatus('Musarubra Us')
          if (status?.status !== 'running' && status?.status !== 'pending') {
            clearInterval(poll)
            resolve()
          }
        }, 50)
        // Safety timeout
        setTimeout(() => { clearInterval(poll); resolve() }, 5_000)
      })

      const finalStatus = intel.getJobStatus('Musarubra Us')
      expect(finalStatus).not.toBeNull()
      expect(finalStatus!.status).toBe('complete_no_drive_folder')
      // Content should NOT be discarded — local cache file should exist
      expect(writeDocsSpy).toHaveBeenCalledTimes(1)
      expect(identifySpy).toHaveBeenCalledTimes(1)
    } finally {
      // Restore customers array
      serverState.customers.length = 0
      serverState.customers.push(...origCustomers)
      writeDocsSpy.mockRestore()
      identifySpy.mockRestore()
      companySpy.mockRestore()
      industrySpy.mockRestore()
      cacheIndustrySpy.mockRestore()
    }
  })

  it('caches intelligence content locally when Drive folder is missing', async () => {
    const intel = await import('../../src/account-intelligence.ts')
    intel.initJobPersistence(cacheDir)

    const customer = {
      name: 'Trellix Test Corp',
      ae: 'Test AE',
      driveFolderId: undefined,
    } as any

    const writeDocsSpy = spyOn(intel, 'writeIntelligenceDocs').mockRejectedValue(
      new Error('No Drive folder found for customer Trellix Test Corp')
    )
    spyOn(intel, 'identifyIndustry').mockResolvedValue({
      industry: 'Cybersecurity',
      segment: 'Threat Intelligence',
      description: 'Threat intelligence company',
      competitors: ['CrowdStrike'],
    })
    spyOn(intel, 'generateCompanyIntelligence').mockResolvedValue(
      '## Company Intelligence\nTrellix company brief.'
    )
    spyOn(intel, 'generateIndustryAnalysis').mockResolvedValue(
      '## Industry Analysis\nCybersecurity landscape.'
    )
    spyOn(intel, 'cacheIndustryResult').mockImplementation(() => {})

    const serverState = await import('../../src/server-state.ts')
    const origCustomers = [...serverState.customers]
    serverState.customers.push(customer)

    try {
      await intel.runIntelligencePipeline('Trellix Test Corp', true)

      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          const status = intel.getJobStatus('Trellix Test Corp')
          if (status?.status !== 'running' && status?.status !== 'pending') {
            clearInterval(poll)
            resolve()
          }
        }, 50)
        setTimeout(() => { clearInterval(poll); resolve() }, 5_000)
      })

      const finalStatus = intel.getJobStatus('Trellix Test Corp')
      expect(finalStatus!.status).toBe('complete_no_drive_folder')

      // Local cache file should exist and contain generated content
      const slug = 'trellix-test-corp'
      const cachePath = join(cacheDir, 'intelligence', `${slug}.json`)
      expect(existsSync(cachePath)).toBe(true)

      const cached = JSON.parse(readFileSync(cachePath, 'utf-8'))
      expect(cached.company).toContain('Trellix company brief')
      expect(cached.industry).toContain('Cybersecurity landscape')
      // No Drive URLs (folder was missing)
      expect(cached.companyDocUrl).toBeUndefined()
      expect(cached.industryDocUrl).toBeUndefined()
    } finally {
      serverState.customers.length = 0
      serverState.customers.push(...origCustomers)
      writeDocsSpy.mockRestore()
    }
  })
})
