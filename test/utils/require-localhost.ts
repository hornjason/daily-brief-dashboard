export function requireLocalhost(baseURL: string | undefined) {
  const host = new URL(baseURL ?? 'http://localhost').hostname
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(
      `DESTRUCTIVE TEST GUARD: refusing to run against non-localhost URL "${baseURL}". ` +
      `Destructive tests may only target localhost or 127.0.0.1.`
    )
  }
}

/** Ensures destructive tests never target the production container (port 7777). */
export function requireTestContainer(baseURL: string | undefined) {
  requireLocalhost(baseURL)
  const port = new URL(baseURL ?? 'http://localhost:7776').port || '80'
  if (port === '7777') {
    throw new Error(
      `DESTRUCTIVE TEST GUARD: refusing to run against production port 7777 at "${baseURL}". ` +
      `Destructive tests must target the test container (port 7776). ` +
      `Set TEST_URL=http://localhost:7776 to override.`
    )
  }
}
