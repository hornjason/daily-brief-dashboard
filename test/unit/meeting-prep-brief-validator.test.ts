/**
 * Meeting Prep Brief Validator — Unit Tests
 * GitHub Issue #849 — Consumer contract v1.0 hardening
 *
 * Tests the quality validator for the instant meeting prep brief output.
 */

import { describe, test, expect } from 'bun:test'
import { meetingPrepBriefValidator } from '../../src/quality-validators/meeting-prep-brief-validator.ts'

describe('meetingPrepBriefValidator', () => {
  test('good output with 3 talking points + Challenger insight scores >= 80', () => {
    const goodOutput = [
      'Fred Hutch is running RHEL 8 on 500+ nodes with case #4872901 open for kernel panics since January 2025. Ask Mike Thompson by next week whether the Overlake expansion timeline accelerates migration to RHEL 9, which would eliminate these recurring stability issues and protect the $2.4M renewal closing in Q3 2026.',
      'The OpenShift cluster at Providence is running version 4.12 with 3 critical CVEs (case #4891203). Contact Sarah Chen before the June architecture review to discuss the Ansible Automation Platform upgrade path, which could save $180K annually in manual patching costs across their 12 clusters.',
      'Starbucks pipeline shows a $1.2M expansion opportunity for RHOAI closing in Q2. Reach out to David Park this week to present the competitive displacement play against Databricks, referencing their existing OpenShift investment and the 40% cost reduction benchmark from similar retail deployments.',
      '[CHALLENGER]: Industry benchmarks show that retailers with automated ML pipelines ship features 3x faster than those relying on manual data science workflows. Starbucks competitor Target deployed RHOAI last quarter and reduced model deployment time from 6 weeks to 4 days — a gap that widens each quarter.',
    ].join('\n')

    const scorecard = meetingPrepBriefValidator.validate(goodOutput)
    expect(scorecard.score).toBeGreaterThanOrEqual(80)
    expect(scorecard.passed).toBe(true)
  })

  test('bad output with 1 generic talking point and no evidence scores < 80', () => {
    const badOutput = 'Talk to the customer about their technology needs and see what they want to do next.'

    const scorecard = meetingPrepBriefValidator.validate(badOutput)
    expect(scorecard.score).toBeLessThan(80)
    expect(scorecard.passed).toBe(false)
  })

  test('empty output scores < 80', () => {
    const scorecard = meetingPrepBriefValidator.validate('')
    expect(scorecard.score).toBeLessThan(80)
    expect(scorecard.passed).toBe(false)
  })

  test('placeholder detection catches TBD/TODO/[Insert]', () => {
    const placeholderOutput = [
      'Ask TBD about their RHEL deployment timeline and the $500K pipeline opportunity by next month.',
      'Contact [Insert name] about case #4872901 and the OpenShift migration path before Q3.',
      'TODO: Follow up with the customer about their Ansible Automation Platform expansion and the $1.2M renewal.',
      '[CHALLENGER]: Industry data shows that companies with automated infrastructure deploy 3x faster.',
    ].join('\n')

    const scorecard = meetingPrepBriefValidator.validate(placeholderOutput)
    const placeholderCheck = scorecard.checks.find(c => c.name === 'no-placeholder-text')
    expect(placeholderCheck?.passed).toBe(false)
  })

  test('output without Challenger insight fails challenger-insight check', () => {
    const noChallenger = [
      'Fred Hutch is running RHEL 8 on 500+ nodes with case #4872901. Ask Mike Thompson by next week about the migration timeline and the $2.4M renewal.',
      'The OpenShift cluster at Providence has 3 critical CVEs (case #4891203). Contact Sarah Chen before June to discuss the AAP upgrade saving $180K annually.',
      'Pipeline shows a $1.2M expansion for RHOAI closing in Q2. Reach out to David Park this week about the competitive displacement play against Databricks.',
    ].join('\n')

    const scorecard = meetingPrepBriefValidator.validate(noChallenger)
    const challengerCheck = scorecard.checks.find(c => c.name === 'challenger-insight')
    expect(challengerCheck?.passed).toBe(false)
  })

  test('output without financial terms fails dollar-connection check', () => {
    const noMoney = [
      'Fred Hutch is running RHEL 8 on many nodes with case #4872901 open. Ask Mike Thompson by next week whether the Overlake timeline accelerates migration to RHEL 9 for stability improvements across their environment.',
      'The OpenShift cluster at Providence is running version 4.12 with critical CVEs (case #4891203). Contact Sarah Chen before the June architecture review to discuss the upgrade path for patching across their clusters.',
      'Starbucks shows interest in RHOAI for their data platform initiative. Reach out to David Park this week to present the competitive positioning against alternative solutions referencing their existing systems.',
      '[CHALLENGER]: Industry benchmarks show automated ML platforms deliver features faster than manual workflows across enterprise environments.',
    ].join('\n')

    const scorecard = meetingPrepBriefValidator.validate(noMoney)
    const dollarCheck = scorecard.checks.find(c => c.name === 'dollar-connection')
    expect(dollarCheck?.passed).toBe(false)
  })

  test('validator contentType and passThreshold are correct', () => {
    expect(meetingPrepBriefValidator.contentType).toBe('meeting-prep-brief')
    expect(meetingPrepBriefValidator.passThreshold).toBe(80)
  })

  test('output with thin talking points flags min-content-depth', () => {
    const thinOutput = [
      'Ask about RHEL. Case #123.',
      'Contact Sarah about OpenShift.',
      'Check pipeline for Ansible.',
      '[CHALLENGER]: Industry data shows faster deployment cycles for automated infrastructure platforms compared to manual workflows and legacy systems.',
    ].join('\n')

    const scorecard = meetingPrepBriefValidator.validate(thinOutput)
    const depthCheck = scorecard.checks.find(c => c.name === 'min-content-depth')
    expect(depthCheck?.passed).toBe(false)
  })
})
