#!/usr/bin/env python3
"""Serve the tennis app with JSONBin cloud storage and SQLite backup."""

import json
import mimetypes
import os
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DATABASE = Path(os.environ.get("ACEPOINT_DATABASE", str(DATA_DIR / "tennis.db"))).expanduser()
ENV_FILE = ROOT / ".env"


def load_env_file():
    if not ENV_FILE.exists():
        return
    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))


load_env_file()
JSONBIN_BIN_ID = os.environ.get("JSONBIN_BIN_ID", "").strip()
JSONBIN_ACCESS_KEY = os.environ.get("JSONBIN_ACCESS_KEY", "").strip()
JSONBIN_MASTER_KEY = os.environ.get("JSONBIN_MASTER_KEY", "").strip()
JSONBIN_BASE_URL = "https://api.jsonbin.io/v3/b"
STORAGE_LOCK = threading.RLock()
STORAGE_STATUS = {"configured": bool(JSONBIN_BIN_ID and (JSONBIN_ACCESS_KEY or JSONBIN_MASTER_KEY)), "connected": False, "backend": "sqlite", "message": "JSONBin is not configured"}


class RemoteStorageError(Exception):
    pass


def connect():
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(DATABASE))
    connection.execute(
        "CREATE TABLE IF NOT EXISTS accounts (email TEXT PRIMARY KEY, payload TEXT NOT NULL)"
    )
    return connection


def read_local_accounts():
    with connect() as connection:
        rows = connection.execute("SELECT email, payload FROM accounts").fetchall()
    result = {}
    for email, payload in rows:
        try:
            result[email] = json.loads(payload)
        except json.JSONDecodeError:
            continue
    return result


def write_local_accounts(accounts):
    if not isinstance(accounts, dict):
        raise ValueError("Account data must be an object")
    with connect() as connection:
        connection.execute("DELETE FROM accounts")
        connection.executemany(
            "INSERT INTO accounts (email, payload) VALUES (?, ?)",
            [
                (str(email), json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
                for email, payload in accounts.items()
            ],
        )


def jsonbin_headers(include_content_type=False):
    headers = {"X-Bin-Meta": "false", "User-Agent": "AcePoint/1.0"}
    if JSONBIN_ACCESS_KEY:
        headers["X-Access-Key"] = JSONBIN_ACCESS_KEY
    else:
        headers["X-Master-Key"] = JSONBIN_MASTER_KEY
    if include_content_type:
        headers["Content-Type"] = "application/json"
        headers["X-Bin-Versioning"] = "false"
    return headers


def jsonbin_request(method, payload=None):
    if not STORAGE_STATUS["configured"]:
        raise RemoteStorageError("JSONBin is not configured")
    url = "%s/%s%s" % (JSONBIN_BASE_URL, JSONBIN_BIN_ID, "/latest?meta=false" if method == "GET" else "")
    body = None if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = Request(url, data=body, headers=jsonbin_headers(body is not None), method=method)
    try:
        with urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))
        return result.get("record", result) if isinstance(result, dict) else result
    except HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8")).get("message", str(error))
        except Exception:
            detail = str(error)
        raise RemoteStorageError("JSONBin returned an error: %s" % detail) from error
    except (URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise RemoteStorageError("Could not connect to JSONBin: %s" % error) from error


def read_accounts():
    with STORAGE_LOCK:
        if not STORAGE_STATUS["configured"]:
            return read_local_accounts()
        try:
            accounts = jsonbin_request("GET")
            if not isinstance(accounts, dict):
                raise RemoteStorageError("The JSONBin record is not an account object")
            write_local_accounts(accounts)
            STORAGE_STATUS.update(connected=True, backend="jsonbin", message="Connected to JSONBin")
            return accounts
        except RemoteStorageError as error:
            STORAGE_STATUS.update(connected=False, backend="sqlite-backup", message=str(error))
            print("JSONBin read fallback:", error)
            return read_local_accounts()


def write_accounts(accounts):
    if not isinstance(accounts, dict):
        raise ValueError("Account data must be an object")
    with STORAGE_LOCK:
        write_local_accounts(accounts)
        if not STORAGE_STATUS["configured"]:
            return "sqlite"
        try:
            jsonbin_request("PUT", accounts)
            STORAGE_STATUS.update(connected=True, backend="jsonbin", message="Synced to JSONBin")
            return "jsonbin"
        except RemoteStorageError as error:
            STORAGE_STATUS.update(connected=False, backend="sqlite-backup", message=str(error))
            raise


class TennisHandler(BaseHTTPRequestHandler):
    server_version = "AcePoint/1.0"

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/storage-status":
            self.send_json(200, {
                "configured": STORAGE_STATUS["configured"],
                "connected": STORAGE_STATUS["connected"],
                "backend": STORAGE_STATUS["backend"],
                "message": STORAGE_STATUS["message"],
            })
            return
        if path == "/api/accounts":
            self.send_json(200, read_accounts())
            return
        self.serve_file(path, include_body=True)

    def do_HEAD(self):
        self.serve_file(urlparse(self.path).path, include_body=False)

    def do_PUT(self):
        if urlparse(self.path).path != "/api/accounts":
            self.send_json(404, {"error": "API endpoint not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 5 * 1024 * 1024:
                self.send_json(413, {"error": "The account data is too large"})
                return
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            backend = write_accounts(payload)
            self.send_json(200, {"saved": True, "storage": backend})
        except RemoteStorageError as error:
            self.send_json(502, {
                "error": "The data was saved to the local backup, but JSONBin sync failed. %s" % error,
                "savedLocally": True,
            })
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
            self.send_json(400, {"error": str(error)})

    def serve_file(self, request_path, include_body):
        relative = unquote(request_path).lstrip("/") or "index.html"
        candidate = (ROOT / relative).resolve()
        if ROOT not in candidate.parents or not candidate.is_file():
            self.send_error(404, "Not Found")
            return
        file_size = candidate.stat().st_size
        content_type = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
            content_type += "; charset=utf-8"
        start, end = 0, file_size - 1
        range_header = self.headers.get("Range", "")
        partial = False
        if range_header.startswith("bytes="):
            try:
                values = range_header[6:].split("-", 1)
                start = int(values[0]) if values[0] else 0
                end = int(values[1]) if values[1] else file_size - 1
                end = min(end, file_size - 1)
                if start < 0 or start > end:
                    raise ValueError
                partial = True
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % file_size)
                self.end_headers()
                return
        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, file_size))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if include_body:
            with candidate.open("rb") as source:
                source.seek(start)
                remaining = length
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)

    def log_message(self, format_string, *args):
        print("%s - %s" % (self.address_string(), format_string % args))


if __name__ == "__main__":
    with connect():
        pass
    port = int(os.environ.get("PORT", "4173"))
    host = os.environ.get("HOST", "127.0.0.1")
    address = (host, port)
    print("Tennis website: http://%s:%d/" % (host, port))
    print("SQLite database: %s" % DATABASE)
    ThreadingHTTPServer(address, TennisHandler).serve_forever()
