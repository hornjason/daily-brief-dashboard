import { describe, it, expect } from 'bun:test'

const FIXTURE_MARKDOWN = `
## Strategic Initiatives & Trigger Events

*   **Acquisition of TrojAI (June 2026):** A10 acquired TrojAI to accelerate its enterprise AI security roadmap, adding capabilities for red teaming and runtime firewall enforcement for LLMs.
    *   **Buying Urgency: HIGH.** This creates an immediate need for development, integration, and automation platforms to absorb the new technology and scale it.
*   **Raised Full-Year 2026 Guidance (August 2026):** Following strong Q2 results, A10 raised its revenue growth outlook to 12-14% and EPS growth to 14-16%.
    *   **Buying Urgency: MEDIUM.** Indicates strong business momentum and financial health, suggesting a willingness to invest in strategic projects to sustain growth.
*   **Launch of Operational Automation Platform (October 2024):** A10 announced a strategy to automate network operations and reduce manual overhead.
    *   **Buying Urgency: LOW.** Long-term strategic direction for operational efficiency.

## Financial Health

A10 Networks demonstrates strong and improving financial health.

*   **Revenue Trajectory:** The company reported record annual revenue of $290.6 million for FY2025, an 11% increase over 2024. This momentum has accelerated into 2026, with Q2 revenue of $80.1 million (up 15.5% YoY).
*   **Profitability:** In Q2 2026, it posted a non-GAAP gross margin of 80.3% and an operating margin of 25.5%. Non-GAAP net income was $18.7 million.
*   **Balance Sheet:** The company is in a strong financial position, with $357.3 million in cash and marketable securities as of June 30, 2026.

## Strengths (Internal, Positive)

*   **Fact:** Strong financial performance with 15.5% YoY revenue growth in Q2 2026, leading to raised full-year guidance. The company maintains high non-GAAP gross margins (80.3%) and strong profitability.
*   **Confidence:** HIGH
*   **Counter-Risk:** A significant portion of growth is tied to the emerging AI security market.

*   **Fact:** A10 possesses a strong cash position, with $357.3 million in cash and marketable securities.
*   **Confidence:** HIGH
*   **Counter-Risk:** Pressure to deploy capital effectively.

## Opportunities (External, Positive — informed by PESTLE)

*   **Fact:** The enterprise push to secure production AI workloads creates a greenfield market for specialized security solutions. A10's June 2026 acquisition of TrojAI positions it to capture this demand.
*   **Confidence:** HIGH
*   **Barrier to Capture:** The AI security market is new and competitive.

*   **Fact:** Increasing complexity of hybrid and multi-cloud environments drives demand for consistent automation and application delivery across infrastructure.
*   **Confidence:** MEDIUM
*   **Barrier to Capture:** Customers often locked into cloud-native tooling.
`

describe('extractObjectiveProfile', () => {
  let extractObjectiveProfile: typeof import('../../src/modules/intelligence-module.ts').extractObjectiveProfile

  it('module exports extractObjectiveProfile', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    extractObjectiveProfile = mod.extractObjectiveProfile
    expect(typeof extractObjectiveProfile).toBe('function')
  })

  it('returns all 5 categories', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    extractObjectiveProfile = mod.extractObjectiveProfile
    const profile = extractObjectiveProfile(FIXTURE_MARKDOWN)
    expect(profile).toHaveProperty('financial')
    expect(profile).toHaveProperty('security')
    expect(profile).toHaveProperty('operational')
    expect(profile).toHaveProperty('innovation')
    expect(profile).toHaveProperty('growth')
    expect(Array.isArray(profile.financial)).toBe(true)
    expect(Array.isArray(profile.security)).toBe(true)
    expect(Array.isArray(profile.operational)).toBe(true)
    expect(Array.isArray(profile.innovation)).toBe(true)
    expect(Array.isArray(profile.growth)).toBe(true)
  })

  it('extracts financial entries from Financial Health section', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    expect(profile.financial.length).toBeGreaterThanOrEqual(3)
    const revenueEntry = profile.financial.find(e => e.objective.includes('revenue'))
    expect(revenueEntry).toBeDefined()
    expect(revenueEntry!.metric).toBeTruthy()
    expect(revenueEntry!.source).toBe('Financial Health')
  })

  it('extracts metrics from financial entries', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    const margins = profile.financial.find(e => e.objective.toLowerCase().includes('margin'))
    expect(margins).toBeDefined()
    expect(margins!.metric).toMatch(/\d+/)
  })

  it('classifies security initiatives correctly', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    const securityEntries = profile.security
    expect(securityEntries.length).toBeGreaterThanOrEqual(1)
    const trojAi = securityEntries.find(e => e.objective.toLowerCase().includes('security'))
    expect(trojAi).toBeDefined()
  })

  it('extracts priority from Buying Urgency tags', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    const allEntries = [
      ...profile.financial,
      ...profile.security,
      ...profile.operational,
      ...profile.innovation,
      ...profile.growth,
    ]
    const highPriority = allEntries.filter(e => e.priority === 'HIGH')
    expect(highPriority.length).toBeGreaterThanOrEqual(1)
    const medPriority = allEntries.filter(e => e.priority === 'MED')
    expect(medPriority.length).toBeGreaterThanOrEqual(1)
  })

  it('classifies operational initiatives correctly', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    expect(profile.operational.length).toBeGreaterThanOrEqual(1)
    const opEntry = profile.operational.find(e =>
      e.objective.toLowerCase().includes('automat') || e.objective.toLowerCase().includes('operational')
    )
    expect(opEntry).toBeDefined()
  })

  it('classifies growth initiatives from revenue/growth keywords', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    expect(profile.growth.length).toBeGreaterThanOrEqual(1)
  })

  it('extracts confidence from Strengths/Opportunities facts', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    const allEntries = [
      ...profile.financial,
      ...profile.security,
      ...profile.operational,
      ...profile.innovation,
      ...profile.growth,
    ]
    const withConfidence = allEntries.filter(e => e.confidence === 'HIGH' || e.confidence === 'MEDIUM')
    expect(withConfidence.length).toBeGreaterThanOrEqual(2)
  })

  it('returns empty arrays on empty input', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile('')
    expect(profile.financial).toEqual([])
    expect(profile.security).toEqual([])
    expect(profile.operational).toEqual([])
    expect(profile.innovation).toEqual([])
    expect(profile.growth).toEqual([])
  })

  it('caps objective text at 200 characters', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    const allEntries = [
      ...profile.financial,
      ...profile.security,
      ...profile.operational,
      ...profile.innovation,
      ...profile.growth,
    ]
    for (const entry of allEntries) {
      expect(entry.objective.length).toBeLessThanOrEqual(200)
    }
  })

  it('ObjectiveEntry has required shape', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    const allEntries = [
      ...profile.financial,
      ...profile.security,
      ...profile.operational,
      ...profile.innovation,
      ...profile.growth,
    ]
    for (const entry of allEntries) {
      expect(typeof entry.objective).toBe('string')
      expect(entry.metric === null || typeof entry.metric === 'string').toBe(true)
      expect([null, 'HIGH', 'MED', 'LOW']).toContain(entry.priority)
      expect(typeof entry.source).toBe('string')
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(entry.confidence)
    }
  })
})
