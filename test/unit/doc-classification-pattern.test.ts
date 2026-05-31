// Pattern-based document classification optimization.
// Validates classifyByPattern() matching logic for skipping Gemini calls on obvious doc types.

import { describe, it, expect } from 'bun:test'
import { classifyByPattern } from '../../src/doc-extraction.ts'

describe('classifyByPattern()', () => {
  describe('Account Plan patterns', () => {
    it('matches "Account Plan" (case-insensitive)', () => {
      expect(classifyByPattern('Account Plan 2026', undefined)).toBe('ACCOUNT_PLAN')
      expect(classifyByPattern('account plan for acme', undefined)).toBe('ACCOUNT_PLAN')
      expect(classifyByPattern('ACCOUNT PLAN Q4', undefined)).toBe('ACCOUNT_PLAN')
    })
  })

  describe('Meeting Notes patterns', () => {
    it('matches "Meeting Notes"', () => {
      expect(classifyByPattern('Meeting Notes - Jan 2026', undefined)).toBe('MEETING_NOTES')
      expect(classifyByPattern('weekly meeting notes', undefined)).toBe('MEETING_NOTES')
    })

    it('matches "Meeting Minutes"', () => {
      expect(classifyByPattern('Meeting Minutes - Board Review', undefined)).toBe('MEETING_NOTES')
      expect(classifyByPattern('standup meeting minutes', undefined)).toBe('MEETING_NOTES')
    })
  })

  describe('Company Intelligence patterns', () => {
    it('matches "Company Brief"', () => {
      expect(classifyByPattern('Company Brief - Acme Corp', undefined)).toBe('COMPANY_INTELLIGENCE')
    })

    it('matches "Executive Summary"', () => {
      expect(classifyByPattern('Executive Summary Q1', undefined)).toBe('COMPANY_INTELLIGENCE')
    })

    it('matches "Company Intelligence"', () => {
      expect(classifyByPattern('Company Intelligence Report', undefined)).toBe('COMPANY_INTELLIGENCE')
    })

    it('matches "Account Overview"', () => {
      expect(classifyByPattern('Account Overview - Fred Hutch', undefined)).toBe('COMPANY_INTELLIGENCE')
    })
  })

  describe('Industry Analysis patterns', () => {
    it('matches "Industry Analysis"', () => {
      expect(classifyByPattern('Industry Analysis - Healthcare', undefined)).toBe('INDUSTRY_ANALYSIS')
    })

    it('matches "Market Brief"', () => {
      expect(classifyByPattern('Market Brief Q4', undefined)).toBe('INDUSTRY_ANALYSIS')
    })

    it('matches "Vertical Overview"', () => {
      expect(classifyByPattern('Vertical Overview - Financial Services', undefined)).toBe('INDUSTRY_ANALYSIS')
    })

    it('matches "Industry Report"', () => {
      expect(classifyByPattern('Industry Report 2026', undefined)).toBe('INDUSTRY_ANALYSIS')
    })
  })

  describe('Proposal patterns', () => {
    it('matches "Proposal"', () => {
      expect(classifyByPattern('Proposal for Ansible Automation', undefined)).toBe('PROPOSAL')
    })

    it('matches "Statement of Work"', () => {
      expect(classifyByPattern('Statement of Work - Migration', undefined)).toBe('PROPOSAL')
    })

    it('matches "SOW"', () => {
      expect(classifyByPattern('SOW - Container Platform', undefined)).toBe('PROPOSAL')
    })
  })

  describe('Technical Doc patterns', () => {
    it('matches "Technical"', () => {
      expect(classifyByPattern('Technical Architecture Review', undefined)).toBe('TECHNICAL_DOC')
    })

    it('matches "Architecture"', () => {
      expect(classifyByPattern('Architecture Decision Record', undefined)).toBe('TECHNICAL_DOC')
    })

    it('matches "Design Doc"', () => {
      expect(classifyByPattern('Design Doc - API Gateway', undefined)).toBe('TECHNICAL_DOC')
    })
  })

  describe('Spreadsheet patterns (OTHER)', () => {
    it('matches Google Sheets MIME type', () => {
      expect(classifyByPattern('Budget 2026', 'application/vnd.google-apps.spreadsheet')).toBe('OTHER')
    })

    it('ignores filename when MIME indicates spreadsheet', () => {
      expect(classifyByPattern('Account Plan Spreadsheet', 'application/vnd.google-apps.spreadsheet')).toBe('OTHER')
    })
  })

  describe('No pattern match', () => {
    it('returns null for unrecognized filename', () => {
      expect(classifyByPattern('Random Document', undefined)).toBeNull()
    })

    it('returns null for generic title', () => {
      expect(classifyByPattern('Q4 Planning', undefined)).toBeNull()
    })

    it('filename patterns take precedence over no MIME', () => {
      expect(classifyByPattern('Account Plan', undefined)).toBe('ACCOUNT_PLAN')
    })
  })

  describe('Case sensitivity', () => {
    it('matches mixed case patterns', () => {
      expect(classifyByPattern('account PLAN 2026', undefined)).toBe('ACCOUNT_PLAN')
      expect(classifyByPattern('MeEtInG NoTeS', undefined)).toBe('MEETING_NOTES')
      expect(classifyByPattern('COMPANY brief', undefined)).toBe('COMPANY_INTELLIGENCE')
    })
  })
})
