/**
 * Unit tests for meeting-prep-validator.ts
 *
 * Tests against a gold standard fixture (must pass) and a minimal fixture (must fail).
 */

import { describe, it, expect } from 'bun:test'
import { meetingPrepValidator } from '../../src/quality-validators/meeting-prep-validator.ts'

// ── Gold standard fixture (should PASS) ─────────────────────────────────────

const GOLD_STANDARD = `
### 1. Meeting Objective
This meeting with Taylor Fresh Foods focuses on reviewing their current Red Hat infrastructure, exploring expansion opportunities into container orchestration with OpenShift, and aligning our partnership strategy with their digital transformation roadmap. The objective is to establish clear next steps for Q3 2026 initiatives.

### 2. Partner Context
| Partner | Specialization | Role | Recommended Focus |
|---|---|---|---|
| Acme Consulting | Infrastructure Modernization | Primary SI | RHEL migration |
| CloudWorks Inc | Container Platform | Emerging Partner | OpenShift adoption |

Other certified partners in the region: DataServe Solutions (storage), NetOps Group (networking)

### 3. Customer Snapshot
- Taylor Fresh Foods is a $4.2B revenue food production company with 15,000+ employees
- Currently running RHEL 8 across 2,400 nodes in 3 data centers
- Embarking on a cloud-native transformation initiative targeting 2027 completion
- Recent CTO hire (Maria Chen) brings container expertise from previous role at Kroger
- Active participant in Red Hat Summit 2025 with 4 registered attendees

### 4. Why Red Hat
| Customer Goal | Red Hat Solution | Business Impact | Proof Point |
|---|---|---|---|
| Modernize legacy infrastructure | RHEL 9 migration path | 30% reduction in CVE exposure | Value map: Infrastructure Stability score 8.2/10 |
| Container adoption | OpenShift Platform Plus | 40% faster deployment cycles | Value map: DevOps maturity from 2.1 to projected 4.5 |
| Compliance automation | Ansible Automation Platform | 60% reduction in audit prep time | Value map: Compliance readiness score 7.8/10 |
| Edge computing for plants | MicroShift + Device Edge | Real-time quality monitoring | Value map: Edge readiness score 6.5/10 |

### 5. What's New
| Product | Announcement | Why It Matters |
|---|---|---|
| OpenShift 4.16 | Improved Windows container support | Taylor's .NET apps can run alongside Linux workloads |
| RHEL AI | On-premise AI/ML inference | Quality control automation at plant edge locations |
| Ansible Lightspeed | AI-assisted automation content | Accelerates their compliance automation initiative |

### 6. Product Lifecycle
| Product | Current | Next Version | Next Expected | EOL Date |
|---|---|---|---|---|
| RHEL 8 | 8.10 | RHEL 9.5 | Q4 2025 | May 2029 |
| OpenShift | 4.14 | 4.16 | Q3 2025 | Feb 2026 |
| Ansible | 2.16 | 2.17 | Q2 2025 | Nov 2025 |

### 7. Expansion Opportunities
- OpenShift Platform Plus for container orchestration across 3 data centers
- Ansible Automation Platform expansion from 50 to 200 managed nodes
- MicroShift deployment at 12 manufacturing plant locations for edge computing
- Red Hat Advanced Cluster Security for DevSecOps compliance

### 8. Discussion Questions
| For | Question | Purpose |
|---|---|---|
| Maria Chen (CTO) | What is your timeline for containerizing the core ERP modules? | Understand OpenShift deployment scope |
| Maria Chen (CTO) | How are you approaching security scanning in your CI/CD pipeline? | Position ACS and Quay |
| David Park (VP Infra) | What is your RHEL 8 to 9 migration strategy for the production nodes? | Scope RHEL migration services |
| David Park (VP Infra) | Are you evaluating any edge computing platforms for the plant floor? | Introduce MicroShift |
| Sarah Kim (Dir DevOps) | What automation frameworks are your teams currently using? | Position AAP expansion |
| Tom Richards (CFO) | How are you measuring ROI on your infrastructure modernization program? | Frame value conversation |

### 9. Open Cases & Renewals
| Type | Detail | Status | Action |
|---|---|---|---|
| Case | SR-2024-00891: RHEL 8 kernel panic on Node 1247 | Resolved | Share resolution with VP Infra |
| Renewal | RHEL Premium (2,400 nodes) | Due Aug 2026 | Begin renewal discussion — 90 day window |
| Case | SR-2024-01203: AAP inventory sync failure | In Progress | Escalation requested — follow up |

### 10. Action Items
| Who | Action | When |
|---|---|---|
| Jason Horn (ASA) | Share OpenShift 4.16 release notes with Maria Chen | Before meeting |
| Jason Horn (ASA) | Prepare MicroShift demo environment for plant edge discussion | Pre-meeting — by June 15 |
| Account Team | Schedule follow-up technical deep dive with David Park on RHEL 9 migration | During meeting |
| Jason Horn (ASA) | Send Ansible Lightspeed case study from food manufacturing vertical | Post-meeting — within 1 week |
`

// ── Minimal fixture (should FAIL) ───────────────────────────────────────────

const MINIMAL_FIXTURE = `
### 1. Meeting Objective
Brief meeting.

### 3. Customer Snapshot
- They are a company

### 8. Discussion Questions
| For | Question | Purpose |
|---|---|---|
| the customer | What do you want? | Understanding |

### 10. Action Items
| Who | Action | When |
|---|---|---|
| the team | Do something | TBD |
`

// ── Tests ───────────────────────────────────────────────────────────────────

describe('meetingPrepValidator', () => {
  it('has correct contentType and threshold', () => {
    expect(meetingPrepValidator.contentType).toBe('meeting-prep')
    expect(meetingPrepValidator.passThreshold).toBe(75)
  })

  describe('gold standard fixture', () => {
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

    it('has all 10 sections detected', () => {
      const sectionChecks = scorecard.checks.filter(c =>
        ['meeting-objective', 'partner-context', 'customer-snapshot', 'why-red-hat',
         'whats-new', 'product-lifecycle', 'expansion-opportunities',
         'discussion-questions', 'open-cases-renewals', 'action-items'].includes(c.name)
      )
      const passed = sectionChecks.filter(c => c.passed)
      expect(passed.length).toBe(10)
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
  })

  describe('minimal fixture', () => {
    const scorecard = meetingPrepValidator.validate(MINIMAL_FIXTURE)

    it('fails overall', () => {
      expect(scorecard.passed).toBe(false)
      expect(scorecard.score).toBeLessThan(75)
    })

    it('identifies missing sections', () => {
      const failedNames = scorecard.failures.map(f => f.name)
      // These sections are completely missing in the minimal fixture
      expect(failedNames).toContain('partner-context')
      expect(failedNames).toContain('why-red-hat')
      expect(failedNames).toContain('whats-new')
      expect(failedNames).toContain('product-lifecycle')
      expect(failedNames).toContain('expansion-opportunities')
      expect(failedNames).toContain('open-cases-renewals')
    })

    it('flags too-short meeting objective', () => {
      const objCheck = scorecard.checks.find(c => c.name === 'meeting-objective')
      expect(objCheck?.passed).toBe(false)
    })

    it('flags insufficient customer snapshot bullets', () => {
      const snapCheck = scorecard.checks.find(c => c.name === 'customer-snapshot')
      expect(snapCheck?.passed).toBe(false)
    })

    it('flags generic names in discussion questions', () => {
      const namedCheck = scorecard.checks.find(c => c.name === 'discussion-questions-named')
      expect(namedCheck?.passed).toBe(false)
    })

    it('flags generic names in action items', () => {
      const namedCheck = scorecard.checks.find(c => c.name === 'action-items-named')
      expect(namedCheck?.passed).toBe(false)
    })
  })
})
