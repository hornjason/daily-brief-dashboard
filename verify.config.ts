export default {
  name: 'dailybrief-dashboard',
  root: import.meta.dir,
  tests: [
    { name: 'doc-assertions', category: 'drift', command: 'bun run scripts/verify-doc-assertions.ts' },
    { name: 'architecture-compliance', category: 'drift', command: 'bun test --isolate test/unit/architecture-compliance.test.ts' },
  ],
}
