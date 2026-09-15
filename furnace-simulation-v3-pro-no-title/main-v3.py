#!/usr/bin/python3
import os
import json
import re
import shutil
import subprocess
import threading
import http.cookies
import hashlib
import hmac
import secrets
from datetime import datetime
import urllib.error
import urllib.request

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf, GLib, Gtk


SERVICES = ("postgres", "mosquitto", "caddy", "questdb", "uns-openhub-controller")
PROJECT_NAME = "uns-openhub-runtime"
OPENHUB_GRAPHQL_URL = "http://127.0.0.1:3200/graphql"
HRM_API_BASE = "http://127.0.0.1:3200/api/system/hrm/service/rtt-demo-app"
RTT_NODE = "rtt-demo-app"
RTT_VERSION = "6.1.12"
APP_VERSION = "3.0"


class FurnaceSimulation(Gtk.Window):
    def __init__(self):
        super().__init__(title="Furnace Simulation")
        self.set_default_size(820, 620)
        self.set_border_width(18)
        self.app_dir = os.path.dirname(os.path.realpath(__file__))
        self.compose = self.find_compose()
        self.status_labels = {}
        self.last_status_values = {}
        self.log_lines = []
        self.runtime_started_by_app = False
        self.rtt_started_by_app = False
        self.rtt_instance_id = None
        self.rtt_version = RTT_VERSION
        self.rtt_api_ready = False
        self.available_recipe_ids = []
        self.furnace_window = None
        self.furnace_refresh_source = None
        self.warehouse_window = None
        self.warehouse_refresh_source = None
        self.furnace_status_labels = {}
        self.production_status_label = None
        self.warehouse_store = None
        self.warehouse_filter = None
        self.warehouse_tree = None
        self.warehouse_rows = {}
        self.warehouse_selected_rows = {}
        self.warehouse_footer = None
        self.login_dialog = None
        self.timeline_view = None
        self.session_label = None
        self.timeline_events = []
        self.timeline_started_at = None
        self.timeline_stopped_at = None
        self.session_active = False
        self.clock_label = None
        self.furnace_running = False
        self.furnace_material_active = False
        self.furnace_heating = False
        self._furnace_frame_is_ready = False
        self.furnace_drawing = None
        self.furnace_images = {}
        self.furnace_green = None
        self.furnace_red = None
        self.furnace_animation_source = None
        self.furnace_animation_phase = 0
        self.openhub_logged_in = False
        self.loto_active = False
        self.loto_worker_name = None
        self.loto_password_salt = None
        self.loto_password_hash = None
        self.loto_window = None
        self.openhub_token_path = os.path.join(
            os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")),
            "furnace-simulation", "openhub-token",
        )
        self.loto_state_path = os.path.join(
            os.path.dirname(self.openhub_token_path), "loto-session.json"
        )
        self.load_loto_session()
        icon_path = os.path.join(self.app_dir, "Furnice-simulator-icon.png")
        if os.path.isfile(icon_path):
            self.set_icon_from_file(icon_path)
        self.build_ui()
        self.refresh_status()
        if self.loto_active:
            GLib.idle_add(self.show_loto_screen)
        else:
            GLib.idle_add(self.request_openhub_login)

    @staticmethod
    def command_ok(command):
        try:
            return subprocess.run(
                command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=False, timeout=10
            ).returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    def find_compose(self):
        if self.command_ok(("podman", "compose", "version")):
            return ("podman", "compose")
        if self.command_ok(("podman-compose", "--version")):
            return ("podman-compose",)
        return None

    def _style_ui(self):
        css = Gtk.CssProvider()
        css.load_from_data(b"""
        window, .furnace-app { background: #101418; color: #e8edf2; }
        .header-title { color: #f4f7f9; font-size: 24px; font-weight: 800; letter-spacing: 1px; }
        .subtitle { color: #8e9aa6; font-size: 12px; }
        frame.section { border: 1px solid #2b353e; border-radius: 8px; }
        frame.section > label { color: #b9c4cd; font-weight: 800; }
        button { min-height: 36px; border-radius: 6px; }
        button.primary { background: #1677ff; color: #ffffff; font-weight: 800; }
        button.primary:hover { background: #3187ff; }
        button.danger { background: #a93226; color: #ffffff; font-weight: 800; }
        button.danger:hover { background: #c0392b; }
        button.action { background: #202a33; color: #e7edf2; font-weight: 700; }
        button.action:hover { background: #2a3742; }
        label.status-ok { color: #42d392; font-weight: 800; }
        label.status-bad { color: #ff6b6b; font-weight: 800; }
        label.status-wait { color: #f0b429; font-weight: 800; }
        label.status-neutral { color: #9aa7b3; }
        #main_title { color: #f4f7f9; font-size: 25px; font-weight: 800; letter-spacing: 1px; }
        #subtitle { color: #8e9aa6; font-size: 12px; }
        #clock_label { color: #d9e1e7; font-weight: 700; }
        #ready_label { color: #c7d0d8; font-weight: 700; }
        #ready_dot { color: #f0b429; font-size: 16px; }
        textview, treeview { background: #0b0f12; color: #d7e0e6; }
        entry { background: #171e24; color: #eef3f6; border-color: #34414b; min-height: 34px; }
        combobox { background: #171e24; color: #eef3f6; }
        frame { border-color: #2b353e; border-radius: 8px; }
        frame > label { color: #aeb9c3; font-weight: 800; }
        treeview { -GtkTreeView-horizontal-separator: 8; -GtkTreeView-vertical-separator: 7; }
        label.panel-value { color: #eef3f6; font-weight: 700; }
        label.window-subtitle { color: #8e9aa6; font-size: 12px; }
        button.secondary { background: #202a33; color: #e7edf2; font-weight: 700; }
        #industrial_title { color: #f4f7f9; font-size: 19px; font-weight: 800; }
        #light_indicator_title { color: #8e9aa6; font-size: 11px; font-weight: 800; }
        #furnace_green, #furnace_red { font-weight: 800; padding: 8px; }
        """)
        Gtk.StyleContext.add_provider_for_screen(
            self.get_screen(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

    def _set_logo(self, builder, max_width=190, max_height=55):
        image = builder.get_object("logo_image")
        if image is None:
            return
        path = os.path.join(self.app_dir, "sij_acroni_logo.png")
        if not os.path.isfile(path):
            return
        try:
            pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, max_width, max_height, True)
            image.set_from_pixbuf(pixbuf)
        except Exception:
            pass

    def _load_main_ui(self):
        builder = Gtk.Builder()
        path = os.path.join(self.app_dir, "main-v3.ui")
        builder.add_from_file(path)
        required = [
            "main_root", "clock_label", "ready_label", "start_button", "stop_button",
            "open_button", "warehouse_button", "uns_button", "auth_button",
            "service_button",
            "timeline_view", "log_view", "session_label",
        ]
        required += [
            "status_" + re.sub(r"[^A-Za-z0-9]", "_", name).strip("_")
            for name in ("Podman", "Configuration", "OpenHub authentication", *SERVICES,
                         "rtt-demo-app", "OpenHub", "Controller health", "Web interface")
        ]
        missing = [name for name in required if builder.get_object(name) is None]
        if missing:
            raise RuntimeError("main-v3.ui is missing widgets: " + ", ".join(missing))
        return builder

    def _build_main_fallback(self):
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        root.set_margin_top(20); root.set_margin_bottom(20); root.set_margin_start(20); root.set_margin_end(20)
        header = Gtk.Box(spacing=16)
        title_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
        title = Gtk.Label(label="FURNACE SIMULATION", xalign=0)
        title.set_name("main_title")
        subtitle = Gtk.Label(label="Industrial OpenHub runtime control & monitoring", xalign=0)
        subtitle.set_name("subtitle")
        title_box.pack_start(title, False, False, 0); title_box.pack_start(subtitle, False, False, 0)
        header.pack_start(title_box, True, True, 0)
        self.clock_label = Gtk.Label(label="--", xalign=0.5)
        header.pack_end(self.clock_label, False, False, 0)
        root.pack_start(header, False, False, 0)
        frame = Gtk.Frame(label="RUNTIME STATUS")
        grid = Gtk.Grid(column_spacing=28, row_spacing=8, margin=14)
        frame.add(grid)
        names=("Podman", "Configuration", "OpenHub authentication", *SERVICES, "rtt-demo-app", "OpenHub", "Controller health", "Web interface")
        for i,name in enumerate(names):
            col=(i//6)*2; row=i%6
            n=Gtk.Label(label=name, xalign=0); v=Gtk.Label(label="CHECKING", xalign=0)
            grid.attach(n,col,row,1,1); grid.attach(v,col+1,row,1,1)
            self.status_labels[name]=v
        root.pack_start(frame, False, False, 0)
        self.ready_label=Gtk.Label(label="Ready to start.", xalign=0); root.pack_start(self.ready_label, False, False, 0)
        controls=Gtk.Box(spacing=10)
        for attr,label,cb in (("start_button","▶  START RUNTIME",self.start_runtime),("stop_button","■  STOP RUNTIME",self.stop_runtime),("open_button","FURNACE",self.open_furnace),("warehouse_button","▣  WAREHOUSE",self.open_warehouse),("uns_button","◈  OPEN UNS",self.open_uns),("auth_button","OPENHUB LOGIN",self.configure_authentication),("service_button","SERVICE",self.start_loto_service)):
            b=Gtk.Button(label=label); setattr(self,attr,b); b.connect("clicked",cb); controls.pack_start(b,True,True,0)
        root.pack_start(controls, False, False, 0)
        tf=Gtk.Frame(label="STARTUP TIMELINE"); tc=Gtk.Box(orientation=Gtk.Orientation.VERTICAL,spacing=8,margin=10); tf.add(tc)
        ts=Gtk.ScrolledWindow(); ts.set_size_request(-1,125); self.timeline_view=Gtk.TextView(editable=False,monospace=True); ts.add(self.timeline_view); tc.pack_start(ts,True,True,0)
        self.session_label=Gtk.Label(label="Started: --\nStopped: --\nRuntime duration: --",xalign=0); tc.pack_start(self.session_label,False,False,0); root.pack_start(tf,False,False,0)
        lf=Gtk.Frame(label="DIAGNOSTICS"); ls=Gtk.ScrolledWindow(); ls.set_size_request(-1,180); self.log_view=Gtk.TextView(editable=False,monospace=True); ls.add(self.log_view); lf.add(ls); root.pack_start(lf,True,True,0)
        # Authentication is applied after the fallback controls are constructed.
        self.open_button.set_sensitive(True); self.warehouse_button.set_sensitive(True); self.uns_button.set_sensitive(True)
        return root

    def build_ui(self):
        self._style_ui()
        try:
            builder = self._load_main_ui()
            self._ui_builder = builder
            self._set_logo(builder, 190, 55)
            root = builder.get_object("main_root")
            self.add(root)
            root.get_style_context().add_class("furnace-app")
            self.clock_label = builder.get_object("clock_label")
            self.ready_label = builder.get_object("ready_label")
            self.start_button = builder.get_object("start_button")
            self.stop_button = builder.get_object("stop_button")
            self.open_button = builder.get_object("open_button")
            self.warehouse_button = builder.get_object("warehouse_button")
            self.uns_button = builder.get_object("uns_button")
            self.auth_button = builder.get_object("auth_button")
            self.service_button = builder.get_object("service_button")
            self.timeline_view = builder.get_object("timeline_view")
            self.log_view = builder.get_object("log_view")
            self.session_label = builder.get_object("session_label")
            self.status_labels = {}
            for name in ("Podman", "Configuration", "OpenHub authentication", *SERVICES,
                         "rtt-demo-app", "OpenHub", "Controller health", "Web interface"):
                sid = "status_" + re.sub(r"[^A-Za-z0-9]", "_", name).strip("_")
                label = builder.get_object(sid)
                self.status_labels[name] = label
                label.get_style_context().add_class("status-wait")
            for frame_name in ("runtime_frame", "timeline_frame", "diagnostics_frame"):
                frame = builder.get_object(frame_name)
                if frame: frame.get_style_context().add_class("section")
        except Exception as error:
            # Never crash because of a presentation-layer UI file.
            root = self._build_main_fallback()
            self._ui_builder = None
            self.add(root)
            self._ui_fallback_error = str(error)

        self.start_button.get_style_context().add_class("primary")
        self.stop_button.get_style_context().add_class("danger")
        for button in (self.open_button, self.warehouse_button, self.uns_button, self.auth_button, self.service_button):
            button.get_style_context().add_class("action")
        self.start_button.connect("clicked", self.start_runtime)
        self.stop_button.connect("clicked", self.stop_runtime)
        self.open_button.connect("clicked", self.open_furnace)
        self.warehouse_button.connect("clicked", self.open_warehouse)
        self.uns_button.connect("clicked", self.open_uns)
        self.auth_button.connect("clicked", self.configure_authentication)
        self.service_button.connect("clicked", self.start_loto_service)
        self.connect("destroy", Gtk.main_quit)
        GLib.timeout_add_seconds(1, self.update_clock)
        # Furnace and Warehouse use authenticated OpenHub APIs.
        self.open_button.set_sensitive(False)
        self.warehouse_button.set_sensitive(False)
        self.uns_button.set_sensitive(True)
        self.stop_button.set_sensitive(False)
        if self.loto_active:
            self.apply_loto_controls()
        if getattr(self, "_ui_fallback_error", None):
            self.log_lines.append("[WARNING] " + self._ui_fallback_error + "; built-in safe UI was used.")

    def update_clock(self):
        if self.clock_label is not None:
            self.clock_label.set_text(datetime.now().strftime("%d.%m.%Y\n%H:%M:%S"))
        self.update_session_label()
        return True

    def timeline_event(self, name, state):
        now = datetime.now()
        self.timeline_events.append((now, name, state))
        self.timeline_events = self.timeline_events[-100:]
        if self.timeline_view is not None:
            buffer_ = self.timeline_view.get_buffer()
            buffer_.set_text("\n".join(
                f"{when:%H:%M:%S}  {event:<24} {value}"
                for when, event, value in self.timeline_events
            ) + "\n")
        self.update_session_label()

    def update_session_label(self):
        if self.session_label is None:
            return
        started = self.timeline_started_at
        stopped = self.timeline_stopped_at
        duration = (stopped or datetime.now()) - started if started else None
        duration_text = str(duration).split(".", 1)[0] if duration else "--"
        self.session_label.set_text(
            (f"Started: {started:%H:%M:%S}" if started else "Started: --")
            + "\n"
            + (f"Stopped: {stopped:%H:%M:%S}" if stopped else "Stopped: --")
            + "\n"
            + f"Runtime duration: {duration_text}"
        )

    @staticmethod
    def button(label, callback):
        button = Gtk.Button(label=label)
        button.connect("clicked", callback)
        return button

    def append_log(self, text):
        def update():
            for line in text.splitlines():
                if line and (not self.log_lines or self.log_lines[-1] != line):
                    self.log_lines.append(line)
            self.log_lines = self.log_lines[-300:]
            buffer_ = self.log_view.get_buffer()
            buffer_.set_text("\n".join(self.log_lines) + ("\n" if self.log_lines else ""))
            mark = buffer_.create_mark(None, buffer_.get_end_iter(), False)
            self.log_view.scroll_to_mark(mark, 0.0, True, 0.0, 1.0)
            return False
        GLib.idle_add(update)

    def set_status(self, name, value, ok=None):
        def update():
            label = self.status_labels[name]
            label.set_text(value)
            if self.last_status_values.get(name) != value:
                self.last_status_values[name] = value
                self.timeline_event(name, value)
            for css_class in ("success", "error", "status-ok", "status-bad", "status-wait"):
                label.get_style_context().remove_class(css_class)
            if ok is True:
                label.get_style_context().add_class("status-ok")
            elif ok is False:
                label.get_style_context().add_class("status-bad")
            else:
                label.get_style_context().add_class("status-wait")
            return False
        GLib.idle_add(update)

    def load_loto_session(self):
        try:
            with open(self.loto_state_path, "r", encoding="utf-8") as handle:
                session = json.load(handle)
            worker_name = session["workerName"]
            password_salt = bytes.fromhex(session["passwordSalt"])
            password_hash = bytes.fromhex(session["passwordHash"])
            if (not isinstance(worker_name, str) or not worker_name.strip()
                    or len(password_salt) < 16 or len(password_hash) != 32):
                raise ValueError("invalid LOTO session data")
        except FileNotFoundError:
            return
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise RuntimeError("The saved LOTO session could not be read safely.") from error
        self.loto_active = True
        self.loto_worker_name = worker_name.strip()
        self.loto_password_salt = password_salt
        self.loto_password_hash = password_hash

    def save_loto_session(self):
        directory = os.path.dirname(self.loto_state_path)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
        session = {
            "workerName": self.loto_worker_name,
            "passwordSalt": self.loto_password_salt.hex(),
            "passwordHash": self.loto_password_hash.hex(),
        }
        temporary_path = self.loto_state_path + ".tmp"
        descriptor = os.open(
            temporary_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(session, handle, separators=(",", ":"))
        os.replace(temporary_path, self.loto_state_path)
        os.chmod(self.loto_state_path, 0o600)

    @staticmethod
    def loto_password_verifier(password, salt):
        return hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, 600_000
        )

    def apply_loto_controls(self):
        if self.loto_active:
            for button in (
                self.start_button, self.stop_button, self.open_button,
                self.warehouse_button, self.uns_button, self.auth_button,
                self.service_button,
            ):
                button.set_sensitive(False)
            return
        self.start_button.set_sensitive(True)
        self.stop_button.set_sensitive(self.session_active)
        self.open_button.set_sensitive(self.openhub_logged_in)
        self.warehouse_button.set_sensitive(self.openhub_logged_in)
        self.uns_button.set_sensitive(True)
        self.auth_button.set_sensitive(True)
        self.service_button.set_sensitive(True)

    def loto_allows_operation(self):
        if not self.loto_active:
            return True
        self.show_loto_screen()
        return False

    def start_loto_service(self, *_args):
        if self.loto_active:
            self.show_loto_screen()
            return
        dialog = Gtk.Dialog(title="SERVICE / LOTO", transient_for=self, flags=0)
        dialog.add_button("CANCEL", Gtk.ResponseType.CANCEL)
        dialog.add_button("DONE / START SERVICE", Gtk.ResponseType.OK)
        content = dialog.get_content_area()
        content.set_spacing(8)
        content.set_border_width(14)
        worker_entry = Gtk.Entry()
        worker_entry.set_placeholder_text("Maintenance Name / Username")
        password_entry = Gtk.Entry()
        password_entry.set_visibility(False)
        password_entry.set_invisible_char("*")
        password_entry.set_placeholder_text("LOTO Password")
        message = Gtk.Label(xalign=0)
        content.pack_start(Gtk.Label(label="Maintenance Name:", xalign=0), False, False, 0)
        content.pack_start(worker_entry, False, False, 0)
        content.pack_start(Gtk.Label(label="LOTO Password:", xalign=0), False, False, 0)
        content.pack_start(password_entry, False, False, 0)
        content.pack_start(message, False, False, 0)
        dialog.set_default_response(Gtk.ResponseType.OK)
        dialog.show_all()
        while dialog.run() == Gtk.ResponseType.OK:
            worker_name = worker_entry.get_text().strip()
            password = password_entry.get_text()
            if worker_name and password:
                dialog.destroy()
                self.loto_worker_name = worker_name
                self.loto_password_salt = secrets.token_bytes(16)
                self.loto_password_hash = self.loto_password_verifier(
                    password, self.loto_password_salt
                )
                self.loto_active = True
                self.save_loto_session()
                self.close_secondary_windows()
                self.apply_loto_controls()
                self.show_loto_screen()
                return
            message.set_text(
                "Invalid LOTO password. Maintenance mode was not activated."
            )
            password_entry.set_text("")
        dialog.destroy()

    def show_loto_screen(self):
        if not self.loto_active:
            return
        if self.loto_window is not None:
            self.loto_window.show_all()
            self.loto_window.present()
            return
        window = Gtk.Window(title="MAINTENANCE MODE", transient_for=self)
        window.set_modal(True)
        window.set_default_size(620, 390)
        window.set_border_width(30)
        window.connect("delete-event", lambda *_args: True)
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18)
        root.get_style_context().add_class("furnace-app")
        title = Gtk.Label()
        title.set_markup(
            "<span size='xx-large' weight='bold' foreground='#ff6b6b'>"
            "MAINTENANCE MODE</span>"
        )
        loto = Gtk.Label()
        loto.set_markup(
            "<span size='x-large' weight='bold' foreground='#f0b429'>"
            "LOTO ACTIVE</span>"
        )
        locked = Gtk.Label()
        locked.set_markup(
            "<span size='large' weight='bold'>PRODUCTION CONTROLS LOCKED</span>"
        )
        worker = Gtk.Label(xalign=0.5)
        worker.set_markup(
            "<span size='large'>Maintenance: "
            + GLib.markup_escape_text(self.loto_worker_name or "Unknown")
            + "</span>"
        )
        message = Gtk.Label(
            label="Equipment is under maintenance.", xalign=0.5
        )
        unlock = Gtk.Button(label="UNLOCK / FINISH SERVICE")
        unlock.get_style_context().add_class("primary")
        unlock.connect("clicked", self.request_loto_unlock)
        for widget in (title, loto, locked, worker, message, unlock):
            root.pack_start(widget, False, False, 0)
        window.add(root)
        self.loto_window = window
        window.show_all()
        window.present()

    def request_loto_unlock(self, *_args):
        dialog = Gtk.Dialog(
            title="FINISH MAINTENANCE", transient_for=self.loto_window, flags=0
        )
        dialog.add_button("CANCEL", Gtk.ResponseType.CANCEL)
        dialog.add_button("UNLOCK", Gtk.ResponseType.OK)
        content = dialog.get_content_area()
        content.set_spacing(8)
        content.set_border_width(14)
        password_entry = Gtk.Entry()
        password_entry.set_visibility(False)
        password_entry.set_invisible_char("*")
        password_entry.set_placeholder_text("LOTO Password")
        message = Gtk.Label(xalign=0)
        content.pack_start(
            Gtk.Label(label=f"Maintenance: {self.loto_worker_name}", xalign=0),
            False, False, 0,
        )
        content.pack_start(Gtk.Label(label="LOTO Password:", xalign=0), False, False, 0)
        content.pack_start(password_entry, False, False, 0)
        content.pack_start(message, False, False, 0)
        dialog.set_default_response(Gtk.ResponseType.OK)
        dialog.show_all()
        while dialog.run() == Gtk.ResponseType.OK:
            candidate_hash = self.loto_password_verifier(
                password_entry.get_text(), self.loto_password_salt
            )
            if hmac.compare_digest(candidate_hash, self.loto_password_hash):
                dialog.destroy()
                self.clear_loto_session()
                return
            message.set_text("Incorrect LOTO password. Maintenance mode remains active.")
            password_entry.set_text("")
        dialog.destroy()

    def clear_loto_session(self):
        try:
            os.remove(self.loto_state_path)
        except FileNotFoundError:
            pass
        self.loto_active = False
        self.loto_worker_name = None
        self.loto_password_salt = None
        self.loto_password_hash = None
        if self.loto_window is not None:
            self.loto_window.destroy()
            self.loto_window = None
        self.apply_loto_controls()
        self.present()

    def configure_authentication(self, *_args):
        if not self.loto_allows_operation():
            return
        if self.openhub_logged_in:
            self.logout_openhub()
            return
        threading.Thread(target=self.login_worker, daemon=True).start()

    def request_openhub_login(self):
        self.configure_authentication()
        return False

    def set_openhub_login_state(self, logged_in):
        self.openhub_logged_in = logged_in
        self.auth_button.set_label(
            "OPENHUB LOGOUT" if logged_in else "OPENHUB LOGIN"
        )
        if self.loto_active:
            self.apply_loto_controls()
            return False
        self.open_button.set_sensitive(logged_in)
        self.warehouse_button.set_sensitive(logged_in)
        return False

    def logout_openhub(self):
        for path in (self.openhub_token_path, self.refresh_cookie_path):
            try:
                os.remove(path)
            except FileNotFoundError:
                continue
            except OSError as error:
                self.report_error("Could not clear the saved OpenHub session: " + str(error))
                return
        self.rtt_api_ready = False
        self.set_status("OpenHub authentication", "REQUIRED", False)
        self.ready_label.set_markup(
            "<span size='large' weight='bold' foreground='#b42318'>OPENHUB LOGIN REQUIRED</span>"
        )
        self.append_log("[INFO] OpenHub session logged out.")
        self.set_openhub_login_state(False)

    def run_compose(self, *args, timeout=60):
        if self.loto_active and args and args[0] in (
            "up", "down", "start", "stop", "restart"
        ):
            raise RuntimeError("LOTO is active. Runtime changes are locked.")
        if not self.compose:
            raise RuntimeError("Podman Compose is not installed.")
        command = (*self.compose, "--project-name", PROJECT_NAME,
                   "-f", os.path.join(self.app_dir, "docker-compose.yml"), *args)
        return subprocess.run(
            command, cwd=self.app_dir, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, check=False, timeout=timeout
        )

    def validate_files(self):
        required = (".env", "docker-compose.yml",
                    "configs/uns-openhub-controller/config.json")
        missing = [path for path in required
                   if not os.path.isfile(os.path.join(self.app_dir, path))]
        if missing:
            raise RuntimeError("Missing required configuration: " + ", ".join(missing))

    def ensure_secret_files(self):
        secrets_dir = os.path.join(self.app_dir, ".secrets")
        required = ("infisical_token", "infisical_project_id", "infisical_site_url")
        os.makedirs(secrets_dir, mode=0o700, exist_ok=True)
        setup_tool = os.path.join(self.app_dir, "uns")
        if not os.access(setup_tool, os.X_OK):
            raise RuntimeError("The bundled local OpenHub setup tool is missing.")
        try:
            result = subprocess.run(
                (setup_tool, "dummy-secrets", "--dir", secrets_dir),
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                text=True, check=False, timeout=15,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise RuntimeError("The local OpenHub secret setup could not run: " + str(error)) from error
        if result.returncode:
            raise RuntimeError("The local OpenHub secret setup could not create its required files.")
        for name in required:
            path = os.path.join(secrets_dir, name)
            if not os.path.isfile(path) or os.path.getsize(path) == 0:
                raise RuntimeError("The local OpenHub secret setup is incomplete.")
            os.chmod(path, 0o600)
        os.chmod(secrets_dir, 0o700)

    def ensure_podman_service(self):
        socket_path = os.path.join(
            os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"),
            "podman", "podman.sock",
        )
        os.environ["DOCKER_HOST"] = "unix://" + socket_path
        if os.path.exists(socket_path):
            return
        os.makedirs(os.path.dirname(socket_path), mode=0o700, exist_ok=True)
        try:
            subprocess.run(
                ("systemctl", "--user", "start", "podman.socket"),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=False, timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            pass
        if not os.path.exists(socket_path):
            try:
                subprocess.Popen(
                    ("podman", "system", "service", "--time=0", "unix://" + socket_path),
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except OSError as error:
                raise RuntimeError("Podman could not start its user service: " + str(error)) from error
        for _ in range(50):
            if os.path.exists(socket_path):
                return
            threading.Event().wait(0.1)
        raise RuntimeError("Podman service did not create its user socket.")

    def runtime_is_running(self):
        if self.openhub_api_ready() and \
                self.http_ready("http://127.0.0.1:8180"):
            return True
        try:
            result = subprocess.run(
                ("podman", "ps", "--filter",
                 "label=com.docker.compose.project=" + PROJECT_NAME,
                 "--format", "{{.Names}}"),
                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                check=False, timeout=10,
            )
            return result.returncode == 0 and bool(result.stdout.splitlines())
        except (OSError, subprocess.SubprocessError):
            return False

    @staticmethod
    def compose_error(output):
        lines = [line.strip() for line in output.splitlines() if line.strip()]
        if any("address already in use" in line.lower() for line in lines):
            return (
                "The OpenHub runtime could not start because a required host port "
                "is already in use. Stop the conflicting service or change the "
                "port mapping in docker-compose.yml."
            )
        return "The OpenHub runtime could not start: " + (
            lines[-1] if lines else "no diagnostic output was returned"
        )

    def start_runtime(self, *_args):
        if not self.loto_allows_operation():
            return
        if not self.openhub_logged_in:
            self.request_openhub_login()
            return
        self.start_button.set_sensitive(False)
        self.stop_button.set_sensitive(True)
        self.session_active = True
        self.timeline_started_at = datetime.now()
        self.timeline_stopped_at = None
        self.timeline_events = []
        self.timeline_event("Furnace Simulation", "STARTING")
        threading.Thread(target=self.start_worker, daemon=True).start()

    def start_worker(self):
        try:
            if not self.compose:
                raise RuntimeError("Podman Compose is not installed.")
            self.set_status("Podman", "READY", True)
            self.ensure_podman_service()
            self.validate_files()
            self.ensure_secret_files()
            self.set_status("Configuration", "READY", True)
            if self.runtime_is_running():
                self.append_log("[INFO] Existing uns-openhub-runtime detected; reusing it.")
            else:
                result = self.run_compose("up", "-d", timeout=180)
                self.append_log(result.stdout)
                if result.returncode:
                    raise RuntimeError(self.compose_error(result.stdout))
                self.runtime_started_by_app = True
            self.wait_until_ready(mark_ready=False)
            self.ensure_authentication()
            self.ensure_furnace_api_ready()
            self.wait_until_ready()
        except Exception as error:
            self.report_error(self.user_facing_error(error))
        finally:
            if not self.loto_active:
                GLib.idle_add(lambda: self.start_button.set_sensitive(True) or False)

    def wait_until_ready(self, mark_ready=True):
        for _ in range(45):
            for service in SERVICES:
                status = self.service_status(service)
                self.set_status(service, status, status in ("READY", "RUNNING"))
                if status in ("STOPPED", "ERROR", "UNHEALTHY"):
                    self.append_log(
                        f"[WARNING] Required service {service} is {status}. "
                        "Start the OpenHub runtime to enable Furnace and Warehouse APIs."
                    )
            openhub = self.openhub_api_ready()
            web = self.http_status("http://127.0.0.1:8180") == 200
            controller_health = self.service_status("uns-openhub-controller")
            if openhub and controller_health in ("STOPPED", "ERROR"):
                controller_health = "READY"
            self.set_status("OpenHub", "READY" if openhub else "WAITING", openhub)
            self.set_status("Controller health", controller_health,
                            controller_health in ("READY", "RUNNING"))
            self.set_status("Web interface", "READY" if web else "WAITING", web)
            # The controller health endpoint confirms its PostgreSQL, MQTT, and Caddy
            # dependencies, including when this client cannot inspect rootless containers.
            if openhub and web:
                if mark_ready:
                    GLib.idle_add(self.mark_ready)
                return
            threading.Event().wait(2)
        raise RuntimeError("OpenHub API or the web interface did not become ready.")

    def openhub_token(self):
        for variable in (
            "FURNACE_OPENHUB_TOKEN_FILE",
            "OPENHUB_TOKEN_FILE",
            "UNS_SERVICE_TOKEN_FILE",
        ):
            token_file = os.environ.get(variable)
            if not token_file:
                continue
            try:
                with open(token_file, "r", encoding="utf-8") as handle:
                    token = handle.read().strip()
            except OSError as error:
                raise RuntimeError(f"Could not read OpenHub service token: {error}") from error
            if token:
                return token
            raise RuntimeError(f"OpenHub service token file is empty: {token_file}")
        for variable in (
            "FURNACE_OPENHUB_TOKEN",
            "OPENHUB_TOKEN",
            "UNS_SERVICE_TOKEN",
        ):
            token = os.environ.get(variable)
            if token and token.strip():
                return token.strip()
        try:
            with open(self.openhub_token_path, "r", encoding="utf-8") as handle:
                token = handle.read().strip()
        except FileNotFoundError:
            token = ""
        except OSError as error:
            raise RuntimeError(f"Could not read saved OpenHub token: {error}") from error
        if token:
            return token
        raise RuntimeError(
            "OpenHub authentication is required. Configure a service/access token."
        )

    @property
    def refresh_cookie_path(self):
        return self.openhub_token_path + "-refresh"

    def save_authentication(self, access_token, refresh_cookie=None):
        directory = os.path.dirname(self.openhub_token_path)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        temporary = self.openhub_token_path + ".new"
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(access_token + "\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.openhub_token_path)
        if refresh_cookie:
            temporary = self.refresh_cookie_path + ".new"
            with open(temporary, "w", encoding="utf-8") as handle:
                handle.write(refresh_cookie + "\n")
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.refresh_cookie_path)

    def saved_refresh_cookie(self):
        try:
            with open(self.refresh_cookie_path, "r", encoding="utf-8") as handle:
                return handle.read().strip()
        except FileNotFoundError:
            return ""
        except OSError as error:
            raise RuntimeError(f"Could not read saved OpenHub refresh session: {error}") from error

    def refresh_authentication(self):
        refresh_cookie = self.saved_refresh_cookie()
        if not refresh_cookie:
            return False
        request = urllib.request.Request(
            "http://127.0.0.1:3200/api/auth/refresh",
            data=b"{}",
            headers={
                "Content-Type": "application/json",
                "Cookie": refresh_cookie,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = json.load(response)
                access_token = payload.get("accessToken")
                if not isinstance(access_token, str) or not access_token.strip():
                    return False
                cookie = self.refresh_cookie_from_headers(response.headers) or refresh_cookie
                self.save_authentication(access_token.strip(), cookie)
                return True
        except (OSError, ValueError, urllib.error.URLError):
            return False

    @staticmethod
    def refresh_cookie_from_headers(headers):
        raw = headers.get("Set-Cookie", "")
        if not raw:
            return ""
        parsed = http.cookies.SimpleCookie()
        parsed.load(raw)
        morsel = parsed.get("RefreshToken") or parsed.get("rt")
        return f"{morsel.key}={morsel.value}" if morsel else ""

    def graphql(self, query, variables=None, token=None):
        """Call OpenHub GraphQL with one automatic auth retry."""
        if self.loto_active and query.lstrip().lower().startswith("mutation"):
            raise RuntimeError("LOTO is active. OpenHub runtime changes are locked.")
        supplied_token = token is not None
        current_token = token or self.openhub_token()
        payload = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")

        for attempt in range(2):
            request = urllib.request.Request(
                OPENHUB_GRAPHQL_URL,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + current_token,
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    result = json.load(response)
            except urllib.error.HTTPError as error:
                if error.code in (401, 403) and attempt == 0 and not supplied_token:
                    if self.refresh_authentication():
                        current_token = self.openhub_token()
                        continue
                detail = error.read().decode("utf-8", "ignore").strip()
                raise RuntimeError(
                    f"OpenHub GraphQL HTTP {error.code}" + (f": {detail[:300]}" if detail else "")
                ) from error
            except (OSError, ValueError, urllib.error.URLError) as error:
                raise RuntimeError(f"OpenHub GraphQL request failed: {error}") from error

            errors = result.get("errors")
            if errors:
                messages = "; ".join(
                    str(item.get("message", "GraphQL error"))
                    for item in errors if isinstance(item, dict)
                )
                unauthenticated = any(
                    isinstance(item, dict)
                    and (item.get("extensions") or {}).get("code") == "UNAUTHENTICATED"
                    for item in errors
                )
                if unauthenticated and attempt == 0 and not supplied_token:
                    if self.refresh_authentication():
                        current_token = self.openhub_token()
                        continue
                raise RuntimeError(messages or "OpenHub GraphQL request failed.")
            return result.get("data") or {}

        raise RuntimeError("OpenHub authentication retry failed.")
    def authentication_setup_worker(self):
        try:
            token = self.request_token_from_user()
            if not token:
                return
            self.graphql("query ValidateOpenHubAccess { GetRttNodes { rttNode } }", token=token)
            self.save_authentication(token)
            self.set_status("OpenHub authentication", "READY", True)
            self.append_log("[INFO] OpenHub authentication configured securely.")
        except Exception as error:
            self.report_error(self.user_facing_error(error))

    def request_token_from_user(self):
        result = {"token": None, "cancelled": False}
        completed = threading.Event()

        def show_dialog():
            dialog = Gtk.Dialog(
                title="Configure OpenHub authentication",
                transient_for=self,
                flags=0,
            )
            dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
            dialog.add_button("Save and test", Gtk.ResponseType.OK)
            content = dialog.get_content_area()
            content.set_spacing(8)
            content.set_border_width(12)
            content.pack_start(Gtk.Label(
                label="Paste an OpenHub access/service token. It will be stored only for this Linux user.",
                xalign=0,
            ), False, False, 0)
            entry = Gtk.Entry()
            entry.set_visibility(False)
            entry.set_invisible_char("*")
            entry.set_activates_default(True)
            content.pack_start(entry, False, False, 0)
            dialog.set_default_response(Gtk.ResponseType.OK)
            dialog.show_all()
            response = dialog.run()
            if response == Gtk.ResponseType.OK:
                result["token"] = entry.get_text().strip()
            else:
                result["cancelled"] = True
            dialog.destroy()
            completed.set()
            return False

        GLib.idle_add(show_dialog)
        completed.wait()
        if result["cancelled"]:
            return None
        if not result["token"]:
            raise RuntimeError("An OpenHub token is required.")
        return result["token"]

    def ensure_authentication(self):
        try:
            self.graphql("query ValidateOpenHubAccess { GetRttNodes { rttNode } }")
            self.set_status("OpenHub authentication", "READY", True)
        except RuntimeError as error:
            if self.is_connection_error(error):
                raise RuntimeError(
                    "OpenHub is not reachable at 127.0.0.1:3200. "
                    "Start the OpenHub runtime, then log in before using Furnace or Warehouse."
                ) from error
            if self.refresh_authentication():
                self.graphql("query ValidateOpenHubAccess { GetRttNodes { rttNode } }")
                self.set_status("OpenHub authentication", "READY", True)
                return
            self.set_status("OpenHub authentication", "REQUIRED", False)
            self.login_worker()

    def login_worker(self):
        result = {"email": None, "password": None, "cancelled": False}
        completed = threading.Event()

        def show_dialog():
            dialog = Gtk.Dialog(title="OpenHub Login", transient_for=self, flags=0)
            self.login_dialog = dialog
            dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
            dialog.add_button("Log in", Gtk.ResponseType.OK)
            content = dialog.get_content_area()
            content.set_spacing(8)
            content.set_border_width(12)
            email = Gtk.Entry()
            email.set_placeholder_text("Email / Username")
            password = Gtk.Entry()
            password.set_visibility(False)
            password.set_placeholder_text("Password")
            content.pack_start(Gtk.Label(label="Email / Username:", xalign=0), False, False, 0)
            content.pack_start(email, False, False, 0)
            content.pack_start(Gtk.Label(label="Password:", xalign=0), False, False, 0)
            content.pack_start(password, False, False, 0)
            dialog.set_default_response(Gtk.ResponseType.OK)
            dialog.show_all()
            response = dialog.run()
            if response == Gtk.ResponseType.OK:
                result["email"] = email.get_text().strip()
                result["password"] = password.get_text()
            else:
                result["cancelled"] = True
            dialog.destroy()
            self.login_dialog = None
            completed.set()
            return False

        GLib.idle_add(show_dialog)
        completed.wait()
        if result["cancelled"]:
            return
        try:
            if not result["email"] or not result["password"]:
                raise RuntimeError("Email / Username and password are required.")
            payload = json.dumps({
                "email": result["email"],
                "password": result["password"],
                "rememberMe": True,
            }).encode("utf-8")
            request = urllib.request.Request(
                "http://127.0.0.1:3200/api/auth/login",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                body = json.load(response)
                token = body.get("accessToken")
                cookie = self.refresh_cookie_from_headers(response.headers)
            if not isinstance(token, str) or not token.strip():
                raise RuntimeError("OpenHub login did not return an access token.")
            # The login endpoint and the GraphQL/runtime permissions check are separate.
            # Save a valid login token even if the runtime API is not ready yet.
            token = token.strip()
            self.save_authentication(token, cookie)
            self.set_status("OpenHub authentication", "READY", True)
            GLib.idle_add(self.set_openhub_login_state, True)
            self.append_log("[INFO] OpenHub login succeeded.")
            try:
                self.graphql("query ValidateOpenHubAccess { GetRttNodes { rttNode } }", token=token)
                self.append_log("[INFO] OpenHub API access validated.")
            except Exception as validation_error:
                self.set_status("OpenHub authentication", "READY", True)
                self.append_log("[WARNING] OpenHub login is valid, but API/runtime access is not ready: " + str(validation_error))
                self.ready_label.set_text("OpenHub login OK; runtime/API still starting or unavailable.")
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                self.set_status("OpenHub authentication", "FAILED", False)
                self.report_error("OpenHub login failed: invalid credentials or insufficient permissions.")
            else:
                self.report_error(f"OpenHub login failed: HTTP {error.code}")
        except Exception as error:
            self.report_error(self.user_facing_error(error))

    def rtt_node_state(self):
        query = """
        query FurnaceRttNodes {
          GetRttNodes {
            rttNode
            status
            runningVersion
            versions {
              version
              isInstalled
              instances {
                id
                desiredRunning
                processName
                processes {
                  name
                  status
                  version
                  instanceId
                }
              }
            }
            processes {
              name
              status
              version
              instanceId
            }
          }
        }
        """
        nodes = self.graphql(query).get("GetRttNodes") or []
        self.rtt_instance_id = None
        self.rtt_version = RTT_VERSION
        for node in nodes:
            if node.get("rttNode") != RTT_NODE:
                continue
            processes = node.get("processes") or []
            versions = node.get("versions") or []
            self.append_log(
                "[INFO] RTT discovery: "
                + json.dumps(
                    {
                        "rttNode": node.get("rttNode"),
                        "nodeStatus": node.get("status"),
                        "runningVersion": node.get("runningVersion"),
                        "versions": [
                            {
                                "version": version.get("version"),
                                "isInstalled": version.get("isInstalled"),
                                "instances": [
                                    {
                                        "instanceId": instance.get("id"),
                                        "desiredRunning": instance.get("desiredRunning"),
                                        "processName": instance.get("processName"),
                                        "processes": [
                                            {
                                                "name": process.get("name"),
                                                "status": process.get("status"),
                                                "version": process.get("version"),
                                                "instanceId": process.get("instanceId"),
                                            }
                                            for process in instance.get("processes") or []
                                        ],
                                    }
                                    for instance in version.get("instances") or []
                                ],
                            }
                            for version in versions
                        ],
                        "processes": [
                            {
                                "name": process.get("name"),
                                "status": process.get("status"),
                                "version": process.get("version"),
                                "instanceId": process.get("instanceId"),
                            }
                            for process in processes
                        ],
                    },
                    separators=(",", ":"),
                )
            )
            matching = [
                process for process in processes
                if self.rtt_version_matches(process.get("version"))
            ]
            for process in matching:
                instance_id = process.get("instanceId")
                if instance_id:
                    self.rtt_instance_id = instance_id
                status = str(process.get("status") or "").upper()
                if status in ("ONLINE", "RUNNING", "ACTIVE"):
                    return "RUNNING"
            for version in versions:
                if not self.rtt_version_matches(version.get("version")):
                    continue
                self.rtt_version = version.get("version") or RTT_VERSION
                for instance in version.get("instances") or []:
                    if instance.get("id"):
                        self.rtt_instance_id = instance["id"]
                    instance_processes = instance.get("processes") or []
                    for process in instance_processes:
                        status = str(process.get("status") or "").upper()
                        if status in ("ONLINE", "RUNNING", "ACTIVE"):
                            return "RUNNING"
                    if instance.get("desiredRunning") is True:
                        return "STARTING"
            return "STOPPED"
        raise RuntimeError(f"Installed RTT node '{RTT_NODE}' was not found.")

    @staticmethod
    def rtt_version_matches(version):
        if version is None:
            return True
        return str(version).removeprefix("v") == RTT_VERSION.removeprefix("v")

    def ensure_rtt_running(self):
        status = self.rtt_node_state()
        self.set_status("rtt-demo-app", "RUNNING" if status == "RUNNING" else "STARTING...", status == "RUNNING")
        if status == "RUNNING":
            self.append_log("[INFO] Existing rtt-demo-app v6.1.12 detected; reusing it.")
            return
        if status == "STARTING":
            self.append_log("[INFO] rtt-demo-app is already starting; waiting for it.")
        else:
            mutation = """
            mutation StartFurnaceRtt(
              $rttNode: String!,
              $version: String!,
              $instanceId: String,
              $controllerName: String
            ) {
              StartRttNodeVersion(
                rttNode: $rttNode,
                version: $version,
                instanceId: $instanceId,
                controllerName: $controllerName
              )
            }
            """
            self.graphql(mutation, {
                "rttNode": RTT_NODE,
                "version": self.rtt_version,
                "instanceId": self.rtt_instance_id,
            })
            self.rtt_started_by_app = True
            self.append_log(f"[INFO] Requested start of {RTT_NODE} v{RTT_VERSION}.")
        for _ in range(30):
            status = self.rtt_node_state()
            self.set_status("rtt-demo-app", status if status == "RUNNING" else "STARTING...", status == "RUNNING")
            if status == "RUNNING":
                return
            threading.Event().wait(2)
        raise RuntimeError("rtt-demo-app v6.1.12 did not become RUNNING.")

    def ensure_furnace_api_ready(self):
        if self.rtt_api_ready:
            return
        self.ensure_rtt_running()
        for _ in range(30):
            try:
                self._hrm_request("GET", "/status")
            except RuntimeError as error:
                if "authentication" in str(error).lower():
                    raise
                self.set_status("rtt-demo-app", "STARTING...", False)
                threading.Event().wait(2)
                continue
            self.rtt_api_ready = True
            self.set_status("rtt-demo-app", "RUNNING", True)
            self.append_log("[INFO] rtt-demo-app v6.1.12 is RUNNING and its Furnace API is ready.")
            return
        raise RuntimeError(
            "rtt-demo-app v6.1.12 started but its Furnace API did not become reachable through OpenHub."
        )

    def service_status(self, service):
        try:
            result = self.run_compose("ps", "-q", service)
            matches = re.findall(r"\b[0-9a-f]{12,64}\b", result.stdout)
            container = matches[-1] if matches else ""
            if not container:
                return "STOPPED"
            inspect = subprocess.run(
                ("podman", "inspect", "--format",
                 "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}",
                 container),
                text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                check=False, timeout=10
            ).stdout.strip()
            state, health = (inspect.split("|", 1) + [""])[:2]
            if state != "running":
                return state.upper() or "STOPPED"
            return "READY" if health == "healthy" else (
                "UNHEALTHY" if health == "unhealthy" else "RUNNING"
            )
        except (OSError, subprocess.SubprocessError):
            return "ERROR"

    @staticmethod
    def http_status(url):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                return response.status
        except (OSError, urllib.error.URLError):
            return None

    @staticmethod
    def is_connection_error(error):
        text = str(error).lower()
        return any(value in text for value in (
            "connection refused", "connection reset", "timed out",
            "urlopen error", "failed to establish a new connection",
        ))

    @classmethod
    def user_facing_error(cls, error):
        if cls.is_connection_error(error):
            return (
                "OpenHub connection failed. Make sure the OpenHub runtime and "
                "Furnace API are running, then log in before using protected features. "
                f"Details: {error}"
            )
        return str(error)

    @classmethod
    def http_ready(cls, url):
        return cls.http_status(url) == 200

    @classmethod
    def openhub_api_ready(cls):
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:3200/api/healthcheck", timeout=3
            ) as response:
                if response.status != 200:
                    return False
                payload = json.load(response)
            return payload.get("ready") is True and payload.get("state") == "master_ready"
        except (OSError, ValueError, TypeError, urllib.error.URLError):
            return False

    def mark_ready(self):
        self.ready_label.set_markup("<span size='large' weight='bold' foreground='#16803c'>FURNACE SIMULATION IS READY</span>")
        self.timeline_event("Furnace Simulation", "READY")
        self.start_button.get_style_context().remove_class("start-inactive")
        self.start_button.get_style_context().add_class("start-active")
        if self.loto_active:
            self.apply_loto_controls()
        else:
            self.open_button.set_sensitive(True)
            self.warehouse_button.set_sensitive(True)
            self.uns_button.set_sensitive(True)
            self.stop_button.set_sensitive(True)
        return False

    def stop_runtime(self, *_args):
        if not self.loto_allows_operation():
            return
        threading.Thread(target=self.stop_worker, daemon=True).start()

    def stop_worker(self):
        stop_error = None
        try:
            if self.rtt_started_by_app:
                try:
                    self.ensure_authentication()
                    self.rtt_node_state()
                    mutation = """
                    mutation StopFurnaceRtt(
                      $rttNode: String,
                      $version: String,
                      $instanceId: String,
                      $controllerName: String
                    ) {
                      StopRttNodeVersion(
                        rttNode: $rttNode,
                        version: $version,
                        instanceId: $instanceId,
                        controllerName: $controllerName
                      )
                    }
                    """
                    self.graphql(mutation, {
                        "rttNode": RTT_NODE,
                        "version": self.rtt_version,
                        "instanceId": self.rtt_instance_id,
                    })
                    self.append_log("[INFO] Stopped rtt-demo-app started by Furnace Simulation.")
                    self.rtt_started_by_app = False
                except Exception as error:
                    stop_error = error
                    self.append_log(
                        "[WARNING] Could not stop rtt-demo-app through OpenHub: "
                        + str(error)
                    )
            else:
                self.append_log("[INFO] Existing rtt-demo-app was not stopped.")
            if self.runtime_started_by_app:
                result = self.run_compose("down", timeout=120)
                self.append_log(result.stdout)
                if result.returncode:
                    raise RuntimeError(self.compose_error(result.stdout))
                self.runtime_started_by_app = False
            else:
                self.append_log("[INFO] Existing OpenHub runtime was not stopped.")
            self.timeline_stopped_at = datetime.now()
            self.session_active = False
            if stop_error is not None:
                self.append_log(
                    "[INFO] Runtime shutdown completed; RTT stop requires valid authentication."
                )
            GLib.idle_add(self.finish_stop_ui)
        except Exception as error:
            self.report_error(str(error))

    def finish_stop_ui(self):
        self.close_secondary_windows()
        self.timeline_event("Furnace Simulation", "STOPPED")
        self.set_stopped_ui()
        self.refresh_status()
        return False

    def set_stopped_ui(self):
        self.ready_label.set_markup(
            "<span size='large' weight='bold' foreground='#b42318'>FURNACE SIMULATION IS STOP</span>"
        )
        # OpenHub login remains required after the runtime shuts down.
        if self.loto_active:
            self.apply_loto_controls()
        else:
            self.open_button.set_sensitive(self.openhub_logged_in)
            self.warehouse_button.set_sensitive(self.openhub_logged_in)
            self.uns_button.set_sensitive(True)
            self.stop_button.set_sensitive(False)
        self.update_furnace_visual(False)
        self.start_button.get_style_context().remove_class("start-active")
        self.start_button.get_style_context().add_class("start-inactive")
        return False

    def close_secondary_windows(self):
        for window in (self.furnace_window, self.warehouse_window):
            if window is not None:
                window.destroy()
        self.furnace_window = None
        self.warehouse_window = None
        self.furnace_refresh_source = None
        self.warehouse_refresh_source = None
        if self.login_dialog is not None:
            self.login_dialog.destroy()
            self.login_dialog = None

    def refresh_status(self, *_args):
        threading.Thread(target=self.status_worker, daemon=True).start()

    def status_worker(self):
        if not self.compose:
            self.set_status("Podman", "MISSING", False)
            return
        self.set_status("Podman", "READY", True)
        try:
            self.validate_files()
            self.set_status("Configuration", "READY", True)
        except Exception as error:
            self.set_status("Configuration", "MISSING", False)
            self.report_error(str(error))
            return
        for service in SERVICES:
            status = self.service_status(service)
            self.set_status(service, status, status in ("READY", "RUNNING"))
        try:
            self.openhub_token()
            self.set_status("OpenHub authentication", "READY", True)
        except RuntimeError:
            self.set_status("OpenHub authentication", "REQUIRED", False)
        try:
            rtt_status = self.rtt_node_state()
            if rtt_status == "RUNNING":
                try:
                    self._hrm_request("GET", "/status")
                    self.rtt_api_ready = True
                    self.set_status("rtt-demo-app", "RUNNING", True)
                except RuntimeError:
                    self.rtt_api_ready = False
                    self.set_status("rtt-demo-app", "STARTING...", False)
            else:
                self.rtt_api_ready = False
                self.set_status("rtt-demo-app", rtt_status, False)
        except RuntimeError as error:
            self.rtt_api_ready = False
            self.set_status("rtt-demo-app", "AUTH REQUIRED", False)
            self.append_log("[INFO] rtt-demo-app status unavailable: " + self.user_facing_error(error))
        openhub = self.openhub_api_ready()
        self.set_status("OpenHub", "READY" if openhub else "STOPPED", openhub)
        controller_health = self.service_status("uns-openhub-controller")
        self.set_status("Controller health", controller_health,
                        controller_health in ("READY", "RUNNING"))
        web = self.http_status("http://127.0.0.1:8180") == 200
        self.set_status("Web interface", "READY" if web else "STOPPED", web)

    def report_error(self, message):
        # Background/runtime errors must never create a modal dialog that blocks
        # Furnace, Warehouse, UNS, or OpenHub Login navigation.
        def update():
            self.ready_label.set_markup("<span size='large' weight='bold' foreground='#b42318'>RUNTIME WARNING</span>")
            self.append_log("[ERROR] " + message)
            return False
        GLib.idle_add(update)

    def open_furnace(self, *_args):
        if not self.loto_allows_operation():
            return
        if self.furnace_window is None:
            self.furnace_window = self.create_furnace_window()
            self.furnace_window.connect(
                "destroy", self.close_furnace_window
            )
            self.furnace_refresh_source = GLib.timeout_add_seconds(
                3, self.poll_furnace_status
            )
        self.furnace_window.show_all()
        self.furnace_window.present()
        self.refresh_furnace_status()

    def close_furnace_window(self, *_args):
        if self.furnace_refresh_source is not None:
            GLib.source_remove(self.furnace_refresh_source)
            self.furnace_refresh_source = None
        self.furnace_window = None
        self.furnace_drawing = None
        self.furnace_green = None
        self.furnace_red = None
        self.furnace_status_labels = {}
        self.furnace_images = {}
        if self.furnace_animation_source is not None:
            GLib.source_remove(self.furnace_animation_source)
            self.furnace_animation_source = None

    def return_to_main_window(self, window):
        window.hide()
        self.deiconify()
        self.present()

    def poll_furnace_status(self):
        if self.furnace_window is None:
            return False
        self.refresh_furnace_status()
        return True

    def open_uns(self, *_args):
        threading.Thread(
            target=self.open_url_worker,
            args=("http://127.0.0.1:8180/uns-component", "Open UNS"),
            daemon=True,
        ).start()

    def create_furnace_window(self):
        builder = Gtk.Builder()
        builder.add_from_file(os.path.join(self.app_dir, "furnace-v3.ui"))
        root = builder.get_object("furnace_root")
        self._set_logo(builder, 190, 55)
        window = Gtk.Window(title="Furnace Control", transient_for=self)
        window.set_default_size(960, 640)
        window.set_border_width(18)
        icon_path = os.path.join(self.app_dir, "Furnice-simulator-icon.png")
        if os.path.isfile(icon_path):
            window.set_icon_from_file(icon_path)
        window.add(root)
        self._furnace_builder = builder
        root.get_style_context().add_class("furnace-app")
        for _name in ("submit_production", "refresh_furnace", "furnace_back"):
            _button = builder.get_object(_name)
            if _button:
                _button.get_style_context().add_class("action")
        _submit = builder.get_object("submit_production")
        if _submit:
            _submit.get_style_context().add_class("primary")
        self.recipe_entry = builder.get_object("recipe_entry")
        self.material_entry = builder.get_object("material_entry")
        self.quantity_entry = builder.get_object("quantity_entry")
        self.repeat_combo = builder.get_object("repeat_combo")
        self.repeat_combo.set_active(0)
        self.merge_check = builder.get_object("merge_check")
        self.merge_input_entry = builder.get_object("merge_input_entry")
        self.merge_output_entry = builder.get_object("merge_output_entry")
        self.merge_output_entry.set_editable(False)
        self.material_entry.connect("changed", self.sync_material_output)
        self.production_status_label = builder.get_object("production_status_label")
        self.furnace_green = builder.get_object("furnace_green")
        self.furnace_red = builder.get_object("furnace_red")
        self.furnace_drawing = builder.get_object("furnace_drawing")
        self.furnace_status_labels = {}
        for index in range(1, 5):
            self.furnace_status_labels[index] = {
                key: builder.get_object(f"f{index}_{key.lower()}")
                for key in ("Status", "Temperature", "Material", "Stage", "Production")
            }
        builder.get_object("submit_production").connect("clicked", self.submit_production)
        builder.get_object("refresh_furnace").connect("clicked", lambda *_: self.refresh_furnace_status())
        builder.get_object("furnace_back").connect(
            "clicked", lambda *_: self.return_to_main_window(window)
        )
        self.refresh_available_recipes()
        self.load_furnace_images()
        self.update_furnace_visual(False)
        self.furnace_animation_source = GLib.timeout_add(
            650, self.advance_furnace_animation
        )
        return window

    def sync_material_output(self, material_entry):
        self.merge_output_entry.set_text(material_entry.get_text())

    def load_furnace_images(self):
        self.furnace_images = {}
        for frame in range(1, 5):
            path = os.path.join(self.app_dir, f"animation{frame}.png")
            if not os.path.isfile(path):
                continue
            self.furnace_images[frame] = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                path, 420, 190, True
            )

    def update_furnace_visual(self, heating):
        self.furnace_running = bool(heating)
        for label, active, text in (
            (self.furnace_green, heating, "● ON"),
            (self.furnace_red, not heating, "● OFF"),
        ):
            if label is not None:
                color = "#16803c" if label is self.furnace_green and active else (
                    "#b42318" if label is self.furnace_red and active else "#6b7280"
                )
                label.set_markup(f"<span foreground='{color}' size='large'>{text}</span>")
        if self.furnace_drawing is not None:
            if not self.furnace_material_active:
                frame = 1
            elif self.furnace_heating:
                frame = 4 if self.furnace_frame_is_ready else 3 + self.furnace_animation_phase % 2
            else:
                frame = 2
            pixbuf = self.furnace_images.get(frame)
            if pixbuf is not None:
                self.furnace_drawing.set_from_pixbuf(pixbuf)

    def advance_furnace_animation(self):
        if self.furnace_window is None:
            return False
        self.furnace_animation_phase += 1
        self.update_furnace_visual(self.furnace_running)
        return True

    @property
    def furnace_frame_is_ready(self):
        return getattr(self, "_furnace_frame_is_ready", False)

    def open_warehouse(self, *_args):
        if not self.loto_allows_operation():
            return
        if self.warehouse_window is None:
            self.warehouse_window = self.create_warehouse_window()
            self.warehouse_window.connect("destroy", self.close_warehouse_window)
            self.warehouse_refresh_source = GLib.timeout_add_seconds(
                4, self.poll_warehouse_status
            )
        self.warehouse_window.show_all()
        self.refresh_warehouse_status()

    def close_warehouse_window(self, *_args):
        if self.warehouse_refresh_source is not None:
            GLib.source_remove(self.warehouse_refresh_source)
            self.warehouse_refresh_source = None
        self.warehouse_window = None

    def poll_warehouse_status(self):
        if self.warehouse_window is None:
            return False
        self.refresh_warehouse_status()
        return True

    def create_warehouse_window(self):
        builder = Gtk.Builder()
        builder.add_from_file(os.path.join(self.app_dir, "warehouse-v3.ui"))
        root = builder.get_object("warehouse_root")
        self._set_logo(builder, 190, 55)
        window = Gtk.Window(title="Warehouse", transient_for=self)
        window.set_default_size(780, 520)
        window.set_border_width(18)
        icon_path = os.path.join(self.app_dir, "Furnice-simulator-icon.png")
        if os.path.isfile(icon_path):
            window.set_icon_from_file(icon_path)
        window.add(root)
        self._warehouse_builder = builder
        root.get_style_context().add_class("furnace-app")
        for _name in ("warehouse_refresh", "warehouse_use", "warehouse_back"):
            _button = builder.get_object(_name)
            if _button:
                _button.get_style_context().add_class("action")
        self.warehouse_search = builder.get_object("warehouse_search")
        self.warehouse_footer = builder.get_object("warehouse_footer")
        self.warehouse_search.connect("changed", self.filter_warehouse_rows)
        builder.get_object("warehouse_refresh").connect("clicked", lambda *_: self.refresh_warehouse_status())
        builder.get_object("warehouse_use").connect("clicked", self.use_selected_material)
        builder.get_object("warehouse_back").connect(
            "clicked", lambda *_: self.return_to_main_window(window)
        )
        # Keep the full warehouse record separate from the displayed row, keyed
        # by a stable row ID so filtering never changes what was selected.
        self.warehouse_store = Gtk.ListStore(
            bool, str, str, str, str, str, str, str, str, str
        )
        self.warehouse_filter = self.warehouse_store.filter_new()
        self.warehouse_filter.set_visible_func(self.warehouse_row_visible)
        tree = builder.get_object("warehouse_tree")
        self.warehouse_tree = tree
        tree.set_model(self.warehouse_filter)
        tree.get_selection().set_mode(Gtk.SelectionMode.NONE)
        toggle = Gtk.CellRendererToggle()
        toggle.connect("toggled", self.toggle_warehouse_row)
        tree.append_column(Gtk.TreeViewColumn("", toggle, active=0))
        for index, title_text in enumerate(
            ("Material", "Quantity", "Location", "Status", "Recipe", "Batch", "Quality"),
            start=1,
        ):
            renderer = Gtk.CellRendererText()
            tree.append_column(
                Gtk.TreeViewColumn(
                    title_text, renderer, text=index, cell_background=9
                )
            )
        return window

    def filter_warehouse_rows(self, *_args):
        if self.warehouse_filter is not None:
            self.warehouse_filter.refilter()

    def warehouse_row_visible(self, model, iterator, *_args):
        query = self.warehouse_search.get_text().strip().lower()
        if not query:
            return True
        return any(query in str(model[iterator][index]).lower() for index in range(1, 8))

    def set_warehouse_message(self, message):
        if self.warehouse_footer is not None:
            self.warehouse_footer.set_text(message)

    def toggle_warehouse_row(self, _renderer, path):
        iterator = self.warehouse_filter.get_iter(path)
        child_iterator = self.warehouse_filter.convert_iter_to_child_iter(iterator)
        row = self.warehouse_store[child_iterator]
        selected = bool(row[0])
        row_id = row[8]

        if not selected and len(self.warehouse_selected_rows) >= 5:
            self.set_warehouse_message("Maximum 5 materials can be selected.")
            return

        row[0] = not selected
        row[9] = "#233a4a" if not selected else ""
        if selected:
            self.warehouse_selected_rows.pop(row_id, None)
        else:
            self.warehouse_selected_rows[row_id] = self.warehouse_rows[row_id]
        self.set_warehouse_message(
            f"{len(self.warehouse_selected_rows)} warehouse material"
            f"{'s' if len(self.warehouse_selected_rows) != 1 else ''} selected."
        )

    def use_selected_material(self, *_args):
        if not self.loto_allows_operation():
            return
        selected_rows = []
        if self.warehouse_store is not None:
            for row in self.warehouse_store:
                if row[0]:
                    selected_rows.append(self.warehouse_rows[row[8]])
        if not selected_rows:
            self.set_warehouse_message("Please select at least 1 material.")
            return
        materials = [row["material"] for row in selected_rows]
        if any(material in ("", "not exposed") for material in materials):
            self.set_warehouse_message(
                "Selected warehouse records must have an exposed Material value."
            )
            return
        if self.furnace_window is None:
            self.open_furnace()
        self.merge_input_entry.set_text(",".join(materials))
        self.merge_check.set_active(len(materials) > 1)
        self.production_status_label.set_text(
            f"{len(materials)} warehouse materials loaded into Furnace Merge Inputs."
        )
        self.warehouse_selected_rows.clear()
        for row in self.warehouse_store:
            row[0] = False
            row[9] = ""
        self.set_warehouse_message(
            f"{len(materials)} warehouse materials loaded into Furnace Merge Inputs."
        )
        self.furnace_window.present()

    def refresh_warehouse_status(self):
        threading.Thread(target=self.warehouse_status_worker, daemon=True).start()

    def warehouse_status_worker(self):
        try:
            payload = self.hrm_request("GET", "/status")
            GLib.idle_add(self.update_warehouse_status, payload)
        except Exception as error:
            self.append_log("[FAIL] Warehouse status: " + self.user_facing_error(error))

    def update_warehouse_status(self, payload):
        if self.warehouse_store is None:
            return False
        previously_selected_ids = set(self.warehouse_selected_rows)
        self.warehouse_store.clear()
        self.warehouse_rows = {}
        self.warehouse_selected_rows = {}
        stations = payload.get("stations") or {}
        records = []
        for batch in payload.get("queue") or []:
            records.append({
                "materialId": batch.get("materialId"),
                "recipeId": batch.get("recipeId"),
                "batchId": batch.get("batchId"),
                "location": "production queue",
                "status": "QUEUED",
                "quantity": "queued",
                "quality": "",
            })
        for station_name, station in stations.items():
            if station_name == "furnace":
                records.extend({
                    "materialId": slot.get("materialId"),
                    "recipeId": slot.get("recipeId"),
                    "batchId": slot.get("batchId"),
                    "location": f"Furnace {slot.get('slot')}",
                    "status": slot.get("subState") or "FURNACE",
                    "quantity": "in process",
                    "quality": "",
                } for slot in station.get("furnaceMaterials") or [])
                continue
            if station.get("materialId") or station.get("batchId"):
                state = station.get("state") or {}
                records.append({
                    "materialId": station.get("materialId"),
                    "recipeId": station.get("recipeId"),
                    "batchId": station.get("batchId"),
                    "location": station_name,
                    "status": station_name.upper(),
                    "quantity": "in process",
                    "quality": (
                        "PASS" if state.get("passFail") is True else
                        "FAIL" if state.get("passFail") is False else ""
                    ),
                })
        seen_records = set()
        for record_index, record in enumerate(records):
            batch_id = str(record.get("batchId") or "")
            material = str(record.get("materialId") or "")
            location = str(record["location"])
            duplicate_key = (batch_id, material, location)
            if duplicate_key in seen_records:
                continue
            seen_records.add(duplicate_key)
            row_id = f"{batch_id}\x1f{location}\x1f{material}\x1f{record_index}"
            warehouse_record = {
                "material": material,
                "quantity": str(record["quantity"]),
                "location": location,
                "status": str(record["status"]),
                "recipe": str(record.get("recipeId") or ""),
                "batch": batch_id,
                "quality": str(record["quality"]),
            }
            self.warehouse_rows[row_id] = warehouse_record
            selected = row_id in previously_selected_ids
            if selected:
                self.warehouse_selected_rows[row_id] = warehouse_record
            self.warehouse_store.append([
                selected,
                warehouse_record["material"],
                warehouse_record["quantity"],
                warehouse_record["location"],
                warehouse_record["status"],
                warehouse_record["recipe"],
                batch_id,
                warehouse_record["quality"],
                row_id,
                "#233a4a" if selected else "",
            ])
        return False

    def _hrm_request(self, method, path, body=None):
        if self.loto_active and method != "GET":
            raise RuntimeError("LOTO is active. Furnace API changes are locked.")
        for attempt in range(2):
            token = self.openhub_token()
            url = HRM_API_BASE + path
            data = None if body is None else json.dumps(body).encode("utf-8")
            headers = {"Authorization": "Bearer " + token}
            if body is not None:
                headers["Content-Type"] = "application/json"
            request = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                if error.code == 401 and attempt == 0 and self.refresh_authentication():
                    continue
                if error.code in (401, 403):
                    raise RuntimeError(
                        "OpenHub authentication expired. Please log in again."
                    ) from error
                raise RuntimeError(f"Furnace API request failed: HTTP {error.code}") from error
            except (OSError, ValueError, urllib.error.URLError) as error:
                raise RuntimeError(
                    "Furnace API connection failed at 127.0.0.1:3200. "
                    "Start OpenHub and log in before using Furnace or Warehouse. "
                    f"Details: {error}"
                ) from error

    def hrm_request(self, method, path, body=None):
        if self.loto_active and method != "GET":
            raise RuntimeError("LOTO is active. Furnace API changes are locked.")
        self.ensure_furnace_api_ready()
        try:
            return self._hrm_request(method, path, body)
        except RuntimeError as error:
            if "HTTP 502" not in str(error):
                raise
            self.rtt_api_ready = False
            self.append_log(
                "[WARNING] Furnace API is restarting or its OpenHub route is updating; waiting for it."
            )
            self.ensure_furnace_api_ready()
            return self._hrm_request(method, path, body)

    def fetch_available_recipes(self):
        payload = self.hrm_request("GET", "/recipe-map")
        recipes = payload.get("recipes")
        if not isinstance(recipes, list):
            raise RuntimeError("Furnace API returned an invalid recipe map.")
        recipe_ids = [
            recipe.get("id") for recipe in recipes
            if isinstance(recipe, dict) and isinstance(recipe.get("id"), str)
            and recipe["id"].strip()
        ]
        if not recipe_ids:
            raise RuntimeError("Furnace API has no available recipes.")
        return recipe_ids

    def refresh_available_recipes(self):
        threading.Thread(target=self.available_recipes_worker, daemon=True).start()

    def available_recipes_worker(self):
        try:
            recipe_ids = self.fetch_available_recipes()
            GLib.idle_add(self.update_available_recipes, recipe_ids)
        except Exception as error:
            self.append_log("[FAIL] Furnace recipes: " + self.user_facing_error(error))

    def update_available_recipes(self, recipe_ids):
        self.available_recipe_ids = recipe_ids
        if self.recipe_entry is not None:
            self.recipe_entry.set_placeholder_text(recipe_ids[0])
        if self.production_status_label is not None:
            self.production_status_label.set_text(
                "Available recipes: " + ", ".join(recipe_ids)
            )
        return False

    def refresh_furnace_status(self):
        threading.Thread(target=self.furnace_status_worker, daemon=True).start()

    def furnace_status_worker(self):
        try:
            payload = self.hrm_request("GET", "/status")
            GLib.idle_add(self.update_furnace_status, payload)
        except Exception as error:
            self.append_log("[FAIL] Furnace status: " + self.user_facing_error(error))

    def update_furnace_status(self, payload):
        stations = payload.get("stations") or {}
        furnace = stations.get("furnace") or {}
        state = furnace.get("state") or {}
        materials = furnace.get("furnaceMaterials") or []
        batch_stage = "IDLE"
        batch_id = furnace.get("batchId")
        if batch_id:
            batch_stage = "FURNACE"
        sub_state = state.get("subState") or ""
        measured_temperatures = [
            zone.get("measuredTempC")
            for zone in state.get("zones") or []
            if isinstance(zone.get("measuredTempC"), (int, float))
        ]
        self._furnace_frame_is_ready = (
            sub_state.upper() in ("SOAKING", "TARGET_REACHED", "READY")
            or bool(measured_temperatures)
            and min(measured_temperatures) >= 900
        )
        zone_active = any(bool(zone.get("heaterOn")) for zone in state.get("zones") or [])
        furnace_active = bool(
            furnace.get("occupied") or materials or zone_active
            or sub_state in ("HEATING", "SOAKING")
        )
        self.furnace_material_active = bool(materials or furnace.get("occupied") or batch_id)
        self.furnace_heating = bool(
            furnace.get("occupied")
            and (zone_active or sub_state in ("HEATING", "SOAKING"))
        )
        self.update_furnace_visual(self.furnace_heating)
        materials_by_slot = {
            item.get("slot"): item
            for item in materials
            if isinstance(item, dict) and isinstance(item.get("slot"), int)
        }
        for index in range(1, 5):
            slot = materials_by_slot.get(index)
            status = (slot.get("subState") or "IN PROCESS") if slot else "IDLE"
            temperature = (
                f"{slot.get('measuredMaterialTempC')} °C"
                if slot and slot.get("measuredMaterialTempC") is not None
                else "not available"
            )
            self.update_furnace_card(
                index,
                status=status,
                temperature=temperature,
                material=slot.get("materialId") if slot else "none",
                stage=slot.get("subState") if slot else batch_stage,
                production=slot.get("batchId") if slot else "none",
            )
        return False

    def update_furnace_card(self, index, **values):
        labels = self.furnace_status_labels.get(index)
        if not labels:
            return
        for key, value in values.items():
            labels[key.capitalize()].set_text(f"{key.capitalize()}: {value}")

    def submit_production(self, *_args):
        if not self.loto_allows_operation():
            return
        try:
            quantity = float(self.quantity_entry.get_text().strip())
        except (AttributeError, ValueError):
            self.production_status_label.set_text("Quantity must be a positive number.")
            return
        recipe_id = self.recipe_entry.get_text().strip()
        material_id = self.material_entry.get_text().strip()
        repeat_stage = self.repeat_combo.get_active_id() or ""
        if not recipe_id or not material_id or quantity <= 0:
            self.production_status_label.set_text(
                "Recipe ID, Material No., and a positive quantity are required."
            )
            return
        body = {
            "recipeId": recipe_id,
            "materialId": material_id,
            "quantity": quantity,
        }
        if repeat_stage:
            body["repeatStage"] = repeat_stage
        if self.merge_check.get_active():
            inputs = [
                value.strip()
                for value in self.merge_input_entry.get_text().split(",")
                if value.strip()
            ]
            output = self.merge_output_entry.get_text().strip()
            if len(inputs) < 2 or not output:
                self.production_status_label.set_text(
                    "Merge requires at least two input material IDs and one output material ID."
                )
                return
            body["mergeInputMaterialIds"] = inputs
            body["mergeOutputMaterialId"] = output
        threading.Thread(
            target=self.submit_production_worker, args=(body,), daemon=True
        ).start()

    def submit_production_worker(self, body):
        try:
            recipe_ids = self.fetch_available_recipes()
            if body["recipeId"] not in recipe_ids:
                GLib.idle_add(
                    self.production_status_label.set_text,
                    "Recipe unavailable. Available recipes: " + ", ".join(recipe_ids),
                )
                return
            result = self.hrm_request("POST", "/batch", body)
            GLib.idle_add(
                self.production_status_label.set_text,
                f"Production {result.get('status', 'submitted')}: "
                f"{result.get('batchId', 'no batch ID')}",
            )
            self.append_log("[INFO] Submitted production batch.")
            self.refresh_furnace_status()
        except Exception as error:
            GLib.idle_add(self.production_status_label.set_text, str(error))
            self.append_log("[FAIL] Production submission: " + str(error))

    def open_url_worker(self, url, label):
        # Prefer Firefox, but do not make it a hard dependency.
        browser = shutil.which("firefox")
        if browser:
            command = (browser, url)
        else:
            opener = shutil.which("xdg-open")
            if not opener:
                self.report_error("No browser opener is available for " + label + ".")
                return
            command = (opener, url)
        try:
            result = subprocess.run(
                command, env=os.environ.copy(), text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                check=False, timeout=15,
            )
        except (OSError, subprocess.SubprocessError) as error:
            self.report_error(f"Could not open {label}:\n{error}")
            return
        if result.returncode:
            detail = (result.stderr or result.stdout).strip()
            self.report_error(
                f"Could not open {label}:\n" +
                (detail or f"xdg-open exited with status {result.returncode}")
            )


if __name__ == "__main__":
    app = FurnaceSimulation()
    app.show_all()
    Gtk.main()
