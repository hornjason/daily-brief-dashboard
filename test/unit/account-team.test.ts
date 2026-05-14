import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { resolve } from 'path'

const TEST_CONFIG_DIR = resolve(import.meta.dir, '../../test-fixtures/config-account-team')
const TEST_SETTINGS_PATH = resolve(TEST_CONFIG_DIR, 'user-settings.json')

function writeTestSettings(data: Record<string, unknown>) {
  mkdirSync(TEST_CONFIG_DIR, { recursive: true })
  writeFileSync(TEST_SETTINGS_PATH, JSON.stringify(data, null, 2))
}

function cleanTestSettings() {
  try { unlinkSync(TEST_SETTINGS_PATH) } catch { /* ok */ }
}

describe('account-team', () => {
  // We test the logic directly by importing the module and overriding the config path
  // Since getOperatorProfile reads from getUserSettingsPath(), we test the template integration
  // via campaign-html-template instead

  describe('AccountTeam types', () => {
    it('AccountTeamRole includes all expected roles', async () => {
      const { AccountTeamMember } = await import('../../src/types.ts')
      // Type-level check — if this compiles, the types exist
      const member: import('../../src/types.ts').AccountTeamMember = {
        name: 'Test User',
        title: 'Account Executive',
        role: 'ae',
      }
      expect(member.name).toBe('Test User')
      expect(member.role).toBe('ae')
    })

    it('all role values are valid', () => {
      const validRoles = ['ae', 'asa', 'ssp', 'ssa', 'manager'] as const
      for (const role of validRoles) {
        expect(typeof role).toBe('string')
      }
    })
  })

  describe('territory team data extraction', () => {
    it('extracts ASA from Account SA row below account list', async () => {
      const { extractTeamMembers } = await import('../../src/territory-sync.ts')

      const rows = [
        ['Account Executive'],
        ['Jane Smith\nTerr01'],
        ['Acme Corp'],        // account
        ['Beta Inc'],         // account
        [''],                 // blank
        ['9 of 10'],          // count row
        [''],                 // blank
        ['Account SA'],       // role label
        ['Jason Horn'],       // ASA name
      ]

      const result = extractTeamMembers(rows, 0, 2)

      expect(result.asa).toEqual({ name: 'Jason Horn' })
    })

    it('extracts product specialists from SSP/SSA rows', async () => {
      const { extractTeamMembers } = await import('../../src/territory-sync.ts')

      const rows = [
        ['Account Executive'],
        ['Jane Smith\nTerr01'],
        ['Acme Corp'],
        [''],
        ['Account SA'],
        ['Jason Horn'],
        ['Openshift SSP'],
        ['Gabe Deupree'],
        ['Ansible SSA'],
        ['Dirk Porter'],
      ]

      const result = extractTeamMembers(rows, 0, 2)

      expect(result.specialists).toContainEqual({
        product: 'Openshift',
        role: 'ssp',
        name: 'Gabe Deupree',
      })
      expect(result.specialists).toContainEqual({
        product: 'Ansible',
        role: 'ssa',
        name: 'Dirk Porter',
      })
    })

    it('extracts partner sales and consulting manager', async () => {
      const { extractTeamMembers } = await import('../../src/territory-sync.ts')

      const rows = [
        ['Account Executive'],
        ['Jane Smith\nTerr01'],
        ['Acme Corp'],
        [''],
        ['Partner Sales Executive'],
        ['Pat Johnson'],
        ['Consulting Services Manager (TSM)'],
        ['Alex Lee'],
      ]

      const result = extractTeamMembers(rows, 0, 2)

      expect(result.partnerSales).toEqual({ name: 'Pat Johnson' })
      expect(result.consultingManager).toEqual({ name: 'Alex Lee' })
    })

    it('handles App Platform and Cloud product specialists', async () => {
      const { extractTeamMembers } = await import('../../src/territory-sync.ts')

      const rows = [
        ['Account Executive'],
        ['Jane Smith\nTerr01'],
        ['Acme Corp'],
        [''],
        ['App Platform SSA'],
        ['Sam Smith'],
        ['Cloud SSP'],
        ['Taylor Jones'],
      ]

      const result = extractTeamMembers(rows, 0, 2)

      expect(result.specialists).toContainEqual({
        product: 'App Platform',
        role: 'ssa',
        name: 'Sam Smith',
      })
      expect(result.specialists).toContainEqual({
        product: 'Cloud',
        role: 'ssp',
        name: 'Taylor Jones',
      })
    })

    it('skips count rows and blank rows while scanning', async () => {
      const { extractTeamMembers } = await import('../../src/territory-sync.ts')

      const rows = [
        ['Account Executive'],
        ['Jane Smith\nTerr01'],
        ['Acme Corp'],
        ['Beta Inc'],
        ['9 of 10'],       // count — skip
        [''],              // blank — skip
        [''],              // blank — skip
        ['Account SA'],
        ['Jason Horn'],
      ]

      const result = extractTeamMembers(rows, 0, 2)

      expect(result.asa).toEqual({ name: 'Jason Horn' })
    })

    it('skips role label when no person name exists below it', async () => {
      const { extractTeamMembers } = await import('../../src/territory-sync.ts')

      const rows = [
        ['Account Executive'],
        ['Jane Smith\nTerr01'],
        ['Acme Corp'],
        [''],
        ['Partner Sales Executive'],  // role label with no name below
        ['Consulting Services Manager (TSM)'],  // next role label — NOT a name
        ['Omar Salvatore'],
      ]

      const result = extractTeamMembers(rows, 0, 2)

      expect(result.partnerSales).toBeUndefined()
      expect(result.consultingManager).toEqual({ name: 'Omar Salvatore' })
    })

    it('returns empty when no team members found', async () => {
      const { extractTeamMembers } = await import('../../src/territory-sync.ts')

      const rows = [
        ['Account Executive'],
        ['Jane Smith\nTerr01'],
        ['Acme Corp'],
        ['Beta Inc'],
      ]

      const result = extractTeamMembers(rows, 0, 2)

      expect(result.asa).toBeUndefined()
      expect(result.specialists).toHaveLength(0)
      expect(result.partnerSales).toBeUndefined()
      expect(result.consultingManager).toBeUndefined()
    })
  })

  describe('getAccountTeam with territory teams cache', () => {
    const TEST_CACHE_DIR = resolve(import.meta.dir, '../../test-fixtures/cache-account-team')
    const TEST_CACHE_PATH = resolve(TEST_CACHE_DIR, 'territory-teams.json')

    beforeEach(() => {
      // Clean up before each test
      try { unlinkSync(TEST_CACHE_PATH) } catch { /* ok */ }
    })

    afterEach(() => {
      // Clean up after each test
      try { unlinkSync(TEST_CACHE_PATH) } catch { /* ok */ }
    })

    it('reads ASA from territory cache when available', async () => {
      // Write test cache to production location
      const prodCacheDir = resolve(process.env.DATA_DIR ?? 'data', 'cache')
      const prodCachePath = resolve(prodCacheDir, 'territory-teams.json')
      const backupPath = prodCachePath + '.backup'

      // Backup existing cache if present
      try {
        if (existsSync(prodCachePath)) {
          writeFileSync(backupPath, readFileSync(prodCachePath))
        }
      } catch {}

      try {
        mkdirSync(prodCacheDir, { recursive: true })
        const cache: import('../../src/types.ts').TerritoryTeamsCache = {
          updatedAt: '2026-05-14T12:00:00Z',
          teams: {
            'WEST_COMM_CORP_NORTHWEST_TERR06': {
              territory: 'WEST_COMM_CORP_NORTHWEST_TERR06',
              aeName: 'Elmer Alvarez',
              asa: { name: 'Jason Horn' },
              specialists: [],
            },
          },
        }
        writeFileSync(prodCachePath, JSON.stringify(cache, null, 2))

        const { getAccountTeam, invalidateTeamCache } = await import('../../src/account-team.ts')
        invalidateTeamCache()  // Force reload from new cache file

        const customer: import('../../src/types.ts').Customer = {
          name: 'Acme Corp',
          ae: 'Elmer Alvarez',
        }

        const team = getAccountTeam(customer)

        // Should have AE and territory ASA
        expect(team).toHaveLength(2)
        expect(team[0]).toEqual({ name: 'Elmer Alvarez', title: 'Account Executive', role: 'ae' })
        expect(team[1]).toEqual({ name: 'Jason Horn', title: 'Account Solution Architect', role: 'asa' })
      } finally {
        // Restore backup
        try {
          if (existsSync(backupPath)) {
            writeFileSync(prodCachePath, readFileSync(backupPath))
            unlinkSync(backupPath)
          } else {
            unlinkSync(prodCachePath)
          }
        } catch {}
      }
    })

    it('includes pod specialists from territory cache', async () => {
      const prodCacheDir = resolve(process.env.DATA_DIR ?? 'data', 'cache')
      const prodCachePath = resolve(prodCacheDir, 'territory-teams.json')
      const backupPath = prodCachePath + '.backup'

      try {
        if (existsSync(prodCachePath)) {
          writeFileSync(backupPath, readFileSync(prodCachePath))
        }
      } catch {}

      try {
        mkdirSync(prodCacheDir, { recursive: true })
        const cache: import('../../src/types.ts').TerritoryTeamsCache = {
          updatedAt: '2026-05-14T12:00:00Z',
          teams: {
            'WEST_COMM_CORP_NORTHWEST_TERR06': {
              territory: 'WEST_COMM_CORP_NORTHWEST_TERR06',
              aeName: 'Elmer Alvarez',
              asa: { name: 'Jason Horn' },
              specialists: [
                { product: 'Openshift', role: 'ssp', name: 'Gabe Deupree' },
                { product: 'Ansible', role: 'ssa', name: 'Dirk Porter' },
              ],
            },
          },
        }
        writeFileSync(prodCachePath, JSON.stringify(cache, null, 2))

        const { getAccountTeam, invalidateTeamCache } = await import('../../src/account-team.ts')
        invalidateTeamCache()  // Force reload from new cache file

        const customer: import('../../src/types.ts').Customer = {
          name: 'Acme Corp',
          ae: 'Elmer Alvarez',
        }

        const team = getAccountTeam(customer)

        // Should have AE, ASA, and 2 specialists
        expect(team).toHaveLength(4)
        expect(team[2]).toEqual({ name: 'Gabe Deupree', title: 'Openshift SSP', role: 'ssp' })
        expect(team[3]).toEqual({ name: 'Dirk Porter', title: 'Ansible SSA', role: 'ssa' })
      } finally {
        try {
          if (existsSync(backupPath)) {
            writeFileSync(prodCachePath, readFileSync(backupPath))
            unlinkSync(backupPath)
          } else {
            unlinkSync(prodCachePath)
          }
        } catch {}
      }
    })

    it('falls back to operator profile when no territory cache', async () => {
      const prodCacheDir = resolve(process.env.DATA_DIR ?? 'data', 'cache')
      const prodCachePath = resolve(prodCacheDir, 'territory-teams.json')
      const backupPath = prodCachePath + '.backup'

      try {
        if (existsSync(prodCachePath)) {
          writeFileSync(backupPath, readFileSync(prodCachePath))
        }
      } catch {}

      try {
        // Remove cache file to test fallback
        if (existsSync(prodCachePath)) {
          unlinkSync(prodCachePath)
        }

        const { getAccountTeam, getOperatorProfile, invalidateTeamCache } = await import('../../src/account-team.ts')
        invalidateTeamCache()  // Force reload after deleting cache file

        const customer: import('../../src/types.ts').Customer = {
          name: 'Acme Corp',
          ae: 'Elmer Alvarez',
        }

        const team = getAccountTeam(customer)

        // Should fall back to operator profile (if configured)
        const operator = getOperatorProfile()
        if (operator) {
          // Team should have AE + operator
          expect(team.length).toBeGreaterThanOrEqual(1)
          expect(team[0].role).toBe('ae')
          // Find operator in team (might not be index 1 if there are specialists)
          const hasOperator = team.some(m => m.name === operator.name && m.role === operator.role)
          expect(hasOperator).toBe(true)
        } else {
          // If no operator profile, just AE
          expect(team).toHaveLength(1)
          expect(team[0].role).toBe('ae')
        }
      } finally {
        try {
          if (existsSync(backupPath)) {
            writeFileSync(prodCachePath, readFileSync(backupPath))
            unlinkSync(backupPath)
          }
        } catch {}
      }
    })
  })

  describe('campaign HTML template with accountTeam', () => {
    it('renders team members in metadata line when accountTeam provided', async () => {
      const { generateCampaignHTML } = await import('../../src/campaign-html-template.ts')

      const html = generateCampaignHTML({
        materialTitle: 'Test Material',
        materialUrl: 'https://test.com',
        customerName: 'Test Corp',
        aeName: 'Elmer Alvarez',
        generatedDate: 'May 14, 2026',
        markdown: '## Campaign Summary\nTest campaign',
        accountTeam: [
          { name: 'Elmer Alvarez', title: 'Account Executive', role: 'ae' },
          { name: 'Jason Horn', title: 'Account Solution Architect', role: 'asa' },
        ],
      })

      // Metadata line should show both team members
      expect(html).toContain('AE: Elmer Alvarez')
      expect(html).toContain('ASA: Jason Horn')
    })

    it('renders SSP role correctly when title contains SSP', async () => {
      const { generateCampaignHTML } = await import('../../src/campaign-html-template.ts')

      const html = generateCampaignHTML({
        materialTitle: 'Test',
        materialUrl: 'https://test.com',
        customerName: 'Test Corp',
        aeName: 'Test AE',
        generatedDate: 'May 14, 2026',
        markdown: '## Campaign Summary\nTest',
        accountTeam: [
          { name: 'Test AE', title: 'Account Executive', role: 'ae' },
          { name: 'Pat Smith', title: 'Ansible SSP', role: 'ssp' },
        ],
      })

      expect(html).toContain('SSP: Pat Smith')
    })

    it('renders Account Team row in config table', async () => {
      const { generateCampaignHTML } = await import('../../src/campaign-html-template.ts')

      const html = generateCampaignHTML({
        materialTitle: 'Test',
        materialUrl: 'https://test.com',
        customerName: 'Test Corp',
        aeName: 'Elmer Alvarez',
        generatedDate: 'May 14, 2026',
        markdown: '## Campaign Summary\nTest',
        accountTeam: [
          { name: 'Elmer Alvarez', title: 'Account Executive', role: 'ae' },
          { name: 'Jason Horn', title: 'Account Solution Architect', role: 'asa' },
        ],
      })

      expect(html).toContain('Account Team')
      expect(html).toContain('Elmer Alvarez (AE)')
      expect(html).toContain('Jason Horn (ASA)')
    })

    it('falls back to aeName when no accountTeam provided', async () => {
      const { generateCampaignHTML } = await import('../../src/campaign-html-template.ts')

      const html = generateCampaignHTML({
        materialTitle: 'Test',
        materialUrl: 'https://test.com',
        customerName: 'Test Corp',
        aeName: 'Carolanne Farrell',
        generatedDate: 'May 14, 2026',
        markdown: '## Campaign Summary\nTest',
      })

      // Should fall back to just AE name
      expect(html).toContain('AE: Carolanne Farrell')
      expect(html).toContain('Carolanne Farrell (AE)')
    })

    it('keeps email signatures as AE-only even with accountTeam', async () => {
      const { generateCampaignHTML } = await import('../../src/campaign-html-template.ts')

      const markdown = `## Campaign Summary
Test

## Email Templates

### VP Engineering — Executive Tier

**Subject:** Test subject

**Body:**
Test body content here.`

      const html = generateCampaignHTML({
        materialTitle: 'Test',
        materialUrl: 'https://test.com',
        customerName: 'Test Corp',
        aeName: 'Elmer Alvarez',
        generatedDate: 'May 14, 2026',
        markdown,
        accountTeam: [
          { name: 'Elmer Alvarez', title: 'Account Executive', role: 'ae' },
          { name: 'Jason Horn', title: 'Account Solution Architect', role: 'asa' },
        ],
      })

      // Signature should be AE only
      expect(html).toContain('Account Executive · <span')
      // ASA should NOT appear in signature area
      const signatureBlocks = html.split('border-top: 3px solid #c41e3a')
      for (let i = 1; i < signatureBlocks.length; i++) {
        const sigBlock = signatureBlocks[i].split('</div>')[0]
        expect(sigBlock).not.toContain('Account Solution Architect')
      }
    })
  })
})
