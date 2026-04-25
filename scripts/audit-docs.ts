#!/usr/bin/env bun
/**
 * audit-docs.ts — DailyBriefDashboard documentation audit
 *
 * Checks all project docs for:
 *   1. Header compliance (Last validated / **Date:** / Status markers)
 *   2. Staleness (based on Last validated date)
 *   3. Dead file references (backtick paths and markdown links)
 *   4. BKL reference staleness (all linked items DONE → archive candidate)
 *   5. Un-archived session artifacts
 *
 * Usage:
 *   bun scripts/audit-docs.ts             # audit only
 *   bun scripts/audit-docs.ts --fix       # auto-move SESSION ARTIFACTs + print mv commands for WARNs
 *   bun scripts/audit-docs.ts --max-age-days=60
 *
 * Exit codes:
 *   0 = clean (no errors)
 *   1 = one or more ERRORs found (after --fix, if errors remain)
 */

import { readdir, readFile, stat, rename, mkdir } from "node:fs/promises";
import { join, basename, dirname, relative } from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = join(import.meta.dir, "..");
const DOCS_DIR = join(PROJECT_ROOT, "docs");
const ADR_DIR = join(PROJECT_ROOT, "docs", "adr");
const ARCHIVE_DIR = join(PROJECT_ROOT, "docs", "archive");
const BACKLOG_FILE = join(PROJECT_ROOT, "BACKLOG.md");

// Structural docs that don't need backlog linkage
const STRUCTURAL_DOCS = new Set([
  "CLAUDE.md",
  "README.md",
  "ARCHITECTURE.md",
  "PRINCIPLES.md",
  "BACKLOG.md",
  "PROJECT-STATE.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "AGENTS.md",
  "SETUP.md",
]);

// Parse CLI flags
const args = process.argv.slice(2);
const FIX_MODE = args.includes("--fix");
const maxAgeDaysArg = args.find((a) => a.startsWith("--max-age-days="));
const BASE_WARN_DAYS = maxAgeDaysArg ? parseInt(maxAgeDaysArg.split("=")[1], 10) : 90;
const BASE_ERROR_DAYS = Math.round(BASE_WARN_DAYS * 2); // proportional scaling

// TTY color detection
const IS_TTY = process.stdout.isTTY;

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const color = {
  red: (s: string) => IS_TTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: (s: string) => IS_TTY ? `\x1b[33m${s}\x1b[0m` : s,
  dim: (s: string) => IS_TTY ? `\x1b[2m${s}\x1b[0m` : s,
  bold: (s: string) => IS_TTY ? `\x1b[1m${s}\x1b[0m` : s,
  green: (s: string) => IS_TTY ? `\x1b[32m${s}\x1b[0m` : s,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Severity = "ERROR" | "WARN" | "INFO";

interface Finding {
  severity: Severity;
  file: string;          // relative to PROJECT_ROOT
  message: string;
  fixAction?: () => Promise<void>;  // for --fix mode
  mvHint?: string;                   // suggested mv command for WARN
}

// ---------------------------------------------------------------------------
// BKL status map builder
// ---------------------------------------------------------------------------

async function buildBklStatusMap(): Promise<Map<string, "DONE" | "OPEN">> {
  const map = new Map<string, "DONE" | "OPEN">();
  let content: string;
  try {
    content = await readFile(BACKLOG_FILE, "utf-8");
  } catch {
    return map;
  }

  const lines = content.split("\n");
  let currentBkl: string | null = null;
  let linesAfterHeading = 0;

  for (const line of lines) {
    // Match BKL heading: ### BKL-XXXX
    const headingMatch = line.match(/^###\s+(BKL-[\w-]+)/);
    if (headingMatch) {
      currentBkl = headingMatch[1];
      linesAfterHeading = 0;
      continue;
    }

    if (currentBkl !== null) {
      linesAfterHeading++;
      // Within 3 lines of heading, look for status
      if (linesAfterHeading <= 3) {
        if (line.includes("✅ DONE") || line.includes("Status: ✅ DONE")) {
          map.set(currentBkl, "DONE");
          currentBkl = null;
        } else if (line.match(/Status:\s*(🔴 OPEN|OPEN|IN PROGRESS)/)) {
          map.set(currentBkl, "OPEN");
          currentBkl = null;
        }
      } else {
        // Also handle flat-style entries like: Status: ✅ DONE on same heading-adjacent line
        if (!map.has(currentBkl)) {
          if (line.includes("✅ DONE")) {
            map.set(currentBkl, "DONE");
          } else if (line.match(/🔴 OPEN|Status: OPEN/)) {
            map.set(currentBkl, "OPEN");
          }
        }
        currentBkl = null;
      }
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

async function collectDocs(): Promise<{ file: string; absPath: string; isAdr: boolean }[]> {
  const docs: { file: string; absPath: string; isAdr: boolean }[] = [];

  // Root-level .md files
  const rootMds = [
    "ARCHITECTURE.md",
    "PRINCIPLES.md",
    "CLAUDE.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "PROJECT-STATE.md",
    "README.md",
    "SETUP.md",
    "BACKLOG.md",
    "CHANGELOG.md",
  ];
  for (const name of rootMds) {
    const absPath = join(PROJECT_ROOT, name);
    if (existsSync(absPath)) {
      docs.push({ file: name, absPath, isAdr: false });
    }
  }

  // docs/*.md (non-recursive, skip archive/)
  try {
    const entries = await readdir(DOCS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const absPath = join(DOCS_DIR, entry.name);
        docs.push({ file: `docs/${entry.name}`, absPath, isAdr: false });
      }
    }
  } catch {
    // docs/ doesn't exist
  }

  // docs/adr/*.md
  try {
    const entries = await readdir(ADR_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const absPath = join(ADR_DIR, entry.name);
        docs.push({ file: `docs/adr/${entry.name}`, absPath, isAdr: true });
      }
    }
  } catch {
    // docs/adr/ doesn't exist
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Check 1: Header compliance
// ---------------------------------------------------------------------------

function checkHeader(
  file: string,
  content: string,
  isAdr: boolean
): Finding | null {
  const hasLastValidated = /Last validated:\s*\d{4}-\d{2}-\d{2}/.test(content);
  const hasAdrDate = /\*\*Date:\*\*\s*\d{4}-\d{2}-\d{2}/.test(content);
  const isSessionArtifact = /^Status:\s*SESSION ARTIFACT/im.test(content);
  const isPendingDecision = /^Status:\s*PENDING DECISION/im.test(content);

  if (isAdr) {
    // ADRs need **Date:** line
    if (!hasAdrDate) {
      return { severity: "ERROR", file, message: "ADR missing **Date:** line" };
    }
    return null;
  }

  // Skip BACKLOG.md / CHANGELOG.md — they have their own header conventions
  // Skip CLAUDE.md — project agent instructions, not an operational doc
  const name = basename(file);
  if (name === "BACKLOG.md" || name === "CHANGELOG.md" || name === "CLAUDE.md") {
    return null;
  }

  // SESSION ARTIFACTs and PENDING DECISIONs don't need Last validated
  if (isSessionArtifact || isPendingDecision) {
    return null;
  }

  if (!hasLastValidated) {
    return {
      severity: "ERROR",
      file,
      message: "missing classification header (no 'Last validated:' date found)",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Check 2: Staleness
// ---------------------------------------------------------------------------

function checkStaleness(
  file: string,
  content: string,
  isAdr: boolean,
  now: Date
): Finding | null {
  // ADRs are permanent records — skip staleness
  if (isAdr) return null;

  const match = content.match(/Last validated:\s*(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;

  const validatedDate = new Date(match[1] + "T00:00:00");
  const daysAgo = daysBetween(validatedDate, now);

  if (daysAgo >= BASE_ERROR_DAYS) {
    return {
      severity: "ERROR",
      file,
      message: `stale: last validated ${match[1]} (${daysAgo} days ago — exceeds ${BASE_ERROR_DAYS}-day error threshold)`,
    };
  }
  if (daysAgo >= BASE_WARN_DAYS) {
    return {
      severity: "WARN",
      file,
      message: `stale: last validated ${match[1]} (${daysAgo} days ago)`,
      mvHint: `# Review and update 'Last validated' date in ${file}`,
    };
  }
  if (daysAgo >= Math.round(BASE_WARN_DAYS * 0.67)) {
    return {
      severity: "INFO",
      file,
      message: `approaching staleness: last validated ${match[1]} (${daysAgo} days ago)`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Check 3: Dead file references
// ---------------------------------------------------------------------------

// Prefixes that indicate a local file reference worth checking
const LOCAL_PATH_PREFIXES = ["src/", "test/", "scripts/", "dashboard/src/", "dashboard/"];

// Patterns to skip: URLs, npm packages, generic examples
function isGenericOrUrl(p: string): boolean {
  if (p.startsWith("http://") || p.startsWith("https://")) return true;
  // Generic placeholder-like paths (no real filename)
  if (/your|example|<|>|\*/.test(p)) return true;
  // npm package name style (no path separator)
  if (!p.includes("/") && !p.includes(".")) return true;
  return false;
}

function extractFileRefs(content: string): string[] {
  const refs = new Set<string>();

  // Backtick refs: `src/foo.ts` `scripts/bar.sh` etc.
  const backtickRe = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = backtickRe.exec(content)) !== null) {
    const inner = m[1].trim();
    if (LOCAL_PATH_PREFIXES.some((p) => inner.startsWith(p)) && !isGenericOrUrl(inner)) {
      // Strip trailing punctuation, spaces, and line-number suffixes like :1230 or ::methodName
      const clean = inner.split(/\s/)[0].replace(/[).,;]+$/, "").replace(/:+\w+$/, "");
      if (clean.includes(".") || clean.endsWith("/")) {
        refs.add(clean);
      }
    }
  }

  // Markdown link refs: [text](../src/...) or [text](src/...)
  const mdLinkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  while ((m = mdLinkRe.exec(content)) !== null) {
    const href = m[2].trim();
    if (isGenericOrUrl(href)) continue;
    // Relative links that resolve to local project files
    if (LOCAL_PATH_PREFIXES.some((p) => href.includes(p)) && !href.includes("#")) {
      const clean = href.replace(/^\.\.\//, "").replace(/^\.\//, "").split("#")[0];
      refs.add(clean);
    }
  }

  return Array.from(refs);
}

async function checkDeadRefs(file: string, content: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const refs = extractFileRefs(content);

  for (const ref of refs) {
    const absRef = join(PROJECT_ROOT, ref);
    if (!existsSync(absRef)) {
      findings.push({
        severity: "WARN",
        file,
        message: `dead file reference: \`${ref}\` (not found at project root)`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Check 4: BKL reference staleness
// ---------------------------------------------------------------------------

function checkBklRefs(
  file: string,
  content: string,
  isAdr: boolean,
  bklMap: Map<string, "DONE" | "OPEN">
): Finding[] {
  const findings: Finding[] = [];
  const name = basename(file);

  const bklRefs = [...content.matchAll(/BKL-[A-Z0-9][\w-]*/g)].map((m) => m[0]);
  const uniqueRefs = [...new Set(bklRefs)];

  if (uniqueRefs.length === 0) {
    // No BKL refs — flag INFO for non-structural docs
    if (!STRUCTURAL_DOCS.has(name) && !isAdr) {
      findings.push({
        severity: "INFO",
        file,
        message: "no backlog linkage",
      });
    }
    return findings;
  }

  if (isAdr) return findings; // ADRs: permanent records, don't flag archive candidates
  if (STRUCTURAL_DOCS.has(name)) return findings; // Core structural docs always live at root

  // Check if ALL known refs are DONE
  const knownRefs = uniqueRefs.filter((r) => bklMap.has(r));
  if (knownRefs.length > 0 && knownRefs.every((r) => bklMap.get(r) === "DONE")) {
    const refList = knownRefs.join(", ");
    findings.push({
      severity: "WARN",
      file,
      message: `all linked backlog items closed (${refList}) — consider archiving`,
      mvHint: `mv ${file} docs/archive/${basename(file)}`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Check 5: Un-archived session artifacts
// ---------------------------------------------------------------------------

function checkSessionArtifact(file: string, content: string): Finding | null {
  // Must be a standalone status header line (starts line, optionally after ---)
  // Not matching prose mentions like "add `Status: SESSION ARTIFACT`"
  const isSessionArtifact = /^Status:\s*SESSION ARTIFACT/im.test(content);
  if (!isSessionArtifact) return null;

  // Check if it's inside docs/archive/
  const normalizedFile = file.replace(/\\/g, "/");
  if (normalizedFile.startsWith("docs/archive/")) return null;

  const destName = basename(file);
  const destPath = `docs/archive/${destName}`;
  const srcAbs = join(PROJECT_ROOT, file);
  const destAbs = join(ARCHIVE_DIR, destName);

  return {
    severity: "ERROR",
    file,
    message: "SESSION ARTIFACT outside docs/archive/",
    fixAction: async () => {
      await mkdir(ARCHIVE_DIR, { recursive: true });
      await rename(srcAbs, destAbs);
      console.log(`  Moved: ${file} -> ${destPath}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Check 5b: PENDING DECISION without BKL link
// ---------------------------------------------------------------------------

function checkPendingDecision(file: string, content: string): Finding | null {
  if (!/^Status:\s*PENDING DECISION/im.test(content)) return null;
  if (/Linked to:\s*BKL-/.test(content)) return null;
  return {
    severity: "WARN",
    file,
    message: "PENDING DECISION missing 'Linked to: BKL-XXX' reference",
  };
}

// ---------------------------------------------------------------------------
// Audit runner
// ---------------------------------------------------------------------------

async function auditDoc(
  file: string,
  absPath: string,
  isAdr: boolean,
  bklMap: Map<string, "DONE" | "OPEN">,
  now: Date
): Promise<Finding[]> {
  let content: string;
  try {
    content = await readFile(absPath, "utf-8");
  } catch {
    return [{ severity: "ERROR", file, message: "could not read file" }];
  }

  const findings: Finding[] = [];

  const f1 = checkHeader(file, content, isAdr);
  if (f1) findings.push(f1);

  const f2 = checkStaleness(file, content, isAdr, now);
  if (f2) findings.push(f2);

  const f3 = await checkDeadRefs(file, content);
  findings.push(...f3);

  const f4 = checkBklRefs(file, content, isAdr, bklMap);
  findings.push(...f4);

  const f5 = checkSessionArtifact(file, content);
  if (f5) findings.push(f5);

  const f5b = checkPendingDecision(file, content);
  if (f5b) findings.push(f5b);

  return findings;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatFinding(f: Finding): string {
  const tag = f.severity === "ERROR"
    ? color.red(`[ERROR]`)
    : f.severity === "WARN"
    ? color.yellow(`[WARN] `)
    : color.dim(`[INFO] `);
  return `  ${tag} ${f.file} — ${f.message}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const now = today();
  const runDate = now.toISOString().slice(0, 10);

  const [docs, bklMap] = await Promise.all([
    collectDocs(),
    buildBklStatusMap(),
  ]);

  console.log(color.bold(`DailyBriefDashboard Doc Audit — ${runDate}`));
  console.log(color.bold("=========================================="));
  console.log();
  console.log(`Scanning ${docs.length} docs...`);
  if (BASE_WARN_DAYS !== 90) {
    console.log(`Staleness thresholds: WARN=${BASE_WARN_DAYS}d, ERROR=${BASE_ERROR_DAYS}d`);
  }
  console.log();

  // Run all audits
  const allFindings: Finding[] = [];
  for (const { file, absPath, isAdr } of docs) {
    const findings = await auditDoc(file, absPath, isAdr, bklMap, now);
    allFindings.push(...findings);
  }

  const errors = allFindings.filter((f) => f.severity === "ERROR");
  const warns = allFindings.filter((f) => f.severity === "WARN");
  const infos = allFindings.filter((f) => f.severity === "INFO");

  // --fix: auto-move SESSION ARTIFACTs
  if (FIX_MODE) {
    const fixable = errors.filter((f) => f.fixAction);
    if (fixable.length > 0) {
      console.log(color.bold("Auto-fixing SESSION ARTIFACTs:"));
      for (const f of fixable) {
        await f.fixAction!();
        // Remove from errors array so exit code reflects post-fix state
        const idx = errors.indexOf(f);
        if (idx !== -1) errors.splice(idx, 1);
      }
      console.log();
    }

    // Print mv hints for WARNs
    const hintedWarns = warns.filter((f) => f.mvHint);
    if (hintedWarns.length > 0) {
      console.log(color.bold("Suggested commands for WARN findings:"));
      for (const f of hintedWarns) {
        console.log(`  ${f.mvHint}`);
      }
      console.log();
    }
  }

  // Print findings
  if (errors.length > 0) {
    console.log(color.bold(color.red(`ERRORS (must fix):`)));
    for (const f of errors) {
      console.log(formatFinding(f));
    }
    console.log();
  }

  if (warns.length > 0) {
    console.log(color.bold(color.yellow(`WARNINGS (should fix):`)));
    for (const f of warns) {
      console.log(formatFinding(f));
    }
    console.log();
  }

  if (infos.length > 0) {
    console.log(color.bold(color.dim(`INFO:`)));
    for (const f of infos) {
      console.log(formatFinding(f));
    }
    console.log();
  }

  if (errors.length === 0 && warns.length === 0 && infos.length === 0) {
    console.log(color.green("All docs clean — no issues found."));
    console.log();
  }

  // Summary
  console.log(color.bold("=========================================="));
  const parts: string[] = [];
  parts.push(
    errors.length > 0
      ? color.red(`${errors.length} error${errors.length !== 1 ? "s" : ""}`)
      : `0 errors`
  );
  parts.push(
    warns.length > 0
      ? color.yellow(`${warns.length} warning${warns.length !== 1 ? "s" : ""}`)
      : `0 warnings`
  );
  parts.push(`${infos.length} info`);
  console.log(`Summary: ${parts.join(", ")}`);

  if (FIX_MODE && allFindings.some((f) => f.severity === "ERROR" && f.fixAction)) {
    console.log(`Run with --fix to auto-archive SESSION ARTIFACTs`);
  } else if (!FIX_MODE) {
    console.log(`Run with --fix to auto-archive SESSION ARTIFACTs`);
  }

  if (errors.length > 0) {
    console.log(color.red(`Exit code: 1 (errors found)`));
    process.exit(1);
  } else {
    console.log(color.green(`Exit code: 0`));
    process.exit(0);
  }
}

main();
