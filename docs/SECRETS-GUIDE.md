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
| `GEMINI_SERVICE_ACCOUNT_KEY` | Shared Gemini service account — lets new users get AI briefs immediately |
| `GOOGLE_CLOUD_PROJECT` | The GCP project the shared service account belongs to |
| `GEMINI_MODEL` | Just a model name, not sensitive |
| `NTFY_TOPIC` | Push notification topic — not sensitive |

**This is a deliberate trade-off:** convenience for new users vs. exposing a shared service account.

**Accepted risks:**
- Anyone with the image can use your Gemini quota
- If the repo goes public, the key is public — **rotate before open-sourcing**
- Set a billing alert at `$20/month` in Google Cloud to catch unexpected usage

**Override for yourself:** Add `GEMINI_SERVICE_ACCOUNT_KEY=<your-own-key>` to your `.env` — it wins over `defaults.env`.

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
| `GEMINI_SERVICE_ACCOUNT_KEY` | Base64-encoded service account JSON | See rotation section below |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID | `jhorn-pai` (or your override) |
| `SF_USERNAME` | Salesforce username | Your SF login email |
| `SF_PASSWORD` | Salesforce password | Your SF password |
| `SF_TOKEN` | Salesforce security token | Salesforce → Settings → My Personal Information → Reset Token |
| `RH_USERNAME` | Red Hat SSO username | `rhn-gps-jhorn` |
| `RH_PASSWORD` | Red Hat SSO password | Your RH account password |

---

## Rotating the Gemini Service Account Key

Do this when: onboarding a new team, before open-sourcing, or on a 90-day rotation schedule.

### Step 1 — Create a new key

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Navigate to **IAM & Admin → Service Accounts**
3. Find `asa-dashboard-gemini@jhorn-pai.iam.gserviceaccount.com`
4. Click the account → **Keys** tab → **Add Key → Create new key → JSON**
5. Download the JSON file (e.g., `new-key.json`)

### Step 2 — Encode the new key

```bash
base64 -w 0 new-key.json | tr -d '\n'
# On macOS: base64 -i new-key.json | tr -d '\n'
```

Copy the output — this is the new value for `GEMINI_SERVICE_ACCOUNT_KEY`.

### Step 3 — Update defaults.env

Edit `defaults.env` and replace the `GEMINI_SERVICE_ACCOUNT_KEY` value with the new base64 string.

```bash
# Verify you can decode it correctly before committing
echo "<your-new-base64>" | base64 -d | python3 -m json.tool | grep client_email
# Should print: "client_email": "asa-dashboard-gemini@jhorn-pai.iam.gserviceaccount.com"
```

### Step 4 — Delete the old key

Back in Google Cloud Console → Service Account → Keys → find the old key ID → **Delete**.

### Step 5 — Update running instance

The key is baked into the container image at build time via `defaults.env`. To pick up the new key:

```bash
# Rebuild and restart the container — picks up new defaults.env
make rebuild

# Or, without rebuilding, inject at runtime:
echo "GEMINI_SERVICE_ACCOUNT_KEY=<new-base64>" >> .env
make rebuild
```

### Step 6 — Update GitHub Secrets (for Tier 2)

In **GitHub → Settings → Environments → production**, update `GEMINI_SERVICE_ACCOUNT_KEY` with the new base64 value.

### Step 7 — Commit and push

```bash
git add defaults.env
git commit -m "chore: rotate Gemini service account key"
git push
```

CI will build and push a new container image with the rotated key baked in.

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
| Gemini key | From `defaults.env` in image | GitHub Environment secret | `defaults.env` or `.env` override |
| Google OAuth | Not needed | GitHub Environment secret | `config/.google-token.json` |
| Salesforce | Not needed | GitHub Environment secret | `.env` |
| RH Portal | Not needed | GitHub Environment secret | `.env` + local browser session |
