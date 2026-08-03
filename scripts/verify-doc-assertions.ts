#!/usr/bin/env bun
/**
 * Verify doc assertions — scans .md files for <!-- ASSERTION: ... --> comments
 * and checks each assertion against the filesystem.
 *
 * Supported assertion types:
 *   count("glob") >= N
 *   grep("pattern", "file")
 *   file_exists("path")
 *
 * Usage: bun run scripts/verify-doc-assertions.ts
 * Exit 0 if all pass, 1 if any fail.
 */

import { Glob } from 'bun'
import { existsSync, readFileSync } from 'fs'
import { resolve, join } from 'path'

const ROOT = resolve(import.meta.dir, '..')

interface AssertionResult {
  file: string
  line: number
  assertion: string
  passed: boolean
  detail: string
}

const ASSERTION_RE = /<!--\s*ASSERTION:\s*(.+?)\s*-->/g
const COUNT_RE = /^count\("(.+?)"\)\s*>=\s*(\d+)$/
const COUNT_EQ_RE = /^count\("(.+?)"\)\s*==\s*(\d+)$/
const GREP_RE = /^grep\("(.+?)",\s*"(.+?)"\)$/
const EXISTS_RE = /^file_exists\("(.+?)"\)$/

function findMdFiles(): string[] {
  const files: string[] = []
  const rootGlob = new Glob('*.md')
  for (const f of rootGlob.scanSync({ cwd: ROOT })) {
    files.push(join(ROOT, f))
  }
  const docsGlob = new Glob('docs/**/*.md')
  for (const f of docsGlob.scanSync({ cwd: ROOT })) {
    if (f.startsWith('docs/archive/')) continue
    files.push(join(ROOT, f))
  }
  return files
}

function extractAssertions(filePath: string): Array<{ line: number; assertion: string }> {
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  const results: Array<{ line: number; assertion: string }> = []
  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null
    ASSERTION_RE.lastIndex = 0
    while ((match = ASSERTION_RE.exec(lines[i])) !== null) {
      results.push({ line: i + 1, assertion: match[1].trim() })
    }
  }
  return results
}

function evaluateCount(globPattern: string, threshold: number): { passed: boolean; actual: number } {
  const g = new Glob(globPattern)
  let count = 0
  for (const _f of g.scanSync({ cwd: ROOT })) {
    count++
  }
  return { passed: count >= threshold, actual: count }
}

function evaluateGrep(pattern: string, filePath: string): { passed: boolean; detail: string } {
  const fullPath = join(ROOT, filePath)
  if (!existsSync(fullPath)) {
    return { passed: false, detail: `file not found: ${filePath}` }
  }
  const content = readFileSync(fullPath, 'utf-8')
  const found = content.includes(pattern)
  return { passed: found, detail: found ? 'pattern found' : `"${pattern}" not found in ${filePath}` }
}

function evaluateFileExists(filePath: string): { passed: boolean; detail: string } {
  const fullPath = join(ROOT, filePath)
  const exists = existsSync(fullPath)
  return { passed: exists, detail: exists ? 'file exists' : `file not found: ${filePath}` }
}

function evaluateCountEq(globPattern: string, expected: number): { passed: boolean; actual: number } {
  const g = new Glob(globPattern)
  let count = 0
  for (const _f of g.scanSync({ cwd: ROOT })) {
    count++
  }
  return { passed: count === expected, actual: count }
}

function evaluate(assertion: string): { passed: boolean; detail: string } {
  let m: RegExpExecArray | null

  m = COUNT_EQ_RE.exec(assertion)
  if (m) {
    const { passed, actual } = evaluateCountEq(m[1], parseInt(m[2], 10))
    return { passed, detail: `actual: ${actual}, expected: ==${m[2]}` }
  }

  m = COUNT_RE.exec(assertion)
  if (m) {
    const { passed, actual } = evaluateCount(m[1], parseInt(m[2], 10))
    return { passed, detail: `actual: ${actual}` }
  }

  m = GREP_RE.exec(assertion)
  if (m) {
    return evaluateGrep(m[1], m[2])
  }

  m = EXISTS_RE.exec(assertion)
  if (m) {
    return evaluateFileExists(m[1])
  }

  return { passed: false, detail: `unknown assertion type: ${assertion}` }
}

const mdFiles = findMdFiles()
const results: AssertionResult[] = []

for (const file of mdFiles) {
  const relFile = file.replace(ROOT + '/', '')
  const assertions = extractAssertions(file)
  for (const { line, assertion } of assertions) {
    const { passed, detail } = evaluate(assertion)
    results.push({ file: relFile, line, assertion, passed, detail })
  }
}

let failures = 0
for (const r of results) {
  const status = r.passed ? 'PASS' : 'FAIL'
  if (!r.passed) failures++
  console.log(`${status}: ${r.file}:${r.line} — ${r.assertion} (${r.detail})`)
}

console.log(`\n${results.length} assertions, ${results.length - failures} passed, ${failures} failed`)

process.exit(failures > 0 ? 1 : 0)
