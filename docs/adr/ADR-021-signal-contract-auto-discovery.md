---
doc-type: adr
status: active
owner: jason
updated: 2026-05-14
---

# Signal contract and auto-discovery pattern

Feature modules need to contribute customer intelligence to content generation features (campaigns, briefs, meeting prep, account plans). We chose a flat `Signal` interface with an optional `signals()` method on the `FeatureModule` contract, collected by the registry via `collectAllSignals()`.

The flat bag (generic `metadata?` field) was chosen over a discriminated union with typed per-signal-type payloads. The primary consumer is Gemini prompt construction, which serializes everything to text — TypeScript type safety on 13 signal variants would add friction (every new source requires extending the union AND adding a typed variant) with no runtime benefit. Per-type data rides in `metadata` for the few consumers that need it (e.g., UI rendering case severity badges).

`score` is optional and 0-1 normalized rather than source-native (news uses 1-10, cases use severity 1-4). This enables cross-type ranking ("top 5 signals for this customer") without mixing incompatible scales.

During the transition, `loadCustomerSignals()` in `signal-loader.ts` uses a dual-path: registry signals from modules that implement `signals()`, plus legacy cache-file loading for sources not yet converted. As modules adopt `signals()`, the legacy path shrinks naturally with no coordinated migration.

## Considered options

- **Discriminated union per signal type**: Compile-time guarantees on per-type fields. Rejected because the 13-variant union creates a large type surface that must be extended for every new source, and the primary consumer (Gemini prompts) doesn't benefit from typed payloads.
- **Separate signal registry**: A second registry alongside `FeatureModuleRegistry`. Rejected because signals are a capability of modules, not a separate concern — splitting creates two registration points for one concept.
