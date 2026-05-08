# Daily Brief Dashboard

A customer intelligence dashboard for Red Hat Account Solution Architects. It aggregates Salesforce bookings, Red Hat Portal cases, and account context into a single daily brief so you can walk into every customer conversation prepared.

## Prerequisites

### Install Podman

**macOS:**
```bash
brew install podman
podman machine init
podman machine set --memory 4096  # 4GB minimum required
podman machine start
```

**Ubuntu / Debian:**
```bash
sudo apt update
sudo apt install -y podman
```

**RHEL / Fedora:**
```bash
sudo dnf install -y podman
```

**Other Linux distributions:** See [podman.io/docs/installation](https://podman.io/docs/installation)

### System Requirements

- **RAM:** 4GB minimum (8GB recommended)
- **Disk:** 5GB free space
- **CPU:** 2+ cores recommended

### Red Hat Portal Access

You'll need a Red Hat offline token during setup. Generate one at [access.redhat.com/management/api](https://access.redhat.com/management/api) before running the installer.

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/hornjason/daily-brief-dashboard/main/setup.sh | bash
```

The installer runs preflight checks, pulls the public container image from GHCR, writes a starter `.env`, and brings the dashboard up. When it finishes, open **http://localhost:7777/dashboard/setup** to run the first-time wizard.

> **Prefer to inspect before running?**
> ```bash
> curl -fsSL https://raw.githubusercontent.com/hornjason/daily-brief-dashboard/main/setup.sh -o setup.sh
> 
> bash setup.sh --dry-run   # narrate every step without making changes
> bash setup.sh             # run for real
> ```

### Flags

| Flag | What it does |
|---|---|
| `--doctor` | Run diagnostics only — verifies Podman is running, ports are free, disk and memory meet minimums, and the GHCR image is reachable. Makes no changes. |
| `--dry-run` | Show every command the installer would run without executing anything. |
| `--yes` | Skip confirmation prompts. Useful for scripted installs. |

## Troubleshooting

### Podman machine not running (macOS)

```
Error: cannot connect to Podman socket
```

Fix:
```bash
podman machine start
```

If you have never initialized a machine: 
```bash
podman machine init
podman machine set --memory 4096
podman machine start
```

### Podman machine RAM too low (macOS)

```
✗ Podman machine RAM: 2048MB — minimum required is 4096MB (4GB).
```

The container needs 4GB minimum (uses 2GB for shared memory alone). Fix:
```bash
podman machine stop
podman machine set --memory 4096
podman machine start
```

Then re-run `./setup.sh`.

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

---

## For Maintainers

**Release artifacts** (setup.sh, .env.example, docker-compose.yml) are kept in sync with this README and the container image. When updating prerequisites or system requirements:

1. Update setup.sh preflight checks (MIN_*_MB constants, check_* functions)
2. Update .env.example with any new required variables
3. Update docker-compose.yml ports, volumes, resource limits
4. Update this README Prerequisites section to match
5. Rebuild and publish the container image with matching version tags

This ensures users installing from different entry points (curl | bash, docker-compose, manual podman run) all get consistent documentation and validated prerequisites.
