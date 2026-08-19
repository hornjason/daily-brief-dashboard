---
doc-type: reference
status: active
owner: jason
updated: 2026-08-19
---

# CrowdStrike Demo Baseline

Frozen snapshot of CrowdStrike account data from the `data-demo/cache/` pipeline.
Use this as the "before" state when demonstrating how new signals flow through the pipeline.

## Captured: 2026-08-19

Source: `data-demo/cache/` (demo environment, port 7779)

## Signal Counts

| Signal Type         | Count | File                                |
|---------------------|-------|-------------------------------------|
| Support cases       | 19    | crowdstrike-cases.json              |
| Email signals       | 17    | crowdstrike-emails.json             |
| Subscriptions       | 6     | crowdstrike-sheets.json             |
| Intelligence graph  | 153 edges, 117 nodes | intelligence-graph.json |
| Motion data         | 1     | motion.json                         |
| Graph (previous)    | 1     | intelligence-graph.previous.json    |

## Files in This Baseline

- `intelligence-graph.json` -- cross-reference graph with 153 edges connecting cases, emails, subscriptions, and account intelligence
- `intelligence-graph.previous.json` -- prior graph state for delta comparison
- `motion.json` -- account motion and momentum data
- `crowdstrike-cases.json` -- 19 support cases (extracted from shared cases.json)
- `crowdstrike-emails.json` -- 17 email signals (meetings, coordination, licensing)
- `crowdstrike-sheets.json` -- 6 subscription rows (RHEL, AAP, OCP)

## Why CrowdStrike

- Most balanced signal coverage across all demo accounts
- 153 cross-reference edges (highest of any account)
- Active across RHEL, AAP, and OCP product lines
- Real engagement pattern: TAM coordination, licensing, technical issues
- Well-known brand name for team presentations

## How to Use

1. Compare this baseline against the live CrowdStrike brief in the demo environment
2. Inject a new signal (see `data-demo/samples/sample-case-injection.json`)
3. Trigger a pipeline refresh
4. Compare the updated brief and graph against this frozen baseline
