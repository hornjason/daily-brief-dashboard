import { fetchCustomerSheetRaw } from '../src/sheets.ts'

const result = await fetchCustomerSheetRaw({ name: 'Intrado', ae: 'Elmer Alvarez' })
console.log('Tab:', result.tab)
console.log('Headers:', result.headers.join(' | '))
console.log('')
for (const row of result.rows) {
  const vals = result.headers.map(h => row[h] ?? '').join(' | ')
  console.log(vals)
}
