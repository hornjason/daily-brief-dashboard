import { test, expect, describe, beforeEach } from 'bun:test'

import { setRunning, isAnyRunning, enqueue } from '../../src/lib/run-coordinator.ts'

// Each test file gets a clean module-level state via beforeEach: we always
// reset every scope we may have set, and drain the queue if needed.
beforeEach(() => {
  // Defensive: clear any scopes that earlier tests may have left in place.
  setRunning('bootstrap', false)
  setRunning('a', false)
  setRunning('b', false)
})

describe('setRunning / isAnyRunning lifecycle', () => {
  test('starts empty', () => {
    expect(isAnyRunning()).toBe(false)
  })

  test('set true → isAnyRunning true; set false → isAnyRunning false', () => {
    setRunning('bootstrap', true)
    expect(isAnyRunning()).toBe(true)
    setRunning('bootstrap', false)
    expect(isAnyRunning()).toBe(false)
  })

  test('multiple scopes — both must clear before isAnyRunning goes false', () => {
    setRunning('a', true)
    setRunning('b', true)
    expect(isAnyRunning()).toBe(true)

    setRunning('a', false)
    expect(isAnyRunning()).toBe(true) // b still running

    setRunning('b', false)
    expect(isAnyRunning()).toBe(false)
  })

  test('setting the same scope true twice is idempotent', () => {
    setRunning('bootstrap', true)
    setRunning('bootstrap', true)
    expect(isAnyRunning()).toBe(true)
    setRunning('bootstrap', false)
    expect(isAnyRunning()).toBe(false)
  })
})

describe('enqueue', () => {
  test('runs tasks in FIFO order', async () => {
    const order: number[] = []
    await Promise.all([
      enqueue(async () => { order.push(1) }),
      enqueue(async () => { order.push(2) }),
      enqueue(async () => { order.push(3) }),
    ])
    expect(order).toEqual([1, 2, 3])
  })

  test('a throwing task does not stop subsequent tasks', async () => {
    const order: string[] = []
    await Promise.all([
      enqueue(async () => { order.push('a') }),
      enqueue(async () => { throw new Error('boom') }),
      enqueue(async () => { order.push('c') }),
    ])
    expect(order).toEqual(['a', 'c'])
  })

  test('tasks enqueued while one is running still run in order', async () => {
    const order: number[] = []
    let resolveFirst!: () => void
    const firstStarted = new Promise<void>(r => { resolveFirst = r })

    const firstDone = enqueue(async () => {
      order.push(1)
      resolveFirst()
      // Yield so the test can enqueue more before this resolves.
      await new Promise(r => setTimeout(r, 5))
    })

    await firstStarted
    const restDone = Promise.all([
      enqueue(async () => { order.push(2) }),
      enqueue(async () => { order.push(3) }),
    ])

    await firstDone
    await restDone
    expect(order).toEqual([1, 2, 3])
  })
})
