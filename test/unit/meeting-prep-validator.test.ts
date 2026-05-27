/**
 * Unit tests for meeting-prep-validator.ts
 *
 * Tests against a gold standard fixture (must pass) and a minimal fixture (must fail).
 * Updated for 7-section slim format (#426).
 */

import { describe, it, expect } from 'bun:test'
import { meetingPrepValidator } from '../../src/quality-validators/meeting-prep-validator.ts'

// ── Gold standard fixture — 7-section slim format (should PASS) ──────────────

const GOLD_STANDARD = `
### 1. Meeting Objective
This meeting with Taylor Fresh Foods focuses on reviewing their OpenShift adoption timeline, aligning on the Q3 renewal strategy, and establishing next steps for the Ansible expansion initiative. Maria Chen requested this follow-up after Summit to discuss containerization of their core ERP modules.

### 2. Who's in the Room
| Name | Title | Key Insight |
|---|---|---|
| Maria Chen | CTO | New hire from Kroger — brings container expertise, attended Summit 2025 |
| David Park | VP Infrastructure | Owns RHEL estate (2,400 nodes), cautious on container timeline |
| Sarah Kim | Director of DevOps | Championing AAP expansion from 50 to 200 nodes |
| Tom Richards | CFO | Approved Q3 infrastructure budget — needs ROI framing |

### 3. Recent Interactions
- **May 15 meeting (carry-forward):** David committed to RHEL 9 migration POC by June 30 — OUTSTANDING, follow up on status
- **Summit 2025 (May 5-8):** Maria and Sarah attended OpenShift sessions; Maria expressed interest in MicroShift for plant edge
- **April playbook review:** Identified 3 expansion opportunities (AAP scale-up, ACS adoption, MicroShift pilot)
- **March support escalation:** SR-2024-01203 (AAP inventory sync) resolved April 2 — David confirmed fix

### 4. Value Play
Taylor Fresh Foods is investing $12M in digital transformation through 2027, with containerization as the centerpiece. Their 2,400-node RHEL estate and 50-node Ansible deployment position them for a platform play: OpenShift Platform Plus gives Maria's team a unified control plane across their 3 data centers while Ansible Lightspeed accelerates Sarah's compliance automation — cutting audit prep from 6 weeks to 2 weeks based on Forrester TEI data from similar food production deployments. The teaching point for this meeting: companies that adopt platform-first (OpenShift + AAP together) see 40% faster time-to-production than those who containerize first and automate later.

### 5. Discussion Questions
- **Maria Chen (CTO):** What is your timeline for containerizing the core ERP modules, and have you evaluated the resource requirements? PURPOSE: Scope OpenShift deployment — her Summit interest suggests Q4 target, align with RHEL 9 migration
- **Maria Chen (CTO):** How are you approaching security scanning in your CI/CD pipeline today? PURPOSE: Position ACS — their 3 data centers need consistent policy, $45K ACV opportunity
- **David Park (VP Infra):** Status update on the RHEL 9 migration POC committed May 15 — are you on track for June 30? PURPOSE: Hold accountability on commitment, identify blockers, connect to RHEL Premium renewal ($320K, due Aug 2026)
- **David Park (VP Infra):** Are you evaluating edge computing platforms for the plant floor quality monitoring? PURPOSE: Introduce MicroShift — Maria's Summit interest creates executive air cover
- **Sarah Kim (Dir DevOps):** With 50 AAP nodes today, what's blocking the expansion to 200? Is it budget, skills, or use case identification? PURPOSE: Unblock AAP expansion — $180K incremental ACV, Sarah is champion
- **Tom Richards (CFO):** How are you measuring ROI on the infrastructure modernization program, and what metrics does the board track? PURPOSE: Frame value conversation — Forrester TEI shows 667% ROI for similar deployments, gives Tom board-ready numbers

### 6. Open Items
- RHEL Premium renewal (2,400 nodes, $320K) due August 2026 — 90-day window opening, begin renewal discussion
- SR-2024-01203 (AAP inventory sync) — resolved April 2, confirm David is satisfied with fix

### 7. Pipeline Opportunities
- **OpenShift Expansion:** $150,000, closing Aug 15, 2026 — this meeting can advance by confirming Maria Chen's container platform requirements
- **Ansible Managed Service:** $80,000, closing Sep 30, 2026 — ask David Park about automation service needs during POC review
- **RHEL Premium Renewal:** $320,000, closing Aug 2026 — renewal discussion should start at this meeting given 90-day window

### 8. Action Items
- **Pre-meeting:** Jason Horn — share OpenShift 4.16 release notes and MicroShift edge computing brief with Maria Chen (by June 10)
- **Pre-meeting:** Jason Horn — prepare Forrester TEI one-pager showing 667% ROI for Tom Richards
- **During meeting:** Account Team — confirm David Park's RHEL 9 POC status and connect to August renewal timeline
- **Post-meeting (within 1 week):** Jason Horn — send Ansible Lightspeed case study from food manufacturing vertical to Sarah Kim
- **Post-meeting (within 2 weeks):** Jason Horn — schedule technical deep dive with Maria Chen on OpenShift Platform Plus architecture
`

// ── Minimal fixture (should FAIL) ───────────────────────────────────────────

const MINIMAL_FIXTURE = `
### 1. Meeting Objective
Brief meeting.

### 3. Recent Interactions
- They met before

### 5. Discussion Questions
- What do you want?

### 7. Pipeline Opportunities
- Some opp

### 8. Action Items
- Do something
`

// ── Old format fixture (should FAIL — removed sections present) ─────────────

const OLD_FORMAT_FIXTURE = `
### 1. Meeting Objective
This meeting focuses on reviewing infrastructure needs.

### 2. Who's in the Room
| Name | Title | Key Insight |
|---|---|---|
| John Smith | CTO | Leads cloud strategy |

### 3. Customer Snapshot
- Large enterprise company
- Running RHEL 8
- 500 employees

### 4. Why Red Hat
| Customer Goal | Red Hat Solution | Business Impact | Proof Point |
|---|---|---|---|
| Modernize | RHEL 9 | Reduce CVEs | Forrester |
| Containers | OpenShift | Faster deploys | IDC |
| Automation | Ansible | Save time | Internal |
| Edge | MicroShift | Plant monitoring | Pilot |

### 5. What's New
| Product | Announcement | Why It Matters |
|---|---|---|
| OpenShift 4.16 | Windows container support | .NET apps |
| RHEL AI | ML inference | Quality control |

### 6. Product Lifecycle
| Product | Current | Next Version | Next Expected | EOL Date |
|---|---|---|---|---|
| RHEL 8 | 8.10 | 9.5 | Q4 2025 | May 2029 |

### 7. Expansion Opportunities
- OpenShift Platform Plus
- ACS for DevSecOps

### 8. Discussion Questions
| For | Question | Purpose |
|---|---|---|
| John Smith | What containers? | Scope |
| John Smith | Security? | ACS |
| John Smith | Timeline? | Planning |
| John Smith | Budget? | Qualification |
| Jane Doe | Automation? | AAP |

### 9. Open Cases & Renewals
| Type | Detail | Status | Action |
|---|---|---|---|
| Renewal | RHEL | Due soon | Discuss |

### 10. Action Items
| Who | Action | When |
|---|---|---|
| Jason Horn | Share docs | Before meeting |
| Jason Horn | Prep demo | Pre-meeting |
| Team | Follow up | Post-meeting |
`

// ── Tests ───────────────────────────────────────────────────────────────────

describe('meetingPrepValidator', () => {
  it('has correct contentType and threshold', () => {
    expect(meetingPrepValidator.contentType).toBe('meeting-prep')
    expect(meetingPrepValidator.passThreshold).toBe(75)
  })

  describe('gold standard fixture (7-section slim format)', () => {
    const scorecard = meetingPrepValidator.validate(GOLD_STANDARD)

    it('passes overall', () => {
      expect(scorecard.passed).toBe(true)
      expect(scorecard.score).toBeGreaterThanOrEqual(75)
    })

    it('passes all required checks', () => {
      const requiredFailures = scorecard.failures.filter(f => f.severity === 'required')
      if (requiredFailures.length > 0) {
        console.log('Required failures:', requiredFailures.map(f => `${f.name}: ${f.actual}`))
      }
      expect(requiredFailures.length).toBe(0)
    })

    it('detects all 7 sections', () => {
      const sectionChecks = scorecard.checks.filter(c =>
        ['meeting-objective', 'whos-in-the-room', 'recent-interactions',
         'value-play', 'discussion-questions', 'action-items'].includes(c.name)
      )
      const passed = sectionChecks.filter(c => c.passed)
      expect(passed.length).toBe(6) // 6 required sections (Open Items is optional, Pipeline is recommended)
    })

    it('detects specific names in discussion questions', () => {
      const namedCheck = scorecard.checks.find(c => c.name === 'discussion-questions-named')
      expect(namedCheck?.passed).toBe(true)
    })

    it('detects specific names in action items', () => {
      const namedCheck = scorecard.checks.find(c => c.name === 'action-items-named')
      expect(namedCheck?.passed).toBe(true)
    })

    it('detects dates in action items', () => {
      const datedCheck = scorecard.checks.find(c => c.name === 'action-items-dated')
      expect(datedCheck?.passed).toBe(true)
    })

    it('passes no-table-leak check (no tables outside section 2)', () => {
      const tableCheck = scorecard.checks.find(c => c.name === 'no-table-leak')
      expect(tableCheck?.passed).toBe(true)
    })

    it('passes no-removed-sections check', () => {
      const removedCheck = scorecard.checks.find(c => c.name === 'no-removed-sections')
      expect(removedCheck?.passed).toBe(true)
    })

    it('validates value play has no tables', () => {
      const vpCheck = scorecard.checks.find(c => c.name === 'value-play')
      expect(vpCheck?.passed).toBe(true)
    })
  })

  describe('minimal fixture', () => {
    const scorecard = meetingPrepValidator.validate(MINIMAL_FIXTURE)

    it('fails overall', () => {
      expect(scorecard.passed).toBe(false)
      expect(scorecard.score).toBeLessThan(75)
    })

    it('identifies missing sections', () => {
      const failedNames = scorecard.failures.map(f => f.name)
      expect(failedNames).toContain('whos-in-the-room')
    })

    it('flags too-short meeting objective', () => {
      const objCheck = scorecard.checks.find(c => c.name === 'meeting-objective')
      expect(objCheck?.passed).toBe(false)
    })

    it('flags insufficient recent interactions bullets', () => {
      const riCheck = scorecard.checks.find(c => c.name === 'recent-interactions')
      expect(riCheck?.passed).toBe(false)
    })

    it('flags missing value play', () => {
      const vpCheck = scorecard.checks.find(c => c.name === 'value-play')
      expect(vpCheck?.passed).toBe(false)
    })
  })

  describe('old 10-section format', () => {
    const scorecard = meetingPrepValidator.validate(OLD_FORMAT_FIXTURE)

    it('fails the no-removed-sections check', () => {
      const removedCheck = scorecard.checks.find(c => c.name === 'no-removed-sections')
      expect(removedCheck?.passed).toBe(false)
    })

    it('detects Customer Snapshot as a removed section', () => {
      const removedCheck = scorecard.checks.find(c => c.name === 'no-removed-sections')
      expect(removedCheck?.actual).toContain('Customer Snapshot')
    })
  })
})
