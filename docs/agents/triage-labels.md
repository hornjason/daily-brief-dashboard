---
doc-type: reference
status: active
owner: jason
updated: 2026-05-01
---

# Triage Labels

Label mapping for `hornjason/asaCommandCenter`. Labels use default canonical names.

| Canonical role | Label string | Meaning |
|---|---|---|
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for Marcus (AFK agent) |
| `ready-for-human` | `ready-for-human` | Requires human implementation or judgment |
| `wontfix` | `wontfix` | Will not be actioned |
| `bug` | `bug` | Something is broken |
| `enhancement` | `enhancement` | New feature or improvement |

**Label creation status (2026-05-01):**
- `needs-triage` — created ✅
- All others — need creation (run `/setup-matt-pocock-skills` or `gh label create` manually)

**Creating remaining labels:**
```
gh label create "needs-info" --repo hornjason/asaCommandCenter --color "e4e669" --description "Waiting on reporter"
gh label create "ready-for-agent" --repo hornjason/asaCommandCenter --color "0075ca" --description "Ready for AFK agent"
gh label create "ready-for-human" --repo hornjason/asaCommandCenter --color "d4c5f9" --description "Requires human implementation"
gh label create "wontfix" --repo hornjason/asaCommandCenter --color "ffffff" --description "Will not be actioned"
gh label create "bug" --repo hornjason/asaCommandCenter --color "d73a4a" --description "Something is broken"
gh label create "enhancement" --repo hornjason/asaCommandCenter --color "a2eeef" --description "New feature or improvement"
```
