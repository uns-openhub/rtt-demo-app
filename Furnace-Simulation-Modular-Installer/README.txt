Furnace Simulation - Modular Windows backend installer

IMPORTANT:
1. This package is designed around the current Furnace Simulation Compose runtime.
2. PostgreSQL, Mosquitto, Caddy and QuestDB are container services in the existing project.
   Do NOT install separate native copies of those services; that can cause port conflicts.
3. The only external dependency this modular installer needs to install is Podman (plus WSL when required).
4. WinGet Podman installation ALWAYS uses --source winget, avoiding the broken msstore lookup seen in the current error.
5. User login is NOT automated by these scripts. The scripts establish/check transport and service readiness;
   the Furnace Simulation GUI should show the OpenHub login and perform authentication.

Run manually:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -PauseOnExit

Individual tests:
01-install-podman.ps1
02-setup-wsl.ps1
03-prepare-runtime.ps1
04-start-services.ps1
05-connect-openhub.ps1
06-connect-uns.ps1
07-health-check.ps1

Main log:
%LOCALAPPDATA%\Furnace Simulation\modular-install.log

Runtime log:
%LOCALAPPDATA%\Furnace Simulation\dependency-install.log

Expected final flow:
Installer
 -> install/check Podman
 -> WSL
 -> prepare runtime.env/secrets
 -> Podman machine
 -> Compose pull/up
 -> OpenHub controller
 -> UNS endpoint
 -> final health check
 -> launch Furnace-Simulation.exe
