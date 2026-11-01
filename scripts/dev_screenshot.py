#!/usr/bin/env python3
"""Screenshot pages of the local dev app, signed in, after their data has loaded.

    python3 scripts/dev_screenshot.py /v2/buying out.png
    python3 scripts/dev_screenshot.py /v2 /tmp/dash.png --width 2560 --height 1440 --full
    python3 scripts/dev_screenshot.py /v2/buying out.png --character "Zodox Einharjar" --wait 4
    python3 scripts/dev_screenshot.py /v2/buying out.png --click "Show all"   # press a button first

Signs in through /auth/dev-login (needs DEV_LOGIN_ENABLED=true in .env.dev and the
dev stack running), then drives headless Firefox over its built-in Marionette
protocol so it can wait for client-side fetches — plain `firefox --screenshot`
fires at the load event, before the page's data arrives. No dependencies beyond
Firefox itself.
"""

import argparse
import base64
import json
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.parse import quote


class Marionette:
    """Minimal client for Firefox's Marionette protocol: `<len>:<json>` frames over TCP."""

    def __init__(self, port: int):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=60)
        self.msg_id = 0
        self._recv()  # server hello

    def _recv(self):
        buf = b""
        while b":" not in buf:
            buf += self.sock.recv(1)
        length, rest = buf.split(b":", 1)
        data = rest
        while len(data) < int(length):
            data += self.sock.recv(int(length) - len(data))
        return json.loads(data)

    def call(self, command: str, params: dict | None = None):
        self.msg_id += 1
        payload = json.dumps([0, self.msg_id, command, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            _, msg_id, error, result = self._recv()
            if msg_id == self.msg_id:
                if error:
                    raise RuntimeError(f"{command}: {error.get('message', error)}")
                return result


def wait_for_port(port: int, timeout: float = 30) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=1).close()
            return
        except OSError:
            time.sleep(0.25)
    raise RuntimeError("Firefox's Marionette port never opened")


# Ready when no loading placeholders are left (skeletons, aria-busy, loading class).
_READY_JS = """
return !document.querySelector('[aria-busy="true"], .animate-pulse, .is-loading')
  && document.readyState === 'complete';
"""


_CLICK_JS = """
const text = arguments[0];
const el = [...document.querySelectorAll('button, a, [role="tab"]')]
  .find(e => e.textContent.trim().startsWith(text));
if (!el) return false;
el.click();
return true;
"""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("path", help="app path, e.g. /v2/buying")
    ap.add_argument("out", help="PNG file to write")
    ap.add_argument("--base", default="http://localhost")
    ap.add_argument("--character", help="character name or ID (default: first in the database)")
    ap.add_argument("--width", type=int, default=2560)
    ap.add_argument("--height", type=int, default=1440)
    ap.add_argument("--full", action="store_true", help="capture the whole page, not just the viewport")
    ap.add_argument("--wait", type=float, default=2.0, help="extra seconds after the page looks ready")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--click", action="append", default=[],
                    help="click the first button/link whose text starts with this, after load (repeatable)")
    args = ap.parse_args()

    port = 2828 + (int(time.time()) % 1000)
    profile = tempfile.mkdtemp(prefix="eve-dev-shot-")
    with open(f"{profile}/user.js", "w") as f:
        f.write(f'user_pref("marionette.port", {port});\n')
    proc = subprocess.Popen(
        ["firefox", "--headless", "--marionette", "--no-remote", "--profile", profile],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        wait_for_port(port)
        m = Marionette(port)
        m.call("WebDriver:NewSession", {"capabilities": {}})
        m.call("WebDriver:SetWindowRect", {"width": args.width, "height": args.height})

        login = f"{args.base}/auth/dev-login?next={quote(args.path)}"
        if args.character:
            login += f"&character={quote(args.character)}"
        m.call("WebDriver:Navigate", {"url": login})

        url = m.call("WebDriver:GetCurrentURL")["value"]
        if "/login" in url and "/auth/dev-login" not in args.path:
            raise SystemExit(f"Not signed in (ended at {url}). Is DEV_LOGIN_ENABLED=true and the backend restarted?")

        deadline = time.time() + args.timeout
        while time.time() < deadline:
            if m.call("WebDriver:ExecuteScript", {"script": _READY_JS, "args": []})["value"]:
                break
            time.sleep(0.5)
        time.sleep(args.wait)

        for text in args.click:
            clicked = m.call("WebDriver:ExecuteScript", {"script": _CLICK_JS, "args": [text]})["value"]
            if not clicked:
                raise SystemExit(f"Nothing to click starting with {text!r}")
            time.sleep(args.wait)

        shot = m.call("WebDriver:TakeScreenshot", {"full": args.full, "hash": False})["value"]
        with open(args.out, "wb") as f:
            f.write(base64.b64decode(shot))
        print(f"{args.out} ({url})")
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
