#!/usr/bin/env python3
"""Tool Vault admin API.

Single-admin CRUD for the front-end data file (``assets/js/data.js``).
Runs behind nginx on 127.0.0.1:8787; never exposed directly.
"""

from __future__ import annotations

import fcntl
import glob
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sqlite3
import sys
import time
from datetime import datetime, timezone
from functools import wraps
from urllib.parse import urlparse

from flask import (
    Flask,
    g,
    jsonify,
    make_response,
    redirect,
    request,
    send_from_directory,
)
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_FILE = os.environ.get(
    "TV_DATA_FILE",
    os.path.abspath(os.path.join(BASE_DIR, "..", "web", "assets", "js", "data.js")),
)
BACKUP_DIR = os.path.join(BASE_DIR, "backups")
DB_PATH = os.environ.get("TV_DB", os.path.join(BASE_DIR, "admin.db"))
LOCK_PATH = os.path.join(BASE_DIR, "data.lock")
AUDIT_LOG = os.path.join(BASE_DIR, "audit.log")

SESSION_TTL = 12 * 3600
COOKIE_NAME = "tv_admin"
# Set TV_COOKIE_SECURE=0 only for plain-HTTP local development.
COOKIE_SECURE = os.environ.get("TV_COOKIE_SECURE", "1") != "0"
PASSWORD_MIN = 10
MAX_TOOLS = 500
MAX_BODY = 64 * 1024

def env_set(name: str, default: str) -> set[str]:
    raw = os.environ.get(name, default)
    return {item.strip() for item in raw.split(",") if item.strip()}


# Comma-separated lists, override in production via environment variables.
ALLOWED_HOSTS = env_set(
    "TV_ALLOWED_HOSTS",
    "res.example.com,127.0.0.1:8787,127.0.0.1,localhost:8787,localhost",
)
ALLOWED_ORIGINS = env_set("TV_ALLOWED_ORIGINS", "https://res.example.com")

CATS = {"SYS", "NET", "DEV", "MED", "SEC", "UTL"}
PLATFORMS = {"WIN", "MAC", "LINUX"}
LICENSES = {"开源", "免费", "商业"}

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")
CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")
SLUG_RE = re.compile(r"[^a-z0-9]+")
PASSWORD_METHOD = "pbkdf2:sha256:600000"

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = MAX_BODY
app.config["JSON_AS_ASCII"] = False
try:  # Flask >= 2.3
    app.json.ensure_ascii = False
except Exception:
    pass


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400, errors: dict | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.errors = errors or {}


# --------------------------------------------------------------------------
# database
# --------------------------------------------------------------------------


def init_db() -> None:
    os.makedirs(BACKUP_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                csrf TEXT NOT NULL,
                created REAL NOT NULL,
                expires REAL NOT NULL,
                ip TEXT
            );
            CREATE TABLE IF NOT EXISTS attempts (
                ip TEXT NOT NULL,
                ts REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_attempts ON attempts(ip, ts);
            """
        )
        conn.commit()
    finally:
        conn.close()


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        db = sqlite3.connect(DB_PATH, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=5000")
        g.db = db
    return g.db


@app.teardown_appcontext
def close_db(_exc) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def get_setting(key: str, default: str | None = None) -> str | None:
    row = get_db().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    db = get_db()
    db.execute(
        "INSERT INTO settings(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
    db.commit()


# --------------------------------------------------------------------------
# auth helpers
# --------------------------------------------------------------------------


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def client_ip() -> str:
    return (request.headers.get("X-Real-IP") or request.remote_addr or "?").strip()


def recent_failures(ip: str) -> int:
    cutoff = time.time() - 600
    db = get_db()
    db.execute("DELETE FROM attempts WHERE ts < ?", (cutoff,))
    row = db.execute(
        "SELECT COUNT(*) AS n FROM attempts WHERE ip=? AND ts>=?", (ip, cutoff)
    ).fetchone()
    return int(row["n"])


def create_session(ip: str) -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_hex(24)
    now = time.time()
    db = get_db()
    db.execute("DELETE FROM sessions WHERE expires < ?", (now,))
    db.execute(
        "INSERT INTO sessions(token_hash, csrf, created, expires, ip) "
        "VALUES(?,?,?,?,?)",
        (hash_token(token), csrf, now, now + SESSION_TTL, ip),
    )
    db.commit()
    return token, csrf


def current_session() -> sqlite3.Row | None:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    row = get_db().execute(
        "SELECT * FROM sessions WHERE token_hash=?", (hash_token(token),)
    ).fetchone()
    if row is None or float(row["expires"]) < time.time():
        return None
    return row


def set_session_cookie(resp, token: str):
    resp.set_cookie(
        COOKIE_NAME,
        token,
        max_age=SESSION_TTL,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="Strict",
        path="/",
    )
    return resp


def require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        session = current_session()
        if session is None:
            return jsonify(ok=False, error="未登录或会话已过期"), 401
        g.session = session
        return fn(*args, **kwargs)

    return wrapper


def require_csrf(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        session = current_session()
        if session is None:
            return jsonify(ok=False, error="未登录或会话已过期"), 401
        token = request.headers.get("X-CSRF-Token", "")
        if not token or not hmac.compare_digest(token, session["csrf"]):
            return jsonify(ok=False, error="CSRF 校验失败，请刷新页面"), 403
        g.session = session
        return fn(*args, **kwargs)

    return wrapper


# --------------------------------------------------------------------------
# data.js read / write
# --------------------------------------------------------------------------


def strip_js_comments(text: str) -> str:
    """Remove /* ... */ and // comments without touching string literals."""
    out: list[str] = []
    i = 0
    quote = ""
    escaped = False
    while i < len(text):
        ch = text[i]
        if quote:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                quote = ""
            i += 1
            continue
        if ch in "\"'":
            quote = ch
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < len(text) and text[i + 1] == "*":
            end = text.find("*/", i + 2)
            if end == -1:
                break
            out.append(" ")
            i = end + 2
            continue
        if ch == "/" and i + 1 < len(text) and text[i + 1] == "/":
            end = text.find("\n", i + 2)
            i = len(text) if end == -1 else end
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def read_tools() -> list[dict]:
    with open(DATA_FILE, "r", encoding="utf-8") as fh:
        text = fh.read()
    marker = text.index("window.TOOLS")
    start = text.index("[", marker)
    end = text.rindex("]")
    data = json.loads(strip_js_comments(text[start : end + 1]))
    if not isinstance(data, list):
        raise ValueError("data.js 不是数组")
    for item in data:
        if not isinstance(item, dict):
            raise ValueError("data.js 条目格式错误")
    return data


def tools_payload(tools: list[dict]) -> str:
    body = json.dumps(tools, ensure_ascii=False, indent=2)
    return (
        "/* TOOL VAULT DATA - managed via /admin/ */\n"
        "window.TOOLS = " + body + ";\n"
    )


def backup_data_file() -> None:
    os.makedirs(BACKUP_DIR, exist_ok=True)
    if not os.path.exists(DATA_FILE):
        return
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    shutil.copy2(DATA_FILE, os.path.join(BACKUP_DIR, f"data-{stamp}.js"))
    old = sorted(glob.glob(os.path.join(BACKUP_DIR, "data-*.js")))
    for path in old[:-30]:
        try:
            os.remove(path)
        except OSError:
            pass


def mutate_tools(fn):
    """Run fn(tools) under an exclusive lock, then atomically replace data.js."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    with open(LOCK_PATH, "w", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            tools = read_tools()
            result = fn(tools)
            payload = tools_payload(tools)
            backup_data_file()
            tmp = DATA_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())
            os.chmod(tmp, 0o644)
            os.replace(tmp, DATA_FILE)
            return result
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def stats_for(tools: list[dict]) -> dict:
    return {
        "total": len(tools),
        "oss": sum(1 for t in tools if t.get("license") == "开源"),
        "cats": len({t.get("cat") for t in tools if t.get("cat") in CATS}),
    }


def stats() -> dict:
    return stats_for(read_tools())


def audit(action: str, target: str = "", **extra) -> None:
    record = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "action": action,
        "id": target,
        "ip": client_ip(),
    }
    record.update(extra)
    try:
        with open(AUDIT_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        app.logger.exception("audit log write failed")


# --------------------------------------------------------------------------
# validation
# --------------------------------------------------------------------------


def validate_tool(
    data: dict, existing_ids: set[str], current_id: str | None = None
) -> dict:
    errors: dict[str, str] = {}

    def text(key: str, label: str, max_len: int, required: bool = False) -> str:
        value = data.get(key, "")
        if value is None:
            value = ""
        if not isinstance(value, str):
            errors[key] = f"{label}格式错误"
            return ""
        value = value.strip()
        if required and not value:
            errors[key] = f"{label}不能为空"
        elif len(value) > max_len:
            errors[key] = f"{label}不能超过 {max_len} 字"
        elif CTRL_RE.search(value):
            errors[key] = f"{label}包含不可见控制字符"
        return value

    name = text("name", "名称", 60, True)
    vendor = text("vendor", "厂商", 60)
    desc = text("desc", "说明", 200, True)
    url = text("url", "链接", 500, True)

    if url and not errors.get("url"):
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            errors["url"] = "链接必须是 http:// 或 https:// 开头"
        elif " " in url:
            errors["url"] = "链接不能包含空格"

    cat = data.get("cat")
    if cat not in CATS:
        errors["cat"] = "分类不合法"

    license_value = data.get("license")
    if license_value not in LICENSES:
        errors["license"] = "授权不合法"

    platforms = data.get("platforms")
    clean_platforms: list[str] = []
    if not isinstance(platforms, list) or not platforms:
        errors["platforms"] = "至少选择一个平台"
    else:
        for item in platforms:
            if isinstance(item, str) and item in PLATFORMS and item not in clean_platforms:
                clean_platforms.append(item)
        if not clean_platforms:
            errors["platforms"] = "平台取值不合法"

    tags_value = data.get("tags", [])
    if isinstance(tags_value, str):
        tags_value = [part for part in re.split(r"[,，]", tags_value)]
    if not isinstance(tags_value, list):
        errors["tags"] = "标签格式错误"
        tags_value = []
    clean_tags: list[str] = []
    for part in tags_value:
        if not isinstance(part, str):
            errors["tags"] = "标签格式错误"
            break
        part = part.strip()
        if not part:
            continue
        if len(part) > 20:
            errors["tags"] = "单个标签不能超过 20 字"
            break
        if CTRL_RE.search(part):
            errors["tags"] = "标签包含不可见控制字符"
            break
        if part not in clean_tags:
            clean_tags.append(part)
    if len(clean_tags) > 8:
        errors["tags"] = "标签最多 8 个"

    if current_id:
        tool_id = current_id
    else:
        raw_id = data.get("id", "")
        if raw_id is None:
            raw_id = ""
        if not isinstance(raw_id, str):
            raw_id = ""
        raw_id = raw_id.strip()
        if raw_id:
            if not ID_RE.match(raw_id):
                errors["id"] = "ID 只能用小写字母、数字和连字符，2–40 位"
            elif raw_id in existing_ids:
                errors["id"] = "这个 ID 已存在"
            tool_id = raw_id
        else:
            base = SLUG_RE.sub("-", name.lower()).strip("-")[:30] or "tool"
            tool_id = base
            suffix = 2
            while tool_id in existing_ids:
                tool_id = f"{base}-{suffix}"
                suffix += 1

    if errors:
        raise ApiError("请检查输入", 400, errors)

    return {
        "id": tool_id,
        "name": name,
        "vendor": vendor,
        "cat": cat,
        "platforms": clean_platforms,
        "license": license_value,
        "tags": clean_tags,
        "desc": desc,
        "url": url,
    }


# --------------------------------------------------------------------------
# guard / headers / errors
# --------------------------------------------------------------------------


@app.before_request
def guard_request():
    if request.host.lower() not in ALLOWED_HOSTS:
        return jsonify(ok=False, error="非法 Host"), 400
    if request.method in {"POST", "PUT", "DELETE", "PATCH"}:
        origin = request.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            return jsonify(ok=False, error="非法来源"), 403
    return None


@app.after_request
def security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cache-Control"] = "no-store"
    if request.path.startswith("/admin"):
        resp.headers["X-Robots-Tag"] = "noindex, nofollow"
        resp.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; font-src 'self'; "
            "base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        )
    return resp


@app.errorhandler(ApiError)
def handle_api_error(err: ApiError):
    return jsonify(ok=False, error=err.message, errors=err.errors), err.status


@app.errorhandler(413)
def handle_too_large(_err):
    return jsonify(ok=False, error="请求体过大"), 413


@app.errorhandler(404)
def handle_not_found(_err):
    if request.path.startswith("/api/"):
        return jsonify(ok=False, error="接口不存在"), 404
    return jsonify(ok=False, error="页面不存在"), 404


# --------------------------------------------------------------------------
# admin static
# --------------------------------------------------------------------------


@app.get("/admin")
def admin_redirect():
    return redirect("/admin/", code=301)


@app.get("/admin/")
def admin_index():
    response = make_response(send_from_directory(STATIC_DIR, "admin.html"))
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/admin/<path:filename>")
def admin_asset(filename: str):
    response = make_response(send_from_directory(STATIC_DIR, filename))
    response.headers["Cache-Control"] = "no-store"
    return response


# --------------------------------------------------------------------------
# api
# --------------------------------------------------------------------------


@app.get("/api/health")
def api_health():
    return jsonify(ok=True, service="tool-vault-admin")


@app.post("/api/login")
def api_login():
    data = request.get_json(silent=True) or {}
    password = data.get("password")
    if not isinstance(password, str) or not password:
        return jsonify(ok=False, error="请输入口令"), 400

    ip = client_ip()
    if recent_failures(ip) >= 6:
        return jsonify(ok=False, error="尝试次数过多，请 10 分钟后再试"), 429

    stored = get_setting("password_hash")
    if not stored:
        return jsonify(ok=False, error="后台尚未设置口令"), 503

    if not check_password_hash(stored, password):
        db = get_db()
        db.execute("INSERT INTO attempts(ip, ts) VALUES(?,?)", (ip, time.time()))
        db.commit()
        audit("login_failed")
        return jsonify(ok=False, error="口令错误"), 401

    db = get_db()
    db.execute("DELETE FROM attempts WHERE ip=?", (ip,))
    db.commit()

    token, csrf = create_session(ip)
    response = jsonify(ok=True, csrf=csrf, stats=stats())
    set_session_cookie(response, token)
    audit("login")
    return response


@app.get("/api/me")
def api_me():
    session = current_session()
    if session is None:
        return jsonify(ok=False, error="未登录"), 401
    return jsonify(ok=True, csrf=session["csrf"], stats=stats())


@app.post("/api/logout")
@require_csrf
def api_logout():
    token = request.cookies.get(COOKIE_NAME)
    if token:
        db = get_db()
        db.execute("DELETE FROM sessions WHERE token_hash=?", (hash_token(token),))
        db.commit()
    response = jsonify(ok=True)
    response.delete_cookie(COOKIE_NAME, path="/")
    audit("logout")
    return response


@app.get("/api/tools")
@require_auth
def api_list_tools():
    try:
        tools = read_tools()
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        app.logger.exception("read data.js failed")
        return jsonify(ok=False, error=f"读取数据失败：{exc}"), 500
    return jsonify(ok=True, tools=tools, stats=stats_for(tools))


@app.post("/api/tools")
@require_csrf
def api_add_tool():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(ok=False, error="请求格式错误"), 400

    def op(tools):
        if len(tools) >= MAX_TOOLS:
            raise ApiError(f"最多收录 {MAX_TOOLS} 条", 400)
        tool = validate_tool(data, {t.get("id") for t in tools})
        tools.insert(0, tool)
        return tool

    tool = mutate_tools(op)
    audit("add", tool["id"], name=tool["name"])
    return jsonify(ok=True, tool=tool, stats=stats())


@app.put("/api/tools/<tool_id>")
@require_csrf
def api_update_tool(tool_id: str):
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(ok=False, error="请求格式错误"), 400

    def op(tools):
        target = None
        index = -1
        for i, item in enumerate(tools):
            if item.get("id") == tool_id:
                target = item
                index = i
                break
        if target is None:
            raise ApiError("资源不存在", 404)
        tool = validate_tool(
            data, {t.get("id") for t in tools if t.get("id") != tool_id}, tool_id
        )
        tools[index] = tool
        return tool

    tool = mutate_tools(op)
    audit("update", tool["id"], name=tool["name"])
    return jsonify(ok=True, tool=tool, stats=stats())


@app.delete("/api/tools/<tool_id>")
@require_csrf
def api_delete_tool(tool_id: str):
    def op(tools):
        for index, item in enumerate(tools):
            if item.get("id") == tool_id:
                return tools.pop(index)
        raise ApiError("资源不存在", 404)

    tool = mutate_tools(op)
    audit("delete", tool_id, name=tool.get("name", ""))
    return jsonify(ok=True, tool=tool, stats=stats())


@app.post("/api/password")
@require_csrf
def api_change_password():
    data = request.get_json(silent=True) or {}
    current = data.get("current")
    new = data.get("next")
    if not isinstance(current, str) or not isinstance(new, str):
        return jsonify(ok=False, error="请求格式错误"), 400
    stored = get_setting("password_hash")
    if not stored or not check_password_hash(stored, current):
        return jsonify(ok=False, error="当前口令不正确", errors={"current": "当前口令不正确"}), 400
    if len(new) < PASSWORD_MIN:
        return jsonify(ok=False, error=f"新口令至少 {PASSWORD_MIN} 位", errors={"next": f"至少 {PASSWORD_MIN} 位"}), 400
    if len(new) > 128:
        return jsonify(ok=False, error="新口令过长", errors={"next": "不能超过 128 位"}), 400
    if new == current:
        return jsonify(ok=False, error="新口令不能与当前口令相同", errors={"next": "不能与当前口令相同"}), 400
    if CTRL_RE.search(new):
        return jsonify(ok=False, error="新口令包含控制字符", errors={"next": "包含控制字符"}), 400

    set_setting("password_hash", generate_password_hash(new, method=PASSWORD_METHOD))
    db = get_db()
    db.execute("DELETE FROM sessions")
    db.commit()

    token, csrf = create_session(client_ip())
    response = jsonify(ok=True, csrf=csrf)
    set_session_cookie(response, token)
    audit("password_change")
    return response


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def cli_set_password(password: str) -> None:
    init_db()
    conn = sqlite3.connect(DB_PATH, timeout=10)
    try:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES('password_hash', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (generate_password_hash(password, method=PASSWORD_METHOD),),
        )
        conn.execute("DELETE FROM sessions")
        conn.commit()
    finally:
        conn.close()


init_db()


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "set-password":
        raw = sys.stdin.read().strip()
        if len(raw) < PASSWORD_MIN:
            print(f"口令至少 {PASSWORD_MIN} 位", file=sys.stderr)
            sys.exit(1)
        cli_set_password(raw)
        print("password updated")
        sys.exit(0)
    if len(sys.argv) >= 2 and sys.argv[1] == "init":
        init_db()
        print("initialized")
        sys.exit(0)
    print("usage: python3 app.py set-password < password.txt", file=sys.stderr)
    sys.exit(2)
