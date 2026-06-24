#!/usr/bin/env python3
"""Tiny save-slot API for the keen456 container.

Stores per-client save-state bundles on the server so they persist beyond the
browser (and across container recreation when SAVE_DIR is a mounted volume).
Saves are scoped by an opaque client-supplied "sync id" — there is no listing
or cross-client access, so on a shared/public host one visitor cannot see
another's saves unless they share their id (which is the intended cross-device
flow). Pages/static hosts have no backend, so the client simply hides the
feature when GET /api/health 404s.

Routes (nginx proxies /api/ here):
  GET    /api/health           -> {"ok": true}
  GET    /api/saves            -> [{"slot","modified","size"}, ...]   (header: X-Client-Id)
  GET    /api/saves/<slot>     -> raw bundle bytes (+ X-Save-Modified header)
  PUT    /api/saves/<slot>     -> store bytes        (headers: X-Client-Id, X-Save-Modified)
  DELETE /api/saves/<slot>     -> remove

`modified` is a client-supplied epoch-ms timestamp (Date.now() at save time),
stored verbatim, so newer-wins comparisons are always client-clock vs
client-clock and never depend on the server clock.
"""
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SAVE_DIR = os.environ.get("SAVE_DIR", "/saves")
PORT = int(os.environ.get("SAVES_API_PORT", "8080"))
MAX_BODY = int(os.environ.get("SAVES_MAX_BYTES", str(16 * 1024 * 1024)))  # 16 MiB

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SLOT_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def client_dir(cid):
    return os.path.join(SAVE_DIR, cid)


def meta_path(cid, slot):
    return os.path.join(client_dir(cid), slot + ".json")


def blob_path(cid, slot):
    return os.path.join(client_dir(cid), slot + ".bin")


class Handler(BaseHTTPRequestHandler):
    server_version = "keen456-saves/1.0"

    # ---- helpers ----
    def _send(self, code, body=b"", ctype="application/octet-stream", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # The Android APK is cross-origin (it runs from https://localhost), so
        # allow any origin — access is gated by the unguessable sync key, not origin.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "X-Save-Modified")
        for k, v in (extra or {}).items():
            self.send_header(k, str(v))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, obj, extra=None):
        self._send(code, json.dumps(obj), "application/json", extra)

    def _cid(self):
        cid = self.headers.get("X-Client-Id", "")
        return cid if ID_RE.match(cid or "") else None

    def _route(self):
        # path like /api/saves or /api/saves/<slot> (ignore query string)
        path = self.path.split("?", 1)[0].rstrip("/")
        parts = [p for p in path.split("/") if p]
        return parts  # e.g. ["api","saves","keen4"]

    def log_message(self, *a):  # quiet
        pass

    # ---- methods ----
    def do_OPTIONS(self):  # CORS preflight (PUT with custom headers triggers it)
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "X-Client-Id, X-Save-Modified, Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parts = self._route()
        if parts == ["api", "health"]:
            return self._json(200, {"ok": True})
        if not parts[:2] == ["api", "saves"]:
            return self._send(404, "not found", "text/plain")
        cid = self._cid()
        if not cid:
            return self._send(400, "bad client id", "text/plain")

        if len(parts) == 2:  # list
            out = []
            d = client_dir(cid)
            if os.path.isdir(d):
                for fn in sorted(os.listdir(d)):
                    if not fn.endswith(".json"):
                        continue
                    slot = fn[:-5]
                    try:
                        with open(os.path.join(d, fn)) as f:
                            m = json.load(f)
                        out.append({"slot": slot,
                                    "modified": int(m.get("modified", 0)),
                                    "size": int(m.get("size", 0))})
                    except Exception:
                        continue
            return self._json(200, out)

        if len(parts) == 3:  # fetch one
            slot = parts[2]
            if not SLOT_RE.match(slot):
                return self._send(400, "bad slot", "text/plain")
            bp = blob_path(cid, slot)
            if not os.path.isfile(bp):
                return self._send(404, "no such slot", "text/plain")
            modified = 0
            try:
                with open(meta_path(cid, slot)) as f:
                    modified = int(json.load(f).get("modified", 0))
            except Exception:
                pass
            with open(bp, "rb") as f:
                data = f.read()
            return self._send(200, data, "application/octet-stream",
                              {"X-Save-Modified": modified})
        return self._send(404, "not found", "text/plain")

    def do_PUT(self):
        parts = self._route()
        if not (len(parts) == 3 and parts[:2] == ["api", "saves"]):
            return self._send(404, "not found", "text/plain")
        cid = self._cid()
        slot = parts[2]
        if not cid:
            return self._send(400, "bad client id", "text/plain")
        if not SLOT_RE.match(slot):
            return self._send(400, "bad slot", "text/plain")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return self._send(413, "bad body size", "text/plain")
        data = self.rfile.read(length)
        try:
            modified = int(self.headers.get("X-Save-Modified", "0"))
        except ValueError:
            modified = 0

        d = client_dir(cid)
        os.makedirs(d, exist_ok=True)
        bp, mp = blob_path(cid, slot), meta_path(cid, slot)
        tmp = bp + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, bp)
        with open(mp, "w") as f:
            json.dump({"modified": modified, "size": len(data)}, f)
        return self._json(200, {"slot": slot, "modified": modified, "size": len(data)})

    def do_DELETE(self):
        parts = self._route()
        if not (len(parts) == 3 and parts[:2] == ["api", "saves"]):
            return self._send(404, "not found", "text/plain")
        cid = self._cid()
        slot = parts[2]
        if not cid or not SLOT_RE.match(slot):
            return self._send(400, "bad request", "text/plain")
        for p in (blob_path(cid, slot), meta_path(cid, slot)):
            try:
                os.remove(p)
            except FileNotFoundError:
                pass
        return self._json(200, {"deleted": slot})


def main():
    os.makedirs(SAVE_DIR, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[keen456] saves-api on 127.0.0.1:{PORT} -> {SAVE_DIR}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
