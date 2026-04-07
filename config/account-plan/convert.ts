#!/usr/bin/env bun
// Converts account-plan PDFs to markdown using unpdf
import { readFileSync, writeFileSync } from 'fs'
import { extractText } from 'unpdf'

const files = ['sample', 'questions', 'playbook']

for (const name of files) {
  const pdfPath = `${import.meta.dir}/${name}.pdf`
  const mdPath = `${import.meta.dir}/${name}.md`
  try {
    const buffer = readFileSync(pdfPath)
    const { text } = await extractText(new Uint8Array(buffer), { mergePages: true })
    writeFileSync(mdPath, text)
    console.log(`✓ ${name}.pdf → ${name}.md (${text.length} chars)`)
  } catch (e) {
    console.error(`✗ ${name}.pdf failed:`, e)
  }
}
