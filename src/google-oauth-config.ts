/**
 * Bundled OAuth client credentials for Google Workspace authentication.
 *
 * These are "installed app" (Desktop) credentials — app identifiers, not secrets.
 * Google's security model expects them distributed with the binary. The real
 * security gate is the @redhat.com domain restriction enforced server-side by Google.
 *
 * Rotation:
 *   Emergency: set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in .env → restart
 *   Planned:   update these constants → rebuild image → redeploy
 *
 * Council decision: 2026-05-11 (Issue #109)
 */

export const GOOGLE_OAUTH_CLIENT = {
  client_id: process.env.GOOGLE_CLIENT_ID ?? '939083080179-93nlmgrhesg4aqoicjp37ofqi4k6buq4.apps.googleusercontent.com',
  client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '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',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  redirect_uris: ['http://localhost'],
} as const
