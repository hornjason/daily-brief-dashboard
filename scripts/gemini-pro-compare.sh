#!/bin/bash
# Compare Gemini 3.5 Flash vs 2.5 Pro for tech-stack extraction
# Uses gcloud auth directly

set -euo pipefail

PROJECT="jhorn-pai"
LOCATION="us-east1"
TOKEN=$(gcloud auth print-access-token --scopes=https://www.googleapis.com/auth/cloud-platform)

SYSTEM_PROMPT='You are a technology detection system. Research the company using Google Search. Find specific products and vendor tools, not generic categories. Return a JSON array of technologies.

Rules:
- Find SPECIFIC vendor products and tools (e.g., "Terraform" not "IaC", "ServiceNow" not "ITSM", "Jenkins" not "CI/CD")
- Classify each as "proprietary" (customer-built/specific) or "industry-tool" (widely used vendor/OSS)
- Context: "using" | "evaluating" | "migrating_from"
- Confidence: HIGH (explicitly mentioned in sources) | MEDIUM (strongly implied) | LOW (inferred)
- For each, include redHatProducts that complement: ocp, rhel, aap, acs, acm, satellite, rhdh, quay
- Include a "why" field: one sentence on why the customer uses this
- Skip generic programming languages (Python, Go, Bash, Java, etc.) unless they are part of a specific platform
- Return ONLY the JSON array, no markdown'

run_model() {
  local MODEL=$1
  local CUSTOMER=$2
  local URL="https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent"

  local USER_PROMPT="CUSTOMER: ${CUSTOMER}

Research ${CUSTOMER}'s technology stack using Google Search. Find job postings, case studies, partner announcements. Extract all technologies with evidence.

Return JSON array:
[{\"name\":\"...\",\"category\":\"proprietary\"|\"industry-tool\",\"context\":\"using\"|\"evaluating\"|\"migrating_from\",\"confidence\":\"HIGH\"|\"MEDIUM\"|\"LOW\",\"redHatProducts\":[\"ocp\",\"rhel\"],\"why\":\"one sentence\"}]

Return ONLY the JSON array."

  # Build request body - different thinking config for different model versions
  if [[ "$MODEL" == gemini-3* ]]; then
    THINKING=',"thinkingConfig":{"thinkingLevel":"minimal"}'
  else
    THINKING=',"thinkingConfig":{"thinkingBudget":0}'
  fi

  local BODY=$(cat <<ENDJSON
{
  "contents":[{"role":"user","parts":[{"text":"$(echo "$USER_PROMPT" | sed 's/"/\\"/g' | tr '\n' ' ')"}]}],
  "systemInstruction":{"parts":[{"text":"$(echo "$SYSTEM_PROMPT" | sed 's/"/\\"/g' | tr '\n' ' ')"}]},
  "generationConfig":{"temperature":0.2,"maxOutputTokens":8192${THINKING}},
  "tools":[{"googleSearch":{}}]
}
ENDJSON
)

  local START=$(date +%s%N)
  local RESP=$(curl -s -X POST "$URL" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$BODY" 2>/dev/null)
  local END=$(date +%s%N)
  local ELAPSED=$(( (END - START) / 1000000 ))

  echo "$RESP" | python3 -c "
import sys,json
elapsed=${ELAPSED}
model='${MODEL}'
customer='${CUSTOMER}'

try:
    d=json.load(sys.stdin)
except Exception as e:
    print(f'  ERROR: Failed to parse response: {e}')
    sys.exit()

if 'error' in d:
    print(f'  ERROR: {d[\"error\"].get(\"message\",\"unknown\")}')
    sys.exit()

parts = d.get('candidates',[{}])[0].get('content',{}).get('parts',[])
text = ''.join(p.get('text','') for p in parts if 'text' in p and not p.get('thought'))

usage = d.get('usageMetadata',{})
inp = usage.get('promptTokenCount',0)
out = usage.get('candidatesTokenCount',0)

# Parse JSON
try:
    cleaned = text.replace('\`\`\`json','').replace('\`\`\`','').strip()
    # Find first [ and last ]
    start = cleaned.index('[')
    end = cleaned.rindex(']') + 1
    techs = json.loads(cleaned[start:end])
except Exception as e:
    print(f'  Parse error: {e}')
    print(f'  Raw text (first 200): {text[:200]}')
    sys.exit()

print(f'  Time: {elapsed/1000:.1f}s | Tokens: {inp}in/{out}out | Found: {len(techs)} technologies')

vendor = [t for t in techs if t.get('category')=='industry-tool']
propri = [t for t in techs if t.get('category')=='proprietary']
with_rh = [t for t in techs if t.get('redHatProducts') and len(t['redHatProducts'])>0]
print(f'  Vendor/OSS: {len(vendor)} | Proprietary: {len(propri)} | With RH mapping: {len(with_rh)}')

for t in techs:
    rh = ','.join(t.get('redHatProducts',[])) if t.get('redHatProducts') else ''
    conf = t.get('confidence','?')
    ctx = t.get('context','?')
    name = t.get('name','?')
    why = t.get('why','')[:60]
    icon = '●' if conf == 'HIGH' else '◐' if conf == 'MEDIUM' else '○'
    print(f'    {icon} {ctx:14s} {name}')
    if rh: print(f'      → RH: [{rh}]')
    if why: print(f'      → {why}')
"
}

echo "═══════════════════════════════════════════════════════════"
echo "  Gemini Model Comparison: Tech-Stack Extraction"
echo "  gemini-3.5-flash (current) vs gemini-2.5-pro"
echo "═══════════════════════════════════════════════════════════"

for CUSTOMER in "A10 Networks" "Fred Hutchinson Cancer Center" "Dropbox"; do
  echo ""
  echo "━━━ ${CUSTOMER} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "▸ gemini-3.5-flash (current default):"
  run_model "gemini-3.5-flash" "$CUSTOMER"
  echo ""
  echo "▸ gemini-2.5-pro:"
  run_model "gemini-2.5-pro" "$CUSTOMER"
  echo ""
done

echo "═══ Comparison Complete ═══"
