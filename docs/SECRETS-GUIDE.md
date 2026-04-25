---
Status: Operational
Last validated: 2026-04-19
Trigger: New credential added, rotation procedure changes, .env structure changes
---

# Secrets Management Guide

How credentials are handled in DailyBriefDashboard — what lives where, why, and how to rotate.

---

## The Three-Layer Model

```
defaults.env          ← shipped in container image (non-sensitive defaults + shared service accounts)
.env                  ← your personal overrides (gitignored, never committed)
GitHub Secrets        ← CI/CD credentials (repo Settings → Secrets and variables)
```

**Rule:** If it can identify you personally or give billing access to a real account, it goes in `.env` or GitHub Secrets — never in `defaults.env`.

---

## defaults.env — What Lives Here and Why

`defaults.env` is committed to the repo and baked into the container image. It ships working defaults so a new user can pull the image and get AI briefs without any GCP setup.

| Variable | Why It's Here |
|---|---|
| `GEMINI_SERVICE_ACCOUNT_KEY` | **Removed** — see [OAuth auth section](#vertex-ai-auth-oauth-not-sa-key) below. Auth now flows through the user's @redhat.com OAuth token. |
| `GOOGLE_CLOUD_PROJECT` | The shared GCP project (`jhorn-pai`) — non-sensitive identifier, the auth comes from the user's OAuth token |
| `GEMINI_MODEL` | Just a model name, not sensitive |
| `NTFY_TOPIC` | Push notification topic — not sensitive |

**Auth model:** The shared GCP project `jhorn-pai` has an IAM binding `domain:redhat.com → Vertex AI User`. Any @redhat.com Google OAuth token with the `cloud-platform` scope can call Vertex AI directly — no shared service account key needs to ship in the image.

**Accepted risks (post-SA-key-removal):**
- The shared `GOOGLE_CLOUD_PROJECT=jhorn-pai` identifier is in the image, but it's a project ID not a credential — no risk on its own.
- Vertex AI access is gated by Red Hat domain membership, enforced by GCP IAM. A user must hold a valid @redhat.com OAuth token to call the API.
- Set a billing alert at `$20/month` on `jhorn-pai` in Google Cloud to catch unexpected usage from misconfiguration.

**Override for yourself:** If you're not on the redhat.com domain and need a fallback, you can still add `GEMINI_SERVICE_ACCOUNT_KEY=<your-own-key>` to your `.env` — `src/gemini-auth.ts` honors it. This is the only remaining use of the SA key path.

### Vertex AI Auth (OAuth, not SA key)

The build pipeline no longer injects `GEMINI_SERVICE_ACCOUNT_KEY` into the container image or the release E2E job. The runtime flow is:

1. User signs in with their @redhat.com Google account through the in-app OAuth flow.
2. The token issued includes the `cloud-platform` scope.
3. `src/gemini-auth.ts` uses that token to call Vertex AI on `jhorn-pai`.
4. GCP authorizes the call via the `domain:redhat.com → Vertex AI User` IAM binding.

If a user supplies their own `GEMINI_SERVICE_ACCOUNT_KEY` in `.env`, the SA key path is still honored — but it's a manual opt-in for users outside the @redhat.com domain. Default builds carry no SA key.

---

## .env — Your Personal Credentials (Never Committed)

The `.env` file is gitignored. It holds credentials that are yours alone:

```bash
# Google OAuth (your personal account)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...

# Salesforce
SF_USERNAME=...
SF_PASSWORD=...
SF_TOKEN=...

# Red Hat SSO
RH_USERNAME=rhn-gps-jhorn

# Override Gemini with your own key (optional)
# GEMINI_SERVICE_ACCOUNT_KEY=<your-base64-key>
```

Copy `.env.example` to start: `cp .env.example .env`

---

## GitHub Actions Secrets — CI Pipeline Credentials

Go to: **GitHub repo → Settings → Secrets and variables → Actions**

### Tier 1 CI (runs on every PR) — no real credentials needed
The CI pipeline runs without any personal credentials. Unit tests and Playwright E2E wizard tests use synthetic data only. No secrets required for PRs.

### Tier 2 Release Gate — real credentials

These are stored in the **`production` GitHub Environment** (not the repo-level secrets), which requires manual approval before the release workflow can access them.

Go to: **GitHub repo → Settings → Environments → production → Add secret**

| Secret Name | What It Is | Where to Get It |
|---|---|---|
| `GOOGLE_CLIENT_ID` | OAuth app client ID | Google Cloud Console → APIs → Credentials |
| `GOOGLE_CLIENT_SECRET` | OAuth app client secret | Same as above |
| `GOOGLE_REFRESH_TOKEN` | Long-lived refresh token | Run `bun run login:google` locally, copy from `config/.google-token.json` |
| ~~`GEMINI_SERVICE_ACCOUNT_KEY`~~ | **Removed** — release pipeline no longer injects an SA key. Vertex AI auth uses the @redhat.com OAuth token. | n/a |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID | `jhorn-pai` (or your override) |
| `SF_USERNAME` | Salesforce username | Your SF login email |
| `SF_PASSWORD` | Salesforce password | Your SF password |
| `SF_TOKEN` | Salesforce security token | Salesforce → Settings → My Personal Information → Reset Token |
| `RH_USERNAME` | Red Hat SSO username | `rhn-gps-jhorn` |
| `RH_PASSWORD` | Red Hat SSO password | Your RH account password |

---

## Rotating the Gemini Service Account Key

**No longer applicable for default builds.** The shared `GEMINI_SERVICE_ACCOUNT_KEY` was removed from `defaults.env` and the release pipeline. Vertex AI auth flows through the user's @redhat.com OAuth token via the `domain:redhat.com → Vertex AI User` IAM binding on `jhorn-pai`. There is no shared SA key to rotate.

**If a user supplies their own SA key** in `.env` (the documented bring-your-own fallback in `gemini-auth.ts`), that user owns the rotation. The GCP service account `asa-dashboard-gemini@jhorn-pai.iam.gserviceaccount.com` is no longer used by default builds and any keys on it should be deleted from Google Cloud Console once any in-flight images have been rebuilt without the key.

**Action items completed (one-time, on SA-key removal):**
- [x] `defaults.env` — comment updated, no SA key shipped
- [x] `.github/workflows/release.yml` — `GEMINI_SERVICE_ACCOUNT_KEY` removed from the release-e2e env block
- [ ] Google Cloud Console — delete any remaining keys on `asa-dashboard-gemini@jhorn-pai.iam.gserviceaccount.com` once production images are rebuilt without the key
- [ ] GitHub → Settings → Environments → production — remove the `GEMINI_SERVICE_ACCOUNT_KEY` secret (no longer referenced by any workflow)

---

## What Team Members Need

When onboarding a new Red Hat sales team member:

1. Give them access to the GitHub repo
2. Share the container pull command — they get Gemini AI briefs for free via `defaults.env`
3. They set up their **own** `.env` for personal credentials (Google OAuth, Salesforce, RH login)
4. They run `make rebuild` with their `.env` — the app is fully functional

Team members **never** need to touch `defaults.env` or GitHub Secrets.

---

## Before Going Open Source

When the project is accepted and moves to an org repo or goes public:

- [ ] Rotate the Gemini key one final time
- [ ] Create a dedicated `asa-dashboard-shared` GCP project (separate billing from personal)
- [ ] Set a `$20/month` billing alert on the shared project
- [ ] Consider replacing `defaults.env` key with instructions to bring-your-own GCP project
- [ ] Audit `defaults.env` — nothing in it should identify you personally
- [ ] Move repo to Red Hat org and configure org-level secrets for CI

---

## Quick Reference

| Credential | Tier 1 CI | Tier 2 Release | Local Dev |
|---|---|---|---|
| Gemini auth | None — uses caller's @redhat.com OAuth token | None — uses caller's @redhat.com OAuth token | @redhat.com OAuth token (or `.env` SA key fallback if outside redhat.com) |
| Google OAuth | Not needed | GitHub Environment secret | `config/.google-token.json` |
| Salesforce | Not needed | GitHub Environment secret | `.env` |
| RH Portal | Not needed | GitHub Environment secret | `.env` + local browser session |
