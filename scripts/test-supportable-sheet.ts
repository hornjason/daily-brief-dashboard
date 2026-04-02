/**
 * scripts/test-supportable-sheet.ts
 *
 * Creates a test Supportable Google Sheet with fake data to verify
 * sheet structure, tab layout, and column headers before running
 * the real Supportable scraper.
 *
 * Usage:
 *   bun scripts/test-supportable-sheet.ts
 */

import { writeSupportableSheet } from '../src/supportable-scraper.ts'
import type { SupportableResult } from '../src/supportable-scraper.ts'

const fakeResults: SupportableResult[] = [
  {
    customerName:   'Acme Corp',
    accountNumbers: ['1234567'],
    rows: [
      {
        'Name':              'Acme Corp',
        'Customer Number':   'ACME-001',
        'Account Number':    '1234567',
        'Country':           'US',
        'First Name':        'Jane',
        'Last Name':         'Doe',
        'Login':             'jdoe@acme.com',
        'Email':             'jdoe@acme.com',
        'Phone Num':         '555-0100',
        'Internal Sku':      'RH00798',
        'Ordered Item':      'Red Hat Enterprise Linux Server, Standard (1-2 sockets)',
        'Product Description': 'Red Hat Enterprise Linux Server, Standard (1-2 sockets)',
        'Quantity':          '10',
        'Status':            'ACTIVE',
        'Start Date':        '2024-01-01',
        'End Date':          '2025-12-31',
        'Contract#':         'C-00001',
        'Cust PO Number':    'PO-12345',
        'End Customer PO':   '',
      },
      {
        'Name':              'Acme Corp',
        'Customer Number':   'ACME-001',
        'Account Number':    '1234567',
        'Country':           'US',
        'First Name':        'Jane',
        'Last Name':         'Doe',
        'Login':             'jdoe@acme.com',
        'Email':             'jdoe@acme.com',
        'Phone Num':         '555-0100',
        'Internal Sku':      'MCT0370',
        'Ordered Item':      'Red Hat OpenShift Container Platform',
        'Product Description': 'Red Hat OpenShift Container Platform',
        'Quantity':          '2',
        'Status':            'ACTIVE',
        'Start Date':        '2024-06-01',
        'End Date':          '2025-05-31',
        'Contract#':         'C-00002',
        'Cust PO Number':    'PO-12345',
        'End Customer PO':   '',
      },
    ],
  },
  {
    customerName:   'Globex',
    accountNumbers: ['7654321', '8888888'],
    rows: [
      {
        'Name':              'Globex',
        'Customer Number':   'GLOB-001',
        'Account Number':    '7654321',
        'Country':           'US',
        'First Name':        'Bob',
        'Last Name':         'Smith',
        'Login':             'bsmith@globex.com',
        'Email':             'bsmith@globex.com',
        'Phone Num':         '555-0200',
        'Internal Sku':      'RH00798',
        'Ordered Item':      'Red Hat Enterprise Linux Server, Standard (1-2 sockets)',
        'Product Description': 'Red Hat Enterprise Linux Server, Standard (1-2 sockets)',
        'Quantity':          '25',
        'Status':            'ACTIVE',
        'Start Date':        '2023-07-01',
        'End Date':          '2026-06-30',
        'Contract#':         'C-00003',
        'Cust PO Number':    'PO-99999',
        'End Customer PO':   '',
      },
      {
        'Name':              'Globex',
        'Customer Number':   'GLOB-002',
        'Account Number':    '8888888',
        'Country':           'US',
        'First Name':        'Alice',
        'Last Name':         'Jones',
        'Login':             'ajones@globex.com',
        'Email':             'ajones@globex.com',
        'Phone Num':         '555-0201',
        'Internal Sku':      'SER0419',
        'Ordered Item':      'Red Hat Ansible Automation Platform',
        'Product Description': 'Red Hat Ansible Automation Platform',
        'Quantity':          '100',
        'Status':            'ACTIVE',
        'Start Date':        '2024-01-01',
        'End Date':          '2024-12-31',
        'Contract#':         'C-00004',
        'Cust PO Number':    'PO-88888',
        'End Customer PO':   '',
      },
    ],
  },
  {
    customerName:   'Initech',
    accountNumbers: ['5555555'],
    rows: [],  // no rows — verify headers-only tab still created
  },
]

console.log('Creating test Supportable sheet…')
try {
  const spreadsheetId = await writeSupportableSheet(fakeResults, 'Jason Horn (TEST)')
  console.log(`\n✅ Sheet created successfully`)
  console.log(`   ID:  ${spreadsheetId}`)
  console.log(`   URL: https://docs.google.com/spreadsheets/d/${spreadsheetId}`)
  console.log(`\nTabs created:`)
  console.log(`  • Accounts  (3 customers)`)
  console.log(`  • Acme Corp (2 subscription rows)`)
  console.log(`  • Globex    (2 subscription rows, 2 account numbers)`)
  console.log(`  • Initech   (headers only — 0 rows)`)
} catch (e: any) {
  console.error('❌ Failed:', e.message)
  process.exit(1)
}
