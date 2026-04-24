# Daily Brief Dashboard

A customer intelligence dashboard for Red Hat Account Solution Architects. It aggregates Salesforce bookings, Red Hat Portal cases, and account context into a single daily brief so you can walk into every customer conversation prepared.

## Prerequisites

- **Podman** — install from [podman.io](https://podman.io/docs/installation). On macOS, start the VM once with `podman machine start`.
- **Red Hat offline token** — generate one at [access.redhat.com/management/api](https://access.redhat.com/management/api).

## Quick Start

```bash
curl -fsSL https://github.com/hornjason/daily-brief-dashboard/releases/latest/download/setup.sh -o setup.sh
chmod +x setup.sh
./setup.sh
```

The installer runs preflight checks, pulls the public container image from GHCR, writes a starter `.env`, and brings the dashboard up. When it finishes, open **http://localhost:7777/dashboard/setup** to run the first-time wizard.

### Flags

| Flag | What it does |
|---|---|
| `--doctor` | Run diagnostics only — verifies Podman is running, ports are free, disk and memory meet minimums, and the GHCR image is reachable. Makes no changes. |
| `--dry-run` | Show every command the installer would run without executing anything. |
| `--yes` | Skip confirmation prompts. Useful for scripted installs. |

Run `./setup.sh --doctor` first if you want to confirm your machine is ready before committing to an install.

## Troubleshooting

### Podman machine not running (macOS)

```
Error: cannot connect to Podman socket
```

Fix:
```bash
podman machine start
```

If you have never initialized a machine: `podman machine init && podman machine start`.

### Port 7777 in use

```
Error: bind: address already in use
```

Something else is listening on 7777. Either stop the existing container:
```bash
podman stop pai-dashboard && podman rm pai-dashboard
```

Or change the host port by editing the `PORT` line in `.env` and re-running `./setup.sh`.

### GHCR pull failed

```
Error: failed to pull ghcr.io/hornjason/daily-brief-dashboard:latest
```

The image is public — no GitHub authentication is required. Check:

1. Network connectivity: `curl -I https://ghcr.io`
2. Podman VM has network (macOS): `podman machine ssh -- ping -c1 1.1.1.1`
3. Re-run `./setup.sh --doctor` for a full diagnostic.

## After Setup

The first-time wizard at **http://localhost:7777/dashboard/setup** walks you through:

- Pasting your Red Hat offline token
- Connecting Google Drive (optional — for Salesforce bookings sync)
- Selecting your POD and account list
- Running the first bootstrap scrape

You only need to do this once. After that the dashboard is at **http://localhost:7777/dashboard**.

## Support

Issues and feedback: [open an issue](https://github.com/hornjason/daily-brief-dashboard/issues).
