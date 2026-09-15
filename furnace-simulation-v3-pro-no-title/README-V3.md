# Furnace Simulation V3 PRO — Enhanced UI

Industrial GTK3 client for the UNS OpenHub furnace simulation runtime.

## Highlights
- Professional dark industrial interface
- SIJ Acroni branding in the main, furnace and warehouse windows
- Refined Furnace Control window with production order, live process image and station status
- Refined Warehouse window with search, inventory table and furnace handoff
- No emoji icons on Furnace / OpenHub Login controls
- Existing runtime, OpenHub, RTT and production functionality preserved

## Install on Ubuntu/Linux

Download the single `Furnace-Simulation-Installer.run` file from the GitHub
release, mark it as executable if your file manager does not do so, then
double-click it and choose **Run**. The installer requests administrator
authorization, installs Python, GTK/PyGObject, Podman, Podman Compose and the
desktop integration packages, then installs the application in
`/opt/furnace-simulation`.

If double-clicking is disabled by your desktop environment, run:

```bash
chmod +x Furnace-Simulation-Installer.run
./Furnace-Simulation-Installer.run
```

The installer is safe to run again. It upgrades application files but preserves
`.env`, legacy `.secrets`, the controller `config.json`, the saved OpenHub
session in `~/.config/furnace-simulation`, and Podman's existing databases and
volumes. New runtime placeholder secrets are stored per user in
`~/.local/share/furnace-simulation/openhub-secrets`, not in `/opt`.
The release installer contains no `.env`, `.secrets`, OpenHub credentials,
tokens, or API keys. A fresh installation receives safe local defaults and the
bundled `uns` OpenHub setup tool.

After installation, double-click **Furnace Simulation** on the desktop or
launch it from the desktop application menu. The application first opens the
OpenHub login dialog. After successful login, choose **START RUNTIME** to
start or reuse the OpenHub runtime and `rtt-demo-app` v6.1.12. The login button
then becomes **OPENHUB LOGOUT**. Credentials are used only for the login
request; the app stores an access token in the current user's configuration
directory.

## Building the downloadable installer

From a clean checked-out project directory:

```bash
cd furnace-simulation-v3-pro-no-title
./build-installer.sh
```

Upload the generated `Furnace-Simulation-Installer.run` as the single GitHub
release download. The build script packages only Git-tracked files, so ignored
`.env` and `.secrets` files cannot be included.

## Start from a development checkout
Double-click `furnace-simulation-v3` (or its matching `furnace-simulation-v3.desktop`
launcher) to start the application without opening a terminal. The launcher
verifies Python 3 and GTK3 bindings before starting `main-v3.py`.

From a terminal:
```bash
chmod +x furnace-simulation-v3
./furnace-simulation-v3
```

Or directly:
```bash
python3 main-v3.py
```

**OpenHub login required:** Furnace and Warehouse features call authenticated
OpenHub APIs. After the runtime reports READY, use **OPENHUB LOGIN** before
opening Furnace or Warehouse — otherwise those windows will show connection or
authentication errors instead of live data.

## Troubleshooting

### "Connection refused" on OpenHub (port 3200) or the runtime fails to start with "address already in use" on port 1883
This project's compose stack always runs under the fixed project name
`uns-openhub-runtime` (see `PROJECT_NAME` in `main-v3.py`). If `docker-compose.yml`
or `podman-compose` is ever run manually **without** `--project-name uns-openhub-runtime`,
Podman creates a second, differently-named set of containers (for example
`furnace-simulation-v3-pro-no-title-mosquitto-1`) that bind the same host ports
(1883, 8180, 3200, etc.). Those duplicate containers then block the real
`uns-openhub-runtime-*` containers from starting, so the controller never comes
up and the app cannot reach OpenHub.

To fix it:
```bash
# Find what is holding the port
ss -tlnp | grep 1883

# List containers across all project names to spot duplicates
podman ps -a --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'

# Stop and remove only the duplicate/stale project's containers
# (this does not touch uns-openhub-runtime's own volumes or data)
podman stop <stale-container-name>
podman rm <stale-container-name>

# Restart the real stack
podman compose --project-name uns-openhub-runtime -f docker-compose.yml up -d
```
Always start the stack through the app itself, or with the explicit
`--project-name uns-openhub-runtime` flag, to avoid creating duplicate stacks.
