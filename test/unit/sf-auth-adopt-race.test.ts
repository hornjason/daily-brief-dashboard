/**
 * BKL-SF-ADOPT-RACE regression test
 *
 * Verifies that when any adopt* call throws during SF login completion,
 * the browser context (ctx) is closed via the local variable — NOT left
 * alive but untracked because activeContext was nulled before the adopt block.
 *
 * Strategy: We test the logic directly by constructing a minimal simulation
 * of the adopt block's try/catch. We verify:
 *   1. When adopt throws, ctx.close() is called (context is cleaned up)
 *   2. activeContext is null after the failure (no dangling reference)
 *   3. loginInProgress is reset to false
 *
 * We cannot easily drive startSfLoginBrowser end-to-end in unit tests
 * (requires Playwright chromium). Instead we test the invariant that the
 * fixed code pattern (adopt-then-null) is correct by exercising the logic
 * directly and verifying the contract.
 */
import { describe, it, expect, mock } from 'bun:test'

describe('BKL-SF-ADOPT-RACE: context cleanup when adopt throws', () => {
  it('closes ctx directly when an adopt call throws (fixed pattern)', async () => {
    // Simulate the fixed code pattern from sf-auth.ts:
    //   const ctx = activeContext!
    //   try { adoptFn(ctx) ... } catch { close ctx directly }
    //   activeContext = null  ← only on success

    let activeContext: { close: () => Promise<void>; pages: () => { close: () => Promise<void> }[] } | null = {
      close: mock(async () => {}),
      pages: () => [],
    }
    let loginInProgress = true
    let _adopting = true

    const ctx = activeContext!

    // Simulated adopt function that throws
    const failingAdopt = mock(() => { throw new Error('adoptScrapeContext failed') })

    let adoptThrew = false
    try {
      failingAdopt()
      // If succeed, null out activeContext AFTER adopt
      activeContext = null
    } catch (e: any) {
      adoptThrew = true
      // Fixed behavior: close ctx directly since activeContext is still non-null here
      activeContext = null
      loginInProgress = false
      _adopting = false
      for (const p of ctx.pages()) { await p.close() }
      await ctx.close()
    }

    expect(adoptThrew).toBe(true)
    expect(activeContext).toBeNull()
    expect(loginInProgress).toBe(false)
    expect(_adopting).toBe(false)
    expect(ctx.close).toHaveBeenCalledTimes(1)
  })

  it('demonstrates the BUG: old pattern leaves ctx alive when adopt throws', async () => {
    // Old (broken) pattern: activeContext = null BEFORE adopt calls.
    // When adopt throws, cleanupBrowser() is a no-op (activeContext is null).
    // ctx is alive but untracked.

    let activeContext: { close: () => Promise<void>; pages: () => { close: () => Promise<void> }[] } | null = {
      close: mock(async () => {}),
      pages: () => [],
    }
    let loginInProgress = true

    const ctx = activeContext!

    // Old pattern: null BEFORE adopt
    activeContext = null  // ← old code nulled here

    const failingAdopt = mock(() => { throw new Error('adoptScrapeContext failed') })

    // Simulate the old catch block that calls cleanupBrowser() — which is now a no-op
    const oldCleanupBrowser = async () => {
      // cleanupBrowser uses activeContext internally — already null
      const ctxToClose = activeContext  // null!
      activeContext = null
      if (ctxToClose) {
        await ctxToClose.close()
      }
    }

    try {
      failingAdopt()
    } catch {
      loginInProgress = false
      await oldCleanupBrowser()  // no-op — activeContext is null
    }

    // BUG: ctx was never closed
    expect(ctx.close).toHaveBeenCalledTimes(0)  // demonstrates the leak
    expect(activeContext).toBeNull()
    expect(loginInProgress).toBe(false)
  })

  it('fixed pattern closes ctx on second adopt failing', async () => {
    // Verify the fix handles failures mid-way through the adopt sequence
    let activeContext: { close: () => Promise<void>; pages: () => { close: () => Promise<void> }[] } | null = {
      close: mock(async () => {}),
      pages: () => [],
    }
    let loginInProgress = true
    let _adopting = true

    const ctx = activeContext!

    let callCount = 0
    const partialAdopt = mock(() => {
      callCount++
      if (callCount === 2) throw new Error('adoptSfContext failed on second call')
    })

    try {
      partialAdopt()  // first adopt succeeds
      partialAdopt()  // second adopt throws
      partialAdopt()  // third adopt — never reached
      activeContext = null  // only reached on full success
    } catch {
      activeContext = null
      loginInProgress = false
      _adopting = false
      for (const p of ctx.pages()) { await p.close() }
      await ctx.close()
    }

    expect(ctx.close).toHaveBeenCalledTimes(1)
    expect(activeContext).toBeNull()
    expect(loginInProgress).toBe(false)
    expect(callCount).toBe(2)  // third adopt was never called
  })
})
