#!/usr/bin/env bun
// A/B test: generate account plan for 2 customers
// McAfee = WITH playbook, Workday = WITHOUT playbook
import { readFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'

const CONFIG_DIR = `${import.meta.dir}`
const CACHE_DIR = `${import.meta.dir}/../../data/cache/intelligence`
const INFERENCE = `/Users/jhorn/.claude/PAI/Tools/Inference.ts`

const SYSTEM_PROMPT = `You are a Red Hat Account Solution Architect assistant. Your job is to produce a complete, structured Account Plan for a customer — modeled after the sample plan provided.

Rules:
- Answer EVERY question and section shown in the questions reference (the image)
- Use the sample account plan as your structural template — match its sections, depth, and style
- Use the customer intelligence data as your primary source for specific facts, numbers, and insights
- Be specific: use customer names, product names, dollar amounts, dates where available
- Write as if Jason Horn (Red Hat ASA) is the author
- Output clean markdown with ## section headers matching the sample plan structure
- Do NOT include placeholder text — if data is missing, write a concise inference based on what is known`

async function generatePlan(customerSlug: string, label: string, withPlaybook: boolean) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Generating: ${label} | playbook=${withPlaybook}`)
  console.log('='.repeat(60))

  // Load customer intel
  const intel = JSON.parse(readFileSync(`${CACHE_DIR}/${customerSlug}.json`, 'utf-8'))
  const companyIntel = intel.company || ''
  const productIntel = intel.products ? JSON.stringify(intel.products, null, 2) : ''

  // Look up AE from customers.json
  const customersData = JSON.parse(readFileSync(`${import.meta.dir}/../../data/config/customers.json`, 'utf-8'))
  const customerRecord = customersData.customers?.find((c: any) =>
    c.name?.toLowerCase().includes(intel.customerName?.toLowerCase()) ||
    intel.customerName?.toLowerCase().includes(c.name?.toLowerCase())
  )
  const aeName = customerRecord?.ae || 'Account Executive'
  console.log(`AE for ${intel.customerName}: ${aeName}`)

  // Load sample plan
  const samplePlan = readFileSync(`${CONFIG_DIR}/sample.md`, 'utf-8')

  // Load playbook if requested
  const playbookSection = withPlaybook
    ? `\n\n## Account Planning Playbook (Guidance)\n${readFileSync(`${CONFIG_DIR}/playbook.md`, 'utf-8').substring(0, 8000)}`
    : ''

  // Load questions PDF as base64 for vision
  const questionsB64 = readFileSync(`${CONFIG_DIR}/questions.pdf`).toString('base64')

  const userPrompt = `## Sample Account Plan (use as structural template)
${samplePlan.substring(0, 15000)}

## Customer: ${intel.customerName}
## Account Team
- Account Executive (AE): ${aeName}
- Account Solution Architect (ASA): Jason Horn

### Company Intelligence
${companyIntel.substring(0, 8000)}

### Product Intelligence
${productIntel.substring(0, 5000)}
${playbookSection}

---
Now generate a complete Account Plan for ${intel.customerName} following the sample structure above and answering all questions from the reference image. Include ${aeName} as the AE and Jason Horn as the ASA in the team members section.`

  // Write prompt files for inspection
  writeFileSync(`/tmp/account-plan-prompt-${customerSlug}.txt`, userPrompt)
  console.log(`Prompt written to /tmp/account-plan-prompt-${customerSlug}.txt (${userPrompt.length} chars)`)

  try {
    const result = execSync(
      `bun ${INFERENCE} --level smart --timeout 300000 ${JSON.stringify(SYSTEM_PROMPT)} ${JSON.stringify(userPrompt)}`,
      { maxBuffer: 10 * 1024 * 1024, timeout: 320000, cwd: '/Users/jhorn/.claude/PAI/Projects/DailyBriefDashboard' }
    ).toString()

    const outPath = `/tmp/account-plan-${customerSlug}-${withPlaybook ? 'with' : 'without'}-playbook.md`
    writeFileSync(outPath, result)
    console.log(`✓ Output: ${outPath} (${result.length} chars)`)
  } catch (e: any) {
    console.error(`✗ Generation failed for ${customerSlug}:`, e.message?.substring(0, 300))
  }
}

// Playbook always included
await generatePlan('mcafee', 'McAfee', true)
await generatePlan('workday-inc', 'Workday', true)

console.log('\n✅ A/B test complete. Review:')
console.log('  /tmp/account-plan-mcafee-with-playbook.md')
console.log('  /tmp/account-plan-workday-inc-without-playbook.md')
