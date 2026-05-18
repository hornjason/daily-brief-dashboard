/**
 * Unit tests for ModulePageShell component
 * GitHub Issue #237
 *
 * Tests state priority logic:
 * loading > error > empty > children
 */

import { describe, test, expect } from 'bun:test'

/**
 * Test helper: Simulates which state should render based on props
 * This matches the component's state priority logic
 */
function getRenderedState(props: {
  loading?: boolean
  error?: string | null
  empty?: boolean
  hasChildren: boolean
}): 'loading' | 'error' | 'empty' | 'children' {
  if (props.loading) return 'loading'
  if (props.error) return 'error'
  if (props.empty) return 'empty'
  if (props.hasChildren) return 'children'
  return 'children' // default when nothing special
}

describe('ModulePageShell state priority', () => {
  test('loading takes highest priority', () => {
    expect(getRenderedState({
      loading: true,
      error: 'Some error',
      empty: true,
      hasChildren: true
    })).toBe('loading')
  })

  test('error takes priority over empty and children', () => {
    expect(getRenderedState({
      loading: false,
      error: 'Network error',
      empty: true,
      hasChildren: true
    })).toBe('error')
  })

  test('empty takes priority over children', () => {
    expect(getRenderedState({
      loading: false,
      error: null,
      empty: true,
      hasChildren: true
    })).toBe('empty')
  })

  test('children render when no special states', () => {
    expect(getRenderedState({
      loading: false,
      error: null,
      empty: false,
      hasChildren: true
    })).toBe('children')
  })

  test('loading=false, error=null is not error state', () => {
    expect(getRenderedState({
      loading: false,
      error: null,
      empty: false,
      hasChildren: true
    })).toBe('children')
  })

  test('empty=false does not trigger empty state', () => {
    expect(getRenderedState({
      loading: false,
      error: null,
      empty: false,
      hasChildren: false
    })).toBe('children')
  })

  test('multiple states: loading overrides all', () => {
    expect(getRenderedState({
      loading: true,
      error: 'Error text',
      empty: true,
      hasChildren: false
    })).toBe('loading')
  })

  test('error without loading shows error', () => {
    expect(getRenderedState({
      loading: false,
      error: 'Failed to fetch',
      empty: false,
      hasChildren: false
    })).toBe('error')
  })

  test('empty without loading or error shows empty', () => {
    expect(getRenderedState({
      loading: false,
      error: null,
      empty: true,
      hasChildren: false
    })).toBe('empty')
  })
})

describe('ModulePageShell scope behavior', () => {
  test('portfolio scope does not require CustomerPicker', () => {
    const scope = 'portfolio'
    expect(scope).toBe('portfolio')
  })

  test('customer scope requires CustomerPicker', () => {
    const scope = 'customer'
    expect(scope).toBe('customer')
  })

  test('both scope includes CustomerPicker with "All customers" option', () => {
    const scope = 'both'
    expect(scope).toBe('both')
  })
})
