/**
 * Test preload — ensures FeatureModuleRegistry is fully evaluated before
 * any module tries to call .register() during import side effects.
 *
 * Without this, Bun's ESM evaluation order can cause modules like
 * product-intel-module.ts to evaluate before feature-module-registry.ts
 * finishes, resulting in "register is not a function" errors.
 */
import '../../src/feature-module-registry.ts'
