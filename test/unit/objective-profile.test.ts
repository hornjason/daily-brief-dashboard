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

*   **Revenue Trajectory:** The company reported record annual revenue of $290.6 million for FY2025, an 11% increase over 2024. This momentum has accelerated into 2026, with Q2 revenue of $80.1 million (up 15.5% YoY) and H1 2026 revenue up 14.5%. Based on this performance, A10 raised its full-year 2026 revenue growth guidance from 10-12% to 12-14%.
*   **Profitability:** In Q2 2026, it posted a non-GAAP gross margin of 80.3% and an operating margin of 25.5%. Non-GAAP net income was $18.7 million.
*   **Balance Sheet:** The company is in a strong financial position, with $357.3 million in cash and marketable securities as of June 30, 2026.

## RHEL Fit

*   **Business Need:** A10 needs a stable, secure, and high-performance operating system for both its internal product development and as a foundation for the virtual appliances it deploys to customers.
*   **Capability Requirement:** A standardized, enterprise-grade Linux platform with long-term support, robust security features (like SELinux), and real-time kernel options for low-latency networking.
*   **Red Hat Fit:** Red Hat Enterprise Linux (RHEL) provides the hardened, performant, and certifiable OS foundation required for a security and networking vendor. It would allow A10 to standardize the development environment.

## OpenShift Fit

*   **Business Need:** The acquisition of TrojAI and the strategic pivot to AI security creates an urgent need to build, test, and scale container-native applications. A10 is building a unified "A10 Control" platform.
*   **Capability Requirement:** An enterprise-grade, hybrid-cloud Kubernetes platform to accelerate application development.
*   **Red Hat Fit:** OpenShift provides the ideal platform for this challenge. It would enable A10's developers to build and deploy the TrojAI microservices at scale.

## Ansible Fit

*   **Business Need:** A10's strategy revolves around simplifying complexity for its customers through a "unified set of tools." Internally, they face the challenge of integrating TrojAI.
*   **Capability Requirement:** A powerful automation platform that can manage network devices, cloud services, and Kubernetes platforms from a single control plane.
*   **Red Hat Fit:** Ansible Automation Platform is a perfect fit. It can be used to automate the configuration and deployment of A10's own Thunder appliances.

## Red Hat AI Fit

*   **Business Need:** A10 is now in the business of building AI security models, including "proprietary guardrail models and model intelligence." They need to train, test, and deploy these models efficiently.
*   **Capability Requirement:** A platform for developing, training, and serving AI/ML models with integrated MLOps capabilities.
*   **Red Hat Fit:** Red Hat OpenShift AI provides a comprehensive, scalable platform for A10's data scientists and engineers. They could use it to manage the entire lifecycle of the AI models.

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

  it('extracts >= 5 discrete financial metrics from Financial Health (not paragraphs)', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    const fhEntries = profile.financial.filter(e => e.source === 'Financial Health')
    expect(fhEntries.length).toBeGreaterThanOrEqual(5)
    for (const entry of fhEntries) {
      expect(entry.objective.length).toBeLessThan(60)
      expect(entry.metric).toBeTruthy()
    }
  })

  it('extracts specific metrics: revenue, growth %, margins, cash', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    const objectives = profile.financial.map(e => e.objective.toLowerCase())
    const metrics = profile.financial.map(e => e.metric)

    expect(metrics.some(m => m?.includes('$290.6'))).toBe(true)
    expect(metrics.some(m => m?.includes('11%'))).toBe(true)
    expect(objectives.some(o => o.includes('margin'))).toBe(true)
    expect(metrics.some(m => m?.includes('$357.3'))).toBe(true)
  })

  it('strategic initiatives are clean titles < 80 chars', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    const allEntries = [
      ...profile.financial,
      ...profile.security,
      ...profile.operational,
      ...profile.innovation,
      ...profile.growth,
    ]
    const initiativeEntries = allEntries.filter(e => e.source === 'Strategic Initiatives')
    expect(initiativeEntries.length).toBeGreaterThanOrEqual(1)
    for (const entry of initiativeEntries) {
      expect(entry.objective.length).toBeLessThanOrEqual(80)
    }
  })

  it('classifies security initiatives correctly', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    expect(profile.security.length).toBeGreaterThanOrEqual(1)
    const trojAi = profile.security.find(e => e.objective.toLowerCase().includes('security'))
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
    expect(profile.productFit).toBeUndefined()
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

  it('extracts productFit for RHEL, OpenShift, Ansible, Red Hat AI', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    expect(profile.productFit).toBeDefined()
    expect(profile.productFit!.length).toBe(4)
    const products = profile.productFit!.map(f => f.product)
    expect(products).toContain('RHEL')
    expect(products).toContain('OpenShift')
    expect(products).toContain('Ansible')
    expect(products).toContain('Red Hat AI')
    for (const fit of profile.productFit!) {
      expect(fit.businessNeed.length).toBeGreaterThan(10)
      expect(fit.redHatFit.length).toBeGreaterThan(10)
      expect(fit.businessNeed).not.toContain('\n')
      expect(fit.redHatFit).not.toContain('\n')
    }
  })

  it('productFit extracts first sentence only', async () => {
    const mod = await import('../../src/modules/intelligence-module.ts')
    const profile = mod.extractObjectiveProfile(FIXTURE_MARKDOWN)
    for (const fit of profile.productFit!) {
      const sentenceCount = fit.businessNeed.split('. ').length
      expect(sentenceCount).toBeLessThanOrEqual(2)
    }
  })
})
