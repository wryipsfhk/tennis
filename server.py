#!/usr/bin/env python3
"""Serve the tennis app with JSONBin cloud storage and SQLite backup."""

import json
import base64
import hashlib
import hmac
import mimetypes
import os
import re
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
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
VIDEO_DIR = DATA_DIR / "private-videos"
MAX_VIDEO_BYTES = 120 * 1024 * 1024
CHUNK_BYTES = 4 * 1024 * 1024
SESSION_SECRET = (os.environ.get("ACEPOINT_SESSION_SECRET") or JSONBIN_ACCESS_KEY or JSONBIN_MASTER_KEY or "acepoint-local-development-secret-v2").encode("utf-8")


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


def account_id(email):
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()


def normalize_account(source, email):
    return {"schemaVersion": 2, "id": account_id(email), "name": str(source.get("name") or "Player")[:100], "email": email, "passwordHash": str(source.get("passwordHash") or ""), "sessionVersion": int(source.get("sessionVersion") or 1), "matches": source.get("matches") if isinstance(source.get("matches"), list) else [], "goals": source.get("goals") if isinstance(source.get("goals"), list) else [], "scheduledMatches": source.get("scheduledMatches") if isinstance(source.get("scheduledMatches"), list) else [], "exercises": source.get("exercises") if isinstance(source.get("exercises"), list) else [], "analyses": source.get("analyses") if isinstance(source.get("analyses"), list) else [], "createdAt": source.get("createdAt") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def public_account(account):
    return {key: value for key, value in account.items() if key not in {"id", "passwordHash", "sessionVersion"}}


def encode_token(payload, purpose="session"):
    raw = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    signature = base64.urlsafe_b64encode(hmac.new(SESSION_SECRET, (purpose + "." + raw).encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return raw + "." + signature


def decode_token(token, purpose="session"):
    try:
        raw, supplied = token.split(".", 1)
        expected = base64.urlsafe_b64encode(hmac.new(SESSION_SECRET, (purpose + "." + raw).encode(), hashlib.sha256).digest()).decode().rstrip("=")
        if not hmac.compare_digest(supplied, expected):
            raise ValueError
        payload = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        if payload.get("exp", 0) <= int(time.time()):
            raise ValueError
        return payload
    except Exception as error:
        raise ValueError("Session expired.") from error


def save_account(account):
    accounts = read_local_accounts()
    accounts[account["email"]] = account
    write_local_accounts(accounts)


def analysis_owned(account, analysis_id):
    return any(str(item.get("id")) == analysis_id for item in account.get("analyses", []))


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

    def read_json(self, limit=4 * 1024 * 1024):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > limit:
            raise ValueError("Request data is too large or empty.")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def authorized_account(self):
        header = self.headers.get("Authorization", "")
        claims = decode_token(header[7:] if header.startswith("Bearer ") else "")
        account = read_local_accounts().get(claims.get("email"))
        if not account or account.get("id") != claims.get("sub") or int(account.get("sessionVersion", 1)) != int(claims.get("sv", 1)):
            raise ValueError("Session expired.")
        return account

    def video_route(self, path):
        match = re.fullmatch(r"/(?:api/videos|acepoint-cloud/video)/([A-Za-z0-9_-]{8,80})(?:/(chunk|complete|ticket))?", path)
        return match.groups() if match else None

    def do_GET(self):
        parsed = urlparse(self.path); path = parsed.path
        if path in {"/api/storage-status", "/acepoint-cloud/status"}:
            self.send_json(200, {"configured": True, "connected": True, "backend": "local-private-storage", "message": "Private local account and video storage available"})
            return
        if path in {"/api/account", "/acepoint-cloud/player"}:
            try:
                account = self.authorized_account(); self.send_json(200, {"account": public_account(account), "storage": "local-private-storage"})
            except ValueError as error:
                self.send_json(401, {"error": str(error)})
            return
        route = self.video_route(path)
        if route and not route[1]:
            analysis_id = route[0]
            try:
                ticket = parse_qs(parsed.query).get("ticket", [""])[0]
                if ticket:
                    claims = decode_token(ticket, "video")
                    if claims.get("aid") != analysis_id: raise ValueError("Video authorization expired.")
                    account = next((item for item in read_local_accounts().values() if item.get("id") == claims.get("sub")), None)
                else: account = self.authorized_account()
                if not account or not analysis_owned(account, analysis_id): raise ValueError("Video analysis not found.")
                video = VIDEO_DIR / account["id"] / analysis_id / "video.bin"; manifest_path = video.with_name("manifest.json")
                if not video.is_file() or not manifest_path.is_file(): raise FileNotFoundError
                manifest = json.loads(manifest_path.read_text()); size = video.stat().st_size; start, end = 0, min(size - 1, CHUNK_BYTES - 1); partial = size > CHUNK_BYTES
                header = self.headers.get("Range", "")
                if header.startswith("bytes="):
                    left, right = header[6:].split("-", 1); start = int(left or 0); end = min(int(right) if right else size - 1, size - 1, start + CHUNK_BYTES - 1); partial = True
                if start < 0 or start > end or start >= size: raise ValueError("Invalid range.")
                length = end - start + 1; self.send_response(206 if partial else 200); self.send_header("Content-Type", manifest["contentType"]); self.send_header("Content-Length", str(length)); self.send_header("Accept-Ranges", "bytes"); self.send_header("Cache-Control", "private, no-store")
                if partial: self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
                self.end_headers()
                with video.open("rb") as source: source.seek(start); self.wfile.write(source.read(length))
            except FileNotFoundError: self.send_json(404, {"error": "The source video has not been synced."})
            except ValueError as error: self.send_json(401 if "authorization" in str(error).lower() or "Session" in str(error) else 400, {"error": str(error)})
            return
        self.serve_file(path, include_body=True)

    def do_HEAD(self):
        self.serve_file(urlparse(self.path).path, include_body=False)

    def do_PUT(self):
        if urlparse(self.path).path not in {"/api/account", "/acepoint-cloud/player"}:
            self.send_json(404, {"error": "API endpoint not found"})
            return
        try:
            stored = self.authorized_account(); incoming = self.read_json(); incoming.update({"email": stored["email"], "passwordHash": stored["passwordHash"], "sessionVersion": stored.get("sessionVersion", 1), "createdAt": stored.get("createdAt")}); account = normalize_account(incoming, stored["email"]); save_account(account); self.send_json(200, {"saved": True, "account": public_account(account), "storage": "local-private-storage"})
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
            self.send_json(401 if "Session" in str(error) else 400, {"error": str(error)})

    def do_POST(self):
        path = urlparse(self.path).path
        if path in {"/api/auth", "/acepoint-cloud/session"}:
            try:
                body = self.read_json(); action = str(body.get("action") or "login"); email = str(body.get("email") or "").strip().lower(); password_hash = str(body.get("passwordHash") or "")
                if not re.fullmatch(r"\S+@\S+\.\S+", email) or not re.fullmatch(r"[0-9a-f]{64}", password_hash): raise ValueError("Enter a valid email and password.")
                accounts = read_local_accounts(); source = accounts.get(email)
                if not source and STORAGE_STATUS["configured"]:
                    source = read_accounts().get(email)
                if action == "signup":
                    if source: self.send_json(409, {"error": "An account already exists for this email. Please sign in."}); return
                    account = normalize_account({"name": body.get("name"), "email": email, "passwordHash": password_hash}, email); save_account(account)
                else:
                    if not source: self.send_json(401, {"error": "No account was found for this email." if action == "reset" else "Incorrect email or password. Create an account first if you are new."}); return
                    account = normalize_account(source, email)
                    if action == "reset": account["passwordHash"] = password_hash; account["sessionVersion"] += 1; save_account(account); self.send_json(200, {"updated": True}); return
                    if account["passwordHash"] != password_hash: self.send_json(401, {"error": "Incorrect email or password. Create an account first if you are new."}); return
                save_account(account); now = int(time.time()); token = encode_token({"sub": account["id"], "email": email, "sv": account["sessionVersion"], "iat": now, "exp": now + 30 * 86400}); self.send_json(201 if action == "signup" else 200, {"token": token, "account": public_account(account), "storage": "local-private-storage"})
            except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error: self.send_json(400, {"error": str(error)})
            return
        route = self.video_route(path)
        if not route: self.send_json(404, {"error": "API endpoint not found"}); return
        analysis_id, action = route
        try:
            account = self.authorized_account()
            if not analysis_owned(account, analysis_id): self.send_json(404, {"error": "Video analysis not found."}); return
            folder = VIDEO_DIR / account["id"] / analysis_id; folder.mkdir(parents=True, exist_ok=True)
            if action == "ticket":
                now = int(time.time()); ticket = encode_token({"sub": account["id"], "aid": analysis_id, "exp": now + 600}, "video"); self.send_json(200, {"videoUrl": "/acepoint-cloud/video/%s?ticket=%s" % (analysis_id, ticket), "expiresIn": 600}); return
            if action == "chunk":
                index = int(self.headers.get("X-Chunk-Index", "-1")); total = int(self.headers.get("X-Total-Chunks", "0")); size = int(self.headers.get("X-File-Size", "0")); length = int(self.headers.get("Content-Length", "0"))
                if index < 0 or total < 1 or size < 1 or size > MAX_VIDEO_BYTES or length < 1 or length > CHUNK_BYTES: raise ValueError("Invalid video chunk metadata.")
                (folder / ("chunk-%04d" % index)).write_bytes(self.rfile.read(length)); self.send_json(200, {"uploaded": index + 1, "totalChunks": total}); return
            if action == "complete":
                body = self.read_json(); total = int(body["totalChunks"]); size = int(body["fileSize"]); chunks = [folder / ("chunk-%04d" % index) for index in range(total)]
                if size < 1 or size > MAX_VIDEO_BYTES or not all(item.is_file() for item in chunks): raise ValueError("One or more video parts are missing.")
                target = folder / "video.bin"
                with target.open("wb") as output:
                    for chunk in chunks: output.write(chunk.read_bytes()); chunk.unlink()
                if target.stat().st_size != size: target.unlink(); raise ValueError("The uploaded video size did not match.")
                (folder / "manifest.json").write_text(json.dumps({"contentType": str(body.get("contentType") or "application/octet-stream"), "fileName": str(body.get("fileName") or "match-video"), "fileSize": size})); self.send_json(201, {"saved": True, "videoUrl": "/acepoint-cloud/video/" + analysis_id}); return
            self.send_json(405, {"error": "This request method is not supported."})
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, KeyError) as error: self.send_json(401 if "Session" in str(error) else 400, {"error": str(error)})

    def do_DELETE(self):
        route = self.video_route(urlparse(self.path).path)
        if not route or route[1]: self.send_json(404, {"error": "API endpoint not found"}); return
        try:
            account = self.authorized_account(); analysis_id = route[0]
            if not analysis_owned(account, analysis_id): self.send_json(404, {"error": "Video analysis not found."}); return
            folder = VIDEO_DIR / account["id"] / analysis_id
            if folder.is_dir():
                for item in folder.iterdir(): item.unlink()
                folder.rmdir()
            self.send_json(200, {"deleted": True})
        except ValueError as error: self.send_json(401, {"error": str(error)})

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
