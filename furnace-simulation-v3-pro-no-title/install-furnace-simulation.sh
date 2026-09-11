#!/bin/sh
# This file is prepended to Furnace-Simulation-Installer.run by build-installer.sh.
set -eu

APP_NAME="Furnace Simulation"
APP_DIR="${FURNACE_INSTALL_DIR:-/opt/furnace-simulation}"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
USER_DESKTOP_DIR="${HOME}/Desktop"
ARCHIVE_MARKER="__FURNACE_SIMULATION_PAYLOAD__"

show_message() {
    title=$1
    message=$2
    printf '%s: %s\n' "$title" "$message" >&2
    if command -v zenity >/dev/null 2>&1; then
        zenity --info --title="$title" --text="$message" 2>/dev/null || true
    fi
}

show_error() {
    title=$1
    message=$2
    printf '%s: %s\n' "$title" "$message" >&2
    if command -v zenity >/dev/null 2>&1; then
        zenity --error --title="$title" --text="$message" 2>/dev/null || true
    fi
}

require_ubuntu() {
    if ! command -v apt-get >/dev/null 2>&1; then
        show_error "$APP_NAME installer" \
            "This installer currently supports Ubuntu and other Debian-based Linux distributions with apt."
        exit 1
    fi
}

run_as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif command -v pkexec >/dev/null 2>&1; then
        pkexec "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        show_error "$APP_NAME installer" \
            "Administrator authorization is required, but neither pkexec nor sudo is available."
        exit 1
    fi
}

install_dependencies() {
    if ! run_as_root apt-get update; then
        show_error "$APP_NAME installer" "Could not refresh Ubuntu package information."
        exit 1
    fi
    if ! run_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
        python3 python3-gi gir1.2-gtk-3.0 podman podman-compose \
        zenity desktop-file-utils xdg-utils; then
        show_error "$APP_NAME installer" \
            "Could not install required packages. Check your internet connection and administrator permissions."
        exit 1
    fi
}

verify_dependencies() {
    missing=""
    command -v python3 >/dev/null 2>&1 || missing="$missing Python 3,"
    command -v podman >/dev/null 2>&1 || missing="$missing Podman,"
    if ! python3 -c 'import gi; gi.require_version("Gtk", "3.0")' >/dev/null 2>&1; then
        missing="$missing GTK/PyGObject,"
    fi
    if ! podman compose version >/dev/null 2>&1 && ! command -v podman-compose >/dev/null 2>&1; then
        missing="$missing Podman Compose,"
    fi
    if [ -n "$missing" ]; then
        show_error "$APP_NAME installer" "Required dependencies are unavailable:$missing"
        exit 1
    fi
}

archive_line=$(awk "/^${ARCHIVE_MARKER}\$/ { print NR + 1; exit }" "$0")
if [ -z "$archive_line" ]; then
    show_error "$APP_NAME installer" "The installer payload is missing or damaged."
    exit 1
fi

require_ubuntu
show_message "$APP_NAME installer" "Installing required Linux packages. Administrator authorization may be requested."
install_dependencies
verify_dependencies

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/furnace-simulation.XXXXXX")
cleanup() {
    rm -rf "$temp_dir"
}
trap cleanup EXIT HUP INT TERM

if ! tail -n +"$archive_line" "$0" | tar -xzf - -C "$temp_dir"; then
    show_error "$APP_NAME installer" "Could not unpack the installation files."
    exit 1
fi

payload_dir="$temp_dir/furnace-simulation-v3-pro-no-title"
if [ ! -f "$payload_dir/main-v3.py" ] || [ ! -x "$payload_dir/uns" ]; then
    show_error "$APP_NAME installer" "The installer payload does not contain a complete Furnace Simulation application."
    exit 1
fi

preserve_dir="$temp_dir/preserve"
mkdir -p "$preserve_dir"
if [ -f "$APP_DIR/.env" ]; then cp -p "$APP_DIR/.env" "$preserve_dir/env"; fi
if [ -f "$APP_DIR/configs/uns-openhub-controller/config.json" ]; then
    mkdir -p "$preserve_dir/config"
    cp -p "$APP_DIR/configs/uns-openhub-controller/config.json" "$preserve_dir/config/config.json"
fi

if ! run_as_root mkdir -p "$APP_DIR" || ! run_as_root cp -a "$payload_dir/." "$APP_DIR/"; then
    show_error "$APP_NAME installer" "Could not install the application into $APP_DIR."
    exit 1
fi
if [ -f "$preserve_dir/env" ]; then run_as_root cp -p "$preserve_dir/env" "$APP_DIR/.env"; else run_as_root cp -p "$APP_DIR/installer/default.env" "$APP_DIR/.env"; fi
if [ -f "$preserve_dir/config/config.json" ]; then
    run_as_root cp -p "$preserve_dir/config/config.json" "$APP_DIR/configs/uns-openhub-controller/config.json"
else
    run_as_root cp -p "$APP_DIR/configs/uns-openhub-controller/config-example.json" \
        "$APP_DIR/configs/uns-openhub-controller/config.json"
fi
run_as_root chmod 755 "$APP_DIR/furnace-simulation-v3" "$APP_DIR/uns"
if [ -d "$APP_DIR/.secrets" ]; then
    run_as_root chmod 700 "$APP_DIR/.secrets"
    run_as_root find "$APP_DIR/.secrets" -type f -exec chmod 600 {} \;
fi

mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/furnace-simulation.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Furnace Simulation
Comment=OpenHub Furnace and HRM control
Exec=$APP_DIR/furnace-simulation-v3
Path=$APP_DIR
Icon=$APP_DIR/furnace-simulation.svg
Terminal=false
Categories=Utility;
StartupNotify=true
EOF
chmod 644 "$DESKTOP_DIR/furnace-simulation.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
if command -v xdg-user-dir >/dev/null 2>&1; then
    detected_desktop_dir=$(xdg-user-dir DESKTOP 2>/dev/null || true)
    if [ -n "$detected_desktop_dir" ]; then
        USER_DESKTOP_DIR=$detected_desktop_dir
    fi
fi
mkdir -p "$USER_DESKTOP_DIR"
cp "$DESKTOP_DIR/furnace-simulation.desktop" "$USER_DESKTOP_DIR/Furnace Simulation.desktop"
chmod 755 "$USER_DESKTOP_DIR/Furnace Simulation.desktop"
if command -v gio >/dev/null 2>&1; then
    gio set "$USER_DESKTOP_DIR/Furnace Simulation.desktop" metadata::trusted true 2>/dev/null || true
fi

show_message "$APP_NAME installed" \
    "Furnace Simulation is installed. Launch it from the applications menu or the Furnace Simulation desktop shortcut. On first launch, OpenHub will start automatically and request your OpenHub login if no saved session is available."
exit 0
__FURNACE_SIMULATION_PAYLOAD__
