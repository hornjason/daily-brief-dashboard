import { fetchCustomerSheetData } from '../src/sheets.ts'
import { writeFileSync } from 'fs'
import { resolve } from 'path'

const customer = { name: 'Intrado', ae: 'Elmer Alvarez' }
const products = await fetchCustomerSheetData(customer)
console.log('Products for Intrado:', JSON.stringify(products, null, 2))

const cachePath = resolve(import.meta.dir, '../cache/intrado-sheets.json')
writeFileSync(cachePath, JSON.stringify({ rows: products, cachedAt: new Date().toISOString() }))
console.log('Cache updated.')
