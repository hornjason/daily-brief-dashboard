---
doc-type: reference
status: active
owner: jason
updated: 2026-08-20
---

# Google OAuth Setup for Non-Technical Users

An **offline token** is a credential that lets the dashboard access your Gmail, Calendar, and Drive on your behalf without requiring you to log in every time.

---

## Option 1: Setup Wizard (Recommended)

**Easiest path** — the web UI handles everything for you.

1. Start the dashboard: `make up` (or ask Jason to start it for you)
2. Open your browser to: `http://localhost:7777/dashboard/setup`
3. Click **"Authorize Google Account"**
4. Sign in with your @redhat.com Google account
5. Click **"Allow"** when Google asks for permissions (Gmail, Calendar, Drive)
6. The wizard saves your token automatically — you're done

**Verify it works:**
- Refresh the dashboard at `http://localhost:7777`
- You should see email highlights, calendar events, and Drive files
- If the page shows "No data", wait 30 seconds and refresh (first sync takes time)

---

## Option 2: Manual Token Setup

If the wizard doesn't work or you're setting up a remote machine:

1. **Get the token file** — use the setup wizard on any machine with a browser:
   - Start the container: `podman run -d -p 7777:7777 --name daily-brief ghcr.io/hornjason/daily-brief-dashboard:latest`
   - Open `http://localhost:7777/dashboard/setup` and click "Authorize Google Account"
   - Complete sign-in — the token file saves to `data/config/.google-token.json`

2. **Copy the token to a remote machine** (if needed):
   ```bash
   podman cp daily-brief:/data/config/.google-token.json ./
   scp .google-token.json <remote-machine>:~/daily-brief/data/config/
   ```

3. **Restart the remote container** to pick up the token:
   ```bash
   make restart
   ```

**Verify it works:**
- Visit `http://localhost:7777` — you should see live data from Gmail, Calendar, and Drive

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Token not found" error | Run the setup wizard again or check that `data/config/.google-token.json` exists |
| "Invalid credentials" | Token expired — delete `.google-token.json` and re-authorize via wizard |
| Dashboard shows no data after 2 minutes | Check container logs: `make logs` — look for "Auth error" or "Rate limit" |
| Can't access localhost:7777 | Container may not be running — run `make up` |
| Browser can't reach Google during setup | Check your network — corporate VPN may block OAuth flow |

---

## If This Is Too Complex

Two easier alternatives:

1. **Ask Jason to pre-generate your token** — he runs the setup, gives you a ready-to-use config file, you just run `make up`
2. **Use the hosted instance** — Jason can run a shared dashboard that multiple team members access (no local setup needed)

Both options skip all OAuth steps — you just use the dashboard with a bookmark.

---

## Technical Notes (Optional Reading)

- **Token location in container:** `/data/config/.google-token.json` (maps to host `./data/config/`)
- **Scopes requested:** Gmail read, Calendar read, Drive read/write (uploads account plans to Drive)
- **Token expiration:** Refresh tokens are long-lived but may expire if unused for 6+ months
- **Security:** Keep `.google-token.json` private — it grants full read access to your Google account
- **Rotation:** To rotate, delete the token file and re-authorize via the wizard
