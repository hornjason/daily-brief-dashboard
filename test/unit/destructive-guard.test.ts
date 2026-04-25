import { describe, it, expect } from 'bun:test'
import { requireLocalhost, requireTestContainer } from '../utils/require-localhost'

describe('requireLocalhost', () => {
  it('allows localhost', () => { expect(() => requireLocalhost('http://localhost:7776')).not.toThrow() })
  it('allows 127.0.0.1', () => { expect(() => requireLocalhost('http://127.0.0.1:7776')).not.toThrow() })
  it('allows undefined (defaults to localhost)', () => { expect(() => requireLocalhost(undefined)).not.toThrow() })
  it('blocks public domains', () => { expect(() => requireLocalhost('https://demo.jasonhorn.io')).toThrow('DESTRUCTIVE TEST GUARD') })
  it('blocks mini.local', () => { expect(() => requireLocalhost('http://mini.local:7779')).toThrow('DESTRUCTIVE TEST GUARD') })
})

describe('requireTestContainer', () => {
  it('allows port 7776', () => { expect(() => requireTestContainer('http://localhost:7776')).not.toThrow() })
  it('allows 127.0.0.1:7776', () => { expect(() => requireTestContainer('http://127.0.0.1:7776')).not.toThrow() })
  it('allows undefined (defaults to 7776)', () => { expect(() => requireTestContainer(undefined)).not.toThrow() })
  it('blocks port 7777', () => { expect(() => requireTestContainer('http://localhost:7777')).toThrow('production port 7777') })
  it('blocks 127.0.0.1:7777', () => { expect(() => requireTestContainer('http://127.0.0.1:7777')).toThrow('production port 7777') })
  it('blocks public domains (inherits requireLocalhost)', () => { expect(() => requireTestContainer('https://demo.jasonhorn.io')).toThrow('DESTRUCTIVE TEST GUARD') })
})
