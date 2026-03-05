import os
import re
import uuid
import struct
import subprocess
import json
import shutil
import sqlite3
import time
import hashlib
import hmac
from pathlib import Path
from datetime import datetime, timedelta, timezone
from collections import defaultdict
from typing import Optional

import bcrypt
import jwt
import httpx

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ===========================================================================
# App Setup
# ===========================================================================
app = FastAPI(title="Vid|Wizo API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path("/tmp/vidwizo/uploads")
OUTPUT_DIR = Path("/tmp/vidwizo/outputs")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

JWT_SECRET = os.environ.get("JWT_SECRET", uuid.uuid4().hex + uuid.uuid4().hex)
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 7

PAYSTACK_SECRET_KEY = os.environ.get("PAYSTACK_SECRET_KEY", "")
YOCO_SECRET_KEY = os.environ.get("YOCO_SECRET_KEY", "")

ADMIN_EMAIL = "thapelodigital@gmail.com"

# ===========================================================================
# Database Setup (SQLite)
# ===========================================================================
DB_PATH = Path("/data/vidwizo.db")
if not DB_PATH.parent.exists():
    DB_PATH = Path("/tmp/vidwizo/vidwizo.db")
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT,
            name TEXT,
            google_id TEXT UNIQUE,
            role TEXT DEFAULT 'user',
            plan TEXT DEFAULT 'free',
            plan_expires_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            api_key TEXT NOT NULL,
            label TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS usage_log (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            feature TEXT NOT NULL,
            model_used TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS subscriptions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            plan TEXT NOT NULL,
            gateway TEXT NOT NULL,
            gateway_ref TEXT,
            status TEXT DEFAULT 'active',
            created_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    """)
    conn.commit()
    conn.close()


# ===========================================================================
# Anonymous rate limiter (in-memory)
# ===========================================================================
_anon_usage: dict[str, list[float]] = defaultdict(list)
ANON_DAILY_LIMIT = 3


def check_anon_limit(ip: str) -> bool:
    """Return True if allowed, False if limit exceeded."""
    now = time.time()
    day_start = now - 86400
    _anon_usage[ip] = [t for t in _anon_usage[ip] if t > day_start]
    return len(_anon_usage[ip]) < ANON_DAILY_LIMIT


def record_anon_usage(ip: str):
    _anon_usage[ip].append(time.time())


# ===========================================================================
# Auth helpers
# ===========================================================================

def create_jwt(user: dict) -> str:
    payload = {
        "sub": user["id"],
        "email": user["email"],
        "role": user["role"],
        "plan": user["plan"],
        "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRE_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_jwt(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except Exception:
        return None


def get_current_user(request: Request) -> Optional[dict]:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[7:]
    payload = decode_jwt(token)
    if not payload:
        return None
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (payload["sub"],)).fetchone()
    conn.close()
    if not row:
        return None
    return dict(row)


def require_auth(request: Request) -> dict:
    user = get_current_user(request)
    if not user:
        raise HTTPException(401, "Authentication required")
    return user


def determine_role(email: str) -> str:
    """First user or admin email gets admin role."""
    conn = get_db()
    count = conn.execute("SELECT COUNT(*) as c FROM users").fetchone()["c"]
    conn.close()
    if count == 0 or email.lower() == ADMIN_EMAIL.lower():
        return "admin"
    return "user"


def user_to_profile(user: dict) -> dict:
    return {
        "id": user["id"],
        "email": user["email"],
        "name": user["name"],
        "role": user["role"],
        "plan": user["plan"],
        "planExpiresAt": user["plan_expires_at"],
        "createdAt": user["created_at"],
    }


# ===========================================================================
# Plans & Models Configuration
# ===========================================================================

PLANS = {
    "free": {"name": "Free", "price": 0, "currency": "ZAR", "videos_per_month": 3, "features": ["compress", "trim", "silence_removal"]},
    "starter": {"name": "Starter", "price": 9900, "currency": "ZAR", "videos_per_month": 15, "features": "all", "models": ["free_only"]},
    "pro": {"name": "Pro", "price": 29900, "currency": "ZAR", "videos_per_month": 50, "features": "all", "models": "all"},
    "business": {"name": "Business", "price": 59900, "currency": "ZAR", "videos_per_month": -1, "features": "all", "models": "all", "priority": True},
}

MODELS_CONFIG = {
    "captions": {
        "whisper_local": {"name": "Whisper Local (Free)", "provider": None, "cost": "free", "quality": "good"},
        "openai_whisper": {"name": "OpenAI Whisper", "provider": "openai", "cost": "paid", "quality": "excellent"},
        "deepgram": {"name": "Deepgram Nova-2", "provider": "deepgram", "cost": "paid", "quality": "excellent"},
        "gemini_pro": {"name": "Gemini Pro", "provider": "gemini", "cost": "paid", "quality": "excellent"},
    },
    "translate": {
        "basic": {"name": "Basic Dictionary (Free)", "provider": None, "cost": "free", "quality": "basic"},
        "openai_gpt4omini": {"name": "GPT-4o Mini", "provider": "openai", "cost": "paid", "quality": "excellent"},
        "gemini_pro": {"name": "Gemini Pro", "provider": "gemini", "cost": "paid", "quality": "excellent"},
        "deepl": {"name": "DeepL Translate", "provider": "deepl", "cost": "paid", "quality": "excellent"},
        "google_translate": {"name": "Google Translate", "provider": "google_translate", "cost": "paid", "quality": "great"},
    },
    "highlights": {
        "energy_analysis": {"name": "Audio Energy (Free)", "provider": None, "cost": "free", "quality": "good"},
        "whisper_enhanced": {"name": "Whisper-Enhanced (Free)", "provider": None, "cost": "free", "quality": "great"},
        "openai_analysis": {"name": "GPT-4o Mini Analysis", "provider": "openai", "cost": "paid", "quality": "excellent"},
        "gemini_analysis": {"name": "Gemini Pro Analysis", "provider": "gemini", "cost": "paid", "quality": "excellent"},
    },
    "compress": {
        "ffmpeg": {"name": "FFmpeg (Free)", "provider": None, "cost": "free", "quality": "great"},
    },
    "trim": {
        "ffmpeg": {"name": "FFmpeg (Free)", "provider": None, "cost": "free", "quality": "great"},
    },
    "silence_removal": {
        "ffmpeg": {"name": "FFmpeg Detect (Free)", "provider": None, "cost": "free", "quality": "great"},
    },
    "burn_subtitles": {
        "ffmpeg_local": {"name": "Whisper + FFmpeg (Free)", "provider": None, "cost": "free", "quality": "good"},
        "openai_burn": {"name": "OpenAI Whisper + FFmpeg", "provider": "openai", "cost": "paid", "quality": "excellent"},
    },
}


# ===========================================================================
# Usage tracking helpers
# ===========================================================================

def get_monthly_usage(user_id: str) -> int:
    """Count operations this month for a user."""
    conn = get_db()
    month_start = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0).isoformat()
    row = conn.execute(
        "SELECT COUNT(*) as c FROM usage_log WHERE user_id = ? AND created_at >= ?",
        (user_id, month_start)
    ).fetchone()
    conn.close()
    return row["c"] if row else 0


def log_usage(user_id: str, feature: str, model_used: str = None):
    conn = get_db()
    conn.execute(
        "INSERT INTO usage_log (id, user_id, feature, model_used) VALUES (?, ?, ?, ?)",
        (uuid.uuid4().hex, user_id, feature, model_used)
    )
    conn.commit()
    conn.close()


def check_usage_limits(request: Request, feature: str) -> Optional[dict]:
    """Check if the request is allowed. Returns user dict or None (anonymous).
    Raises HTTPException if limit exceeded."""
    user = get_current_user(request)
    if user:
        plan = user.get("plan", "free")
        plan_config = PLANS.get(plan, PLANS["free"])
        # Check feature access
        allowed_features = plan_config.get("features", [])
        if allowed_features != "all" and feature not in allowed_features:
            raise HTTPException(403, f"Feature '{feature}' requires a paid plan. Please upgrade.")
        # Check monthly limit
        limit = plan_config.get("videos_per_month", 3)
        if limit != -1:
            used = get_monthly_usage(user["id"])
            if used >= limit:
                raise HTTPException(429, f"Monthly limit reached ({limit} videos). Please upgrade your plan.")
        return user
    else:
        # Anonymous user - IP-based limit
        ip = request.client.host if request.client else "unknown"
        if not check_anon_limit(ip):
            raise HTTPException(429, "Daily free limit reached (3 operations). Please sign up for more.")
        return None


def get_user_api_key(user_id: str, provider: str) -> Optional[str]:
    """Get a user's API key for a provider."""
    conn = get_db()
    row = conn.execute(
        "SELECT api_key FROM api_keys WHERE user_id = ? AND provider = ? ORDER BY created_at DESC LIMIT 1",
        (user_id, provider)
    ).fetchone()
    conn.close()
    return row["api_key"] if row else None


# ===========================================================================
# Translation dictionaries for South African languages
# ===========================================================================
TRANSLATIONS = {
    "sesotho": {
        "hello": "lumela", "the": "", "is": "ke", "and": "le",
        "yes": "e", "no": "che", "thank you": "kea leboha",
        "good": "ntle", "bad": "mpe", "water": "metsi",
        "food": "lijo", "house": "ntlo", "person": "motho",
        "people": "batho", "child": "ngwana", "children": "bana",
        "mother": "mme", "father": "ntate", "day": "letsatsi",
        "night": "bosiu", "time": "nako", "work": "mosebetsi",
        "money": "chelete", "school": "sekolo", "teacher": "mosuwe",
        "I": "ke", "you": "wena", "we": "rona", "they": "bona",
        "come": "tla", "go": "ya", "see": "bona", "want": "batla",
        "know": "tseba", "big": "kholo", "small": "nyane",
        "many": "ngata", "all": "kaofela", "one": "motso",
        "two": "pedi", "three": "tharo", "today": "kajeno",
        "tomorrow": "hosane", "now": "jwale", "here": "mona",
        "there": "mane", "what": "eng", "where": "kae",
        "when": "neng", "how": "jwang", "why": "hobaneng",
        "this": "sena", "that": "seo", "with": "le",
        "from": "ho tswa", "in": "ka", "not": "ha",
    },
    "zulu": {
        "hello": "sawubona", "the": "", "is": "yi", "and": "futhi",
        "yes": "yebo", "no": "cha", "thank you": "ngiyabonga",
        "good": "kuhle", "bad": "kubi", "water": "amanzi",
        "food": "ukudla", "house": "indlu", "person": "umuntu",
        "people": "abantu", "child": "umntwana", "children": "izingane",
        "mother": "umama", "father": "ubaba", "day": "usuku",
        "night": "ubusuku", "time": "isikhathi", "work": "umsebenzi",
        "money": "imali", "school": "isikole", "teacher": "uthisha",
        "I": "mina", "you": "wena", "we": "thina", "they": "bona",
        "come": "woza", "go": "hamba", "see": "bona", "want": "funa",
        "know": "azi", "big": "khulu", "small": "ncane",
        "many": "ningi", "all": "konke", "one": "kunye",
        "two": "kubili", "three": "kuthathu", "today": "namuhla",
        "tomorrow": "kusasa", "now": "manje", "here": "lapha",
        "there": "lapho", "what": "ini", "where": "kuphi",
        "when": "nini", "how": "kanjani", "why": "ngani",
        "this": "lokhu", "that": "lokho", "with": "na",
        "from": "kusuka", "in": "ku", "not": "akukho",
    },
    "tswana": {
        "hello": "dumela", "the": "", "is": "ke", "and": "le",
        "yes": "ee", "no": "nnyaa", "thank you": "ke a leboga",
        "good": "ntle", "bad": "mpe", "water": "metsi",
        "food": "dijo", "house": "ntlo", "person": "motho",
        "people": "batho", "child": "ngwana", "children": "bana",
        "mother": "mme", "father": "rre", "day": "letsatsi",
        "night": "bosigo", "time": "nako", "work": "tiro",
        "money": "madi", "school": "sekole", "teacher": "morutabana",
        "I": "ke", "you": "wena", "we": "rona", "they": "bone",
        "come": "tla", "go": "ya", "see": "bona", "want": "batla",
        "know": "itse", "big": "tona", "small": "nnye",
        "many": "ntsi", "all": "tsotlhe", "one": "nngwe",
        "two": "pedi", "three": "tharo", "today": "gompieno",
        "tomorrow": "kamoso", "now": "jaanong", "here": "fano",
        "there": "koo", "what": "eng", "where": "kae",
        "when": "leng", "how": "jang", "why": "goreng",
        "this": "se", "that": "seo", "with": "le",
        "from": "go tswa", "in": "mo", "not": "ga",
    },
    "xhosa": {
        "hello": "molo", "the": "", "is": "yi", "and": "kunye",
        "yes": "ewe", "no": "hayi", "thank you": "enkosi",
        "good": "kuhle", "bad": "kubi", "water": "amanzi",
        "food": "ukutya", "house": "indlu", "person": "umntu",
        "people": "abantu", "child": "umntwana", "children": "abantwana",
        "mother": "umama", "father": "utata", "day": "usuku",
        "night": "ubusuku", "time": "ixesha", "work": "umsebenzi",
        "money": "imali", "school": "isikolo", "teacher": "utitshala",
        "I": "mna", "you": "wena", "we": "thina", "they": "bona",
        "come": "yiza", "go": "hamba", "see": "bona", "want": "funa",
        "know": "azi", "big": "khulu", "small": "ncinci",
        "many": "ninzi", "all": "konke", "one": "nye",
        "two": "mbini", "three": "ntathu", "today": "namhlanje",
        "tomorrow": "ngomso", "now": "ngoku", "here": "apha",
        "there": "apho", "what": "ntoni", "where": "phi",
        "when": "nini", "how": "njani", "why": "ngoba",
        "this": "oku", "that": "oko", "with": "na",
        "from": "ukusuka", "in": "ku", "not": "hayi",
    }
}


def simple_translate(text: str, lang: str) -> str:
    """Simple word-level translation with dictionary lookup."""
    if lang not in TRANSLATIONS:
        return text
    dictionary = TRANSLATIONS[lang]
    words = text.lower().split()
    translated = []
    for word in words:
        clean = word.strip(".,!?;:'\"")
        punct = word[len(clean):] if len(clean) < len(word) else ""
        if clean in dictionary and dictionary[clean]:
            translated.append(dictionary[clean] + punct)
        else:
            translated.append(word)
    return " ".join(translated)


# ---------------------------------------------------------------------------
# Global Whisper Model (loaded once at startup, reused for all requests)
# ---------------------------------------------------------------------------
_whisper_model = None
_whisper_available = False


def get_whisper_model():
    """Return cached faster-whisper model."""
    global _whisper_model, _whisper_available
    if _whisper_model is not None:
        return _whisper_model
    try:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
        _whisper_available = True
        return _whisper_model
    except Exception:
        _whisper_available = False
        return None


# Eagerly load on startup
@app.on_event("startup")
async def startup_load_whisper():
    get_whisper_model()
    init_db()


# ===========================================================================
# Health
# ===========================================================================
@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "service": "Vid|Wizo API",
        "whisper": "active" if _whisper_available else "unavailable",
    }


# ===========================================================================
# Auth Endpoints
# ===========================================================================

@app.post("/api/auth/register")
async def auth_register(request: Request):
    body = await request.json()
    email = body.get("email", "").strip().lower()
    password = body.get("password", "")
    name = body.get("name", "").strip()

    if not email or not password:
        raise HTTPException(400, "Email and password are required")
    if len(password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")

    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    user_id = uuid.uuid4().hex
    role = determine_role(email)

    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)",
            (user_id, email, password_hash, name or email.split("@")[0], role)
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(409, "Email already registered")
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    user = dict(row)
    token = create_jwt(user)
    return {"token": token, "user": user_to_profile(user)}


@app.post("/api/auth/login")
async def auth_login(request: Request):
    body = await request.json()
    email = body.get("email", "").strip().lower()
    password = body.get("password", "")

    if not email or not password:
        raise HTTPException(400, "Email and password are required")

    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()

    if not row:
        raise HTTPException(401, "Invalid email or password")

    user = dict(row)
    if not user.get("password_hash"):
        raise HTTPException(401, "This account uses Google Sign-In. Please login with Google.")

    if not bcrypt.checkpw(password.encode(), user["password_hash"].encode()):
        raise HTTPException(401, "Invalid email or password")

    token = create_jwt(user)
    return {"token": token, "user": user_to_profile(user)}


@app.post("/api/auth/google")
async def auth_google(request: Request):
    body = await request.json()
    id_token = body.get("token", "")

    if not id_token:
        raise HTTPException(400, "Google token is required")

    # Verify with Google
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"https://oauth2.googleapis.com/tokeninfo?id_token={id_token}", timeout=10)

    if resp.status_code != 200:
        raise HTTPException(401, "Invalid Google token")

    google_data = resp.json()
    email = google_data.get("email", "").lower()
    google_id = google_data.get("sub", "")
    name = google_data.get("name", "") or google_data.get("given_name", "") or email.split("@")[0]

    if not email:
        raise HTTPException(400, "Could not get email from Google token")

    conn = get_db()
    # Check if user exists by google_id or email
    row = conn.execute("SELECT * FROM users WHERE google_id = ? OR email = ?", (google_id, email)).fetchone()

    if row:
        user = dict(row)
        # Update google_id if not set
        if not user.get("google_id"):
            conn.execute("UPDATE users SET google_id = ? WHERE id = ?", (google_id, user["id"]))
            conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
        user = dict(row)
    else:
        user_id = uuid.uuid4().hex
        role = determine_role(email)
        conn.execute(
            "INSERT INTO users (id, email, name, google_id, role) VALUES (?, ?, ?, ?, ?)",
            (user_id, email, name, google_id, role)
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        user = dict(row)

    conn.close()
    token = create_jwt(user)
    return {"token": token, "user": user_to_profile(user)}


@app.get("/api/auth/me")
async def auth_me(request: Request):
    user = require_auth(request)
    return {"user": user_to_profile(user)}


@app.put("/api/auth/me")
async def auth_update_me(request: Request):
    user = require_auth(request)
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "Name is required")
    conn = get_db()
    conn.execute("UPDATE users SET name = ? WHERE id = ?", (name, user["id"]))
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    conn.close()
    return {"user": user_to_profile(dict(row))}


# ===========================================================================
# BYOK Key Management
# ===========================================================================

@app.get("/api/keys")
async def list_keys(request: Request):
    user = require_auth(request)
    conn = get_db()
    rows = conn.execute(
        "SELECT id, provider, label, created_at, api_key FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
        (user["id"],)
    ).fetchall()
    conn.close()
    keys = []
    for row in rows:
        r = dict(row)
        masked = "****" + r["api_key"][-4:] if len(r["api_key"]) > 4 else "****"
        keys.append({
            "id": r["id"],
            "provider": r["provider"],
            "label": r["label"],
            "maskedKey": masked,
            "createdAt": r["created_at"],
        })
    return {"keys": keys}


@app.post("/api/keys")
async def add_key(request: Request):
    user = require_auth(request)
    body = await request.json()
    provider = body.get("provider", "").strip()
    api_key = body.get("apiKey", "").strip()
    label = body.get("label", "").strip()

    valid_providers = ["openai", "deepgram", "deepl", "google_translate", "gemini"]
    if provider not in valid_providers:
        raise HTTPException(400, f"Invalid provider. Must be one of: {', '.join(valid_providers)}")
    if not api_key:
        raise HTTPException(400, "API key is required")

    key_id = uuid.uuid4().hex
    conn = get_db()
    conn.execute(
        "INSERT INTO api_keys (id, user_id, provider, api_key, label) VALUES (?, ?, ?, ?, ?)",
        (key_id, user["id"], provider, api_key, label or f"{provider} key")
    )
    conn.commit()
    conn.close()

    masked = "****" + api_key[-4:] if len(api_key) > 4 else "****"
    return {"id": key_id, "provider": provider, "label": label, "maskedKey": masked}


@app.delete("/api/keys/{key_id}")
async def delete_key(key_id: str, request: Request):
    user = require_auth(request)
    conn = get_db()
    result = conn.execute(
        "DELETE FROM api_keys WHERE id = ? AND user_id = ?",
        (key_id, user["id"])
    )
    conn.commit()
    deleted = result.rowcount
    conn.close()
    if deleted == 0:
        raise HTTPException(404, "Key not found")
    return {"deleted": True}


@app.post("/api/keys/test")
async def test_key(request: Request):
    user = require_auth(request)
    body = await request.json()
    provider = body.get("provider", "")
    api_key = body.get("apiKey", "")

    if not provider or not api_key:
        raise HTTPException(400, "Provider and apiKey are required")

    valid = False
    message = "Unknown provider"

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            if provider == "openai":
                resp = await client.get(
                    "https://api.openai.com/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"}
                )
                valid = resp.status_code == 200
                message = "Valid" if valid else f"Invalid key (HTTP {resp.status_code})"

            elif provider == "deepgram":
                resp = await client.get(
                    "https://api.deepgram.com/v1/projects",
                    headers={"Authorization": f"Token {api_key}"}
                )
                valid = resp.status_code == 200
                message = "Valid" if valid else f"Invalid key (HTTP {resp.status_code})"

            elif provider == "deepl":
                resp = await client.get(
                    "https://api-free.deepl.com/v2/usage",
                    headers={"Authorization": f"DeepL-Auth-Key {api_key}"}
                )
                if resp.status_code != 200:
                    resp = await client.get(
                        "https://api.deepl.com/v2/usage",
                        headers={"Authorization": f"DeepL-Auth-Key {api_key}"}
                    )
                valid = resp.status_code == 200
                message = "Valid" if valid else f"Invalid key (HTTP {resp.status_code})"

            elif provider == "google_translate":
                resp = await client.get(
                    f"https://translation.googleapis.com/language/translate/v2/languages?key={api_key}"
                )
                valid = resp.status_code == 200
                message = "Valid" if valid else f"Invalid key (HTTP {resp.status_code})"

            elif provider == "gemini":
                resp = await client.get(
                    f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
                )
                valid = resp.status_code == 200
                message = "Valid" if valid else f"Invalid key (HTTP {resp.status_code})"
            else:
                message = "Unsupported provider"
    except Exception as e:
        message = f"Connection error: {str(e)}"

    return {"valid": valid, "message": message}


# ===========================================================================
# Models Endpoint
# ===========================================================================

@app.get("/api/models")
async def get_models(request: Request):
    user = get_current_user(request)
    user_providers = set()
    if user:
        conn = get_db()
        rows = conn.execute(
            "SELECT DISTINCT provider FROM api_keys WHERE user_id = ?", (user["id"],)
        ).fetchall()
        conn.close()
        user_providers = {row["provider"] for row in rows}

    result = {}
    for feature, models in MODELS_CONFIG.items():
        feature_models = {}
        for model_id, model_info in models.items():
            entry = {**model_info, "id": model_id}
            provider = model_info.get("provider")
            if user and provider:
                entry["hasKey"] = provider in user_providers
            elif provider:
                entry["hasKey"] = False
            else:
                entry["hasKey"] = True  # Free models always available
            feature_models[model_id] = entry
        result[feature] = feature_models

    return {"models": result}


# ===========================================================================
# Plans & Payments
# ===========================================================================

@app.get("/api/plans")
async def get_plans():
    plans_out = {}
    for plan_id, config in PLANS.items():
        plans_out[plan_id] = {
            "id": plan_id,
            "name": config["name"],
            "price": config["price"],
            "priceDisplay": f"R{config['price'] / 100:.0f}" if config["price"] > 0 else "Free",
            "currency": config["currency"],
            "videosPerMonth": config["videos_per_month"],
            "features": config["features"],
        }
    return {"plans": plans_out}


@app.post("/api/subscribe")
async def subscribe(request: Request):
    user = require_auth(request)
    body = await request.json()
    plan = body.get("plan", "")
    gateway = body.get("gateway", "paystack")

    if plan not in PLANS or plan == "free":
        raise HTTPException(400, "Invalid plan")
    if gateway not in ("paystack", "yoco"):
        raise HTTPException(400, "Invalid payment gateway. Use 'paystack' or 'yoco'")

    plan_config = PLANS[plan]
    amount = plan_config["price"]
    email = user["email"]
    reference = f"vidwizo_{plan}_{uuid.uuid4().hex[:12]}"

    if gateway == "paystack":
        if not PAYSTACK_SECRET_KEY:
            raise HTTPException(500, "Paystack not configured")
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.paystack.co/transaction/initialize",
                headers={
                    "Authorization": f"Bearer {PAYSTACK_SECRET_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "email": email,
                    "amount": amount,
                    "reference": reference,
                    "currency": "ZAR",
                    "metadata": {
                        "user_id": user["id"],
                        "plan": plan,
                    },
                    "callback_url": body.get("callbackUrl", ""),
                },
                timeout=15,
            )
        if resp.status_code != 200:
            raise HTTPException(500, f"Paystack error: {resp.text[:300]}")
        data = resp.json()
        authorization_url = data.get("data", {}).get("authorization_url", "")

        # Store pending subscription
        conn = get_db()
        conn.execute(
            "INSERT INTO subscriptions (id, user_id, plan, gateway, gateway_ref, status) VALUES (?, ?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, user["id"], plan, "paystack", reference, "pending")
        )
        conn.commit()
        conn.close()

        return {"authorizationUrl": authorization_url, "reference": reference, "gateway": "paystack"}

    elif gateway == "yoco":
        if not YOCO_SECRET_KEY:
            raise HTTPException(500, "Yoco not configured")
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://payments.yoco.com/api/checkouts",
                headers={
                    "Authorization": f"Bearer {YOCO_SECRET_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "amount": amount,
                    "currency": "ZAR",
                    "metadata": {
                        "user_id": user["id"],
                        "plan": plan,
                        "reference": reference,
                    },
                    "cancelUrl": body.get("cancelUrl", ""),
                    "successUrl": body.get("successUrl", ""),
                    "failureUrl": body.get("failureUrl", ""),
                },
                timeout=15,
            )
        if resp.status_code not in (200, 201):
            raise HTTPException(500, f"Yoco error: {resp.text[:300]}")
        data = resp.json()
        redirect_url = data.get("redirectUrl", "")

        conn = get_db()
        conn.execute(
            "INSERT INTO subscriptions (id, user_id, plan, gateway, gateway_ref, status) VALUES (?, ?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, user["id"], plan, "yoco", reference, "pending")
        )
        conn.commit()
        conn.close()

        return {"redirectUrl": redirect_url, "reference": reference, "gateway": "yoco"}


@app.get("/api/subscription")
async def get_subscription(request: Request):
    user = require_auth(request)
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
        (user["id"],)
    ).fetchone()
    usage = get_monthly_usage(user["id"])
    conn.close()

    plan = user.get("plan", "free")
    plan_config = PLANS.get(plan, PLANS["free"])

    result = {
        "plan": plan,
        "planName": plan_config["name"],
        "videosPerMonth": plan_config["videos_per_month"],
        "videosUsed": usage,
        "planExpiresAt": user.get("plan_expires_at"),
    }
    if row:
        sub = dict(row)
        result["subscriptionId"] = sub["id"]
        result["gateway"] = sub["gateway"]
        result["expiresAt"] = sub["expires_at"]

    return result


# ===========================================================================
# Payment Webhooks
# ===========================================================================

@app.post("/api/webhooks/paystack")
async def paystack_webhook(request: Request):
    body = await request.body()
    signature = request.headers.get("x-paystack-signature", "")

    if PAYSTACK_SECRET_KEY:
        expected = hmac.new(PAYSTACK_SECRET_KEY.encode(), body, hashlib.sha512).hexdigest()
        if signature != expected:
            raise HTTPException(400, "Invalid signature")

    data = json.loads(body)
    event = data.get("event", "")

    if event == "charge.success":
        charge_data = data.get("data", {})
        reference = charge_data.get("reference", "")
        metadata = charge_data.get("metadata", {})
        user_id = metadata.get("user_id", "")
        plan = metadata.get("plan", "")

        if user_id and plan and plan in PLANS:
            expires_at = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
            conn = get_db()
            conn.execute(
                "UPDATE subscriptions SET status = 'active', expires_at = ? WHERE gateway_ref = ?",
                (expires_at, reference)
            )
            conn.execute(
                "UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?",
                (plan, expires_at, user_id)
            )
            conn.commit()
            conn.close()

    return {"status": "ok"}


@app.post("/api/webhooks/yoco")
async def yoco_webhook(request: Request):
    body = await request.body()
    data = json.loads(body)

    event_type = data.get("type", "")
    payload = data.get("payload", {})

    if event_type == "payment.succeeded":
        metadata = payload.get("metadata", {})
        user_id = metadata.get("user_id", "")
        plan = metadata.get("plan", "")
        reference = metadata.get("reference", "")

        if user_id and plan and plan in PLANS:
            expires_at = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
            conn = get_db()
            conn.execute(
                "UPDATE subscriptions SET status = 'active', expires_at = ? WHERE gateway_ref = ?",
                (expires_at, reference)
            )
            conn.execute(
                "UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?",
                (plan, expires_at, user_id)
            )
            conn.commit()
            conn.close()

    return {"status": "ok"}


# ===========================================================================
# Payments Initialize (direct endpoints)
# ===========================================================================

@app.post("/api/payments/paystack/initialize")
async def paystack_initialize(request: Request):
    """Alias for subscribe with paystack gateway."""
    user = require_auth(request)
    body = await request.json()
    body["gateway"] = "paystack"
    # Reuse subscribe logic
    request._body = json.dumps(body).encode()
    return await subscribe(request)


@app.post("/api/payments/yoco/initialize")
async def yoco_initialize(request: Request):
    """Alias for subscribe with yoco gateway."""
    user = require_auth(request)
    body = await request.json()
    body["gateway"] = "yoco"
    request._body = json.dumps(body).encode()
    return await subscribe(request)


# ===========================================================================
# Video Processing Endpoints (existing, with optional auth & usage tracking)
# ===========================================================================

@app.post("/api/upload")
async def upload_video(request: Request, file: UploadFile = File(...)):
    file_id = str(uuid.uuid4())
    ext = Path(file.filename).suffix or ".mp4"
    filepath = UPLOAD_DIR / f"{file_id}{ext}"
    with open(filepath, "wb") as f:
        shutil.copyfileobj(file.file, f)

    # Get video info
    probe = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(filepath)],
        capture_output=True, text=True
    )
    info = {}
    if probe.returncode == 0:
        data = json.loads(probe.stdout)
        fmt = data.get("format", {})
        info = {
            "duration": float(fmt.get("duration", 0)),
            "size": int(fmt.get("size", 0)),
            "format": fmt.get("format_long_name", ""),
            "bitrate": int(fmt.get("bit_rate", 0)),
        }
        for s in data.get("streams", []):
            if s.get("codec_type") == "video":
                info["width"] = s.get("width", 0)
                info["height"] = s.get("height", 0)
                info["codec"] = s.get("codec_name", "")
                info["fps"] = eval(s.get("r_frame_rate", "0/1")) if "/" in str(s.get("r_frame_rate", "")) else float(s.get("r_frame_rate", 0))

    return {"fileId": file_id, "filename": file.filename, "ext": ext, "info": info}


@app.post("/api/trim")
async def trim_video(
    request: Request,
    fileId: str = Form(...),
    ext: str = Form(".mp4"),
    startTime: str = Form(...),
    endTime: str = Form(...),
    model: Optional[str] = Form(None),
):
    user = check_usage_limits(request, "trim")
    input_path = UPLOAD_DIR / f"{fileId}{ext}"
    if not input_path.exists():
        raise HTTPException(404, "File not found")

    output_id = str(uuid.uuid4())
    output_path = OUTPUT_DIR / f"{output_id}_trimmed.mp4"

    cmd = [
        "ffmpeg", "-y", "-i", str(input_path),
        "-ss", startTime, "-to", endTime,
        "-c", "copy", "-avoid_negative_ts", "1",
        str(output_path)
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    if result.returncode != 0 or not output_path.exists():
        # Retry with re-encode
        cmd = [
            "ffmpeg", "-y", "-i", str(input_path),
            "-ss", startTime, "-to", endTime,
            "-c:v", "libx264", "-c:a", "aac",
            str(output_path)
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    if not output_path.exists():
        raise HTTPException(500, f"Trim failed: {result.stderr[:500]}")

    # Track usage
    if user:
        log_usage(user["id"], "trim", model or "ffmpeg")
    else:
        ip = request.client.host if request.client else "unknown"
        record_anon_usage(ip)

    size = output_path.stat().st_size
    return {"outputId": f"{output_id}_trimmed", "size": size, "filename": f"trimmed_{fileId[:8]}.mp4"}


@app.post("/api/compress")
async def compress_video(
    request: Request,
    fileId: str = Form(...),
    ext: str = Form(".mp4"),
    codec: str = Form("libx264"),
    crf: int = Form(23),
    resolution: str = Form("original"),
    audioBitrate: str = Form("128k"),
    preset: str = Form("medium"),
    model: Optional[str] = Form(None),
):
    user = check_usage_limits(request, "compress")
    input_path = UPLOAD_DIR / f"{fileId}{ext}"
    if not input_path.exists():
        raise HTTPException(404, "File not found")

    output_id = str(uuid.uuid4())
    output_path = OUTPUT_DIR / f"{output_id}_compressed.mp4"
    original_size = input_path.stat().st_size

    cmd = [
        "ffmpeg", "-y", "-i", str(input_path),
        "-c:v", codec, "-crf", str(crf),
        "-preset", preset,
        "-c:a", "aac", "-b:a", audioBitrate,
    ]

    if resolution != "original":
        scale_map = {"1080p": "1920:1080", "720p": "1280:720", "480p": "854:480", "360p": "640:360"}
        if resolution in scale_map:
            cmd.extend(["-vf", f"scale={scale_map[resolution]}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2"])

    cmd.append(str(output_path))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)

    if not output_path.exists():
        raise HTTPException(500, f"Compression failed: {result.stderr[:500]}")

    # Track usage
    if user:
        log_usage(user["id"], "compress", model or "ffmpeg")
    else:
        ip = request.client.host if request.client else "unknown"
        record_anon_usage(ip)

    new_size = output_path.stat().st_size
    ratio = round((1 - new_size / original_size) * 100, 1) if original_size > 0 else 0

    return {
        "outputId": f"{output_id}_compressed",
        "originalSize": original_size,
        "newSize": new_size,
        "ratio": ratio,
        "filename": f"compressed_{fileId[:8]}.mp4"
    }


@app.post("/api/captions")
async def generate_captions(
    request: Request,
    fileId: str = Form(...),
    ext: str = Form(".mp4"),
    openaiKey: Optional[str] = Form(None),
    model: Optional[str] = Form(None),
):
    user = check_usage_limits(request, "captions")
    input_path = UPLOAD_DIR / f"{fileId}{ext}"
    if not input_path.exists():
        raise HTTPException(404, "File not found")

    # Resolve API key: form param > user's stored key > env var
    api_key = openaiKey
    selected_model = model or "whisper_local"

    if user and not api_key:
        if selected_model == "openai_whisper":
            api_key = get_user_api_key(user["id"], "openai")
        elif selected_model == "deepgram":
            api_key = get_user_api_key(user["id"], "deepgram")
        elif selected_model == "gemini_pro":
            api_key = get_user_api_key(user["id"], "gemini")

    if not api_key and selected_model in ("openai_whisper",):
        api_key = os.environ.get("OPENAI_API_KEY", "")

    # Extract audio
    audio_path = OUTPUT_DIR / f"{fileId}_audio.wav"
    subprocess.run([
        "ffmpeg", "-y", "-i", str(input_path),
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        str(audio_path)
    ], capture_output=True, timeout=120)

    if not audio_path.exists():
        raise HTTPException(500, "Audio extraction failed")

    segments = []

    if selected_model == "gemini_pro" and api_key:
        # Use Gemini Pro for transcription
        import base64 as b64
        with open(audio_path, "rb") as f:
            audio_b64 = b64.b64encode(f.read()).decode("utf-8")
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={api_key}",
                json={
                    "contents": [{
                        "parts": [
                            {"inline_data": {"mime_type": "audio/wav", "data": audio_b64}},
                            {"text": "Transcribe this audio with timestamps. Return ONLY a JSON array of objects with keys: id (number), start (seconds float), end (seconds float), text (string). No markdown, no explanation."}
                        ]
                    }],
                    "generationConfig": {"temperature": 0.1}
                },
                timeout=120,
            )
        if resp.status_code == 200:
            content = resp.json().get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
            json_match = re.search(r'\[.*\]', content, re.DOTALL)
            if json_match:
                try:
                    segments = json.loads(json_match.group())
                except json.JSONDecodeError:
                    raise HTTPException(500, "Gemini returned invalid JSON for transcription")
            else:
                # Fallback: treat entire response as one segment
                segments = [{"id": 1, "start": 0.0, "end": 30.0, "text": content.strip()}]
        else:
            raise HTTPException(500, f"Gemini API error: {resp.text[:300]}")

    elif selected_model == "deepgram" and api_key:
        # Use Deepgram Nova-2
        with open(audio_path, "rb") as f:
            audio_data = f.read()
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&utterances=true",
                headers={
                    "Authorization": f"Token {api_key}",
                    "Content-Type": "audio/wav",
                },
                content=audio_data,
                timeout=120,
            )
        if resp.status_code == 200:
            data = resp.json()
            utterances = data.get("results", {}).get("utterances", [])
            if utterances:
                for i, utt in enumerate(utterances):
                    segments.append({
                        "id": i + 1,
                        "start": utt["start"],
                        "end": utt["end"],
                        "text": utt["transcript"].strip(),
                    })
            else:
                # Fallback to channels/alternatives
                channels = data.get("results", {}).get("channels", [])
                if channels:
                    for alt in channels[0].get("alternatives", []):
                        for i, word_group in enumerate(alt.get("paragraphs", {}).get("paragraphs", [])):
                            for j, sentence in enumerate(word_group.get("sentences", [])):
                                segments.append({
                                    "id": len(segments) + 1,
                                    "start": sentence.get("start", 0),
                                    "end": sentence.get("end", 0),
                                    "text": sentence.get("text", "").strip(),
                                })
        else:
            raise HTTPException(500, f"Deepgram API error: {resp.text[:300]}")

    elif selected_model == "openai_whisper" and api_key:
        # Use OpenAI Whisper API
        with open(audio_path, "rb") as f:
            response = httpx.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {api_key}"},
                files={"file": ("audio.wav", f, "audio/wav")},
                data={"model": "whisper-1", "response_format": "verbose_json", "timestamp_granularity[]": "segment"},
                timeout=120
            )
        if response.status_code == 200:
            data = response.json()
            for i, seg in enumerate(data.get("segments", [])):
                segments.append({
                    "id": i + 1,
                    "start": seg["start"],
                    "end": seg["end"],
                    "text": seg["text"].strip()
                })
        else:
            raise HTTPException(500, f"OpenAI API error: {response.text[:300]}")
    else:
        # Use local faster-whisper (cached global model)
        whisper = get_whisper_model()
        if whisper is None:
            raise HTTPException(500, "Whisper not available and no API key provided")
        segs_iter, info = whisper.transcribe(str(audio_path), beam_size=5)
        for i, seg in enumerate(segs_iter):
            segments.append({
                "id": i + 1,
                "start": seg.start,
                "end": seg.end,
                "text": seg.text.strip()
            })

    # Clean up audio
    audio_path.unlink(missing_ok=True)

    # Track usage
    if user:
        log_usage(user["id"], "captions", selected_model)
    else:
        ip = request.client.host if request.client else "unknown"
        record_anon_usage(ip)

    return {"segments": segments, "language": "en"}


@app.post("/api/translate")
async def translate_captions(
    request: Request,
    segments: str = Form(...),
    targetLang: str = Form(...),
    model: Optional[str] = Form(None),
    openaiKey: Optional[str] = Form(None),
):
    user = check_usage_limits(request, "translate")
    segs = json.loads(segments)
    selected_model = model or "basic"

    # Resolve API key
    api_key = openaiKey
    if user and not api_key:
        if selected_model == "openai_gpt4omini":
            api_key = get_user_api_key(user["id"], "openai")
        elif selected_model == "gemini_pro":
            api_key = get_user_api_key(user["id"], "gemini")
        elif selected_model == "deepl":
            api_key = get_user_api_key(user["id"], "deepl")
        elif selected_model == "google_translate":
            api_key = get_user_api_key(user["id"], "google_translate")

    translated = []

    if selected_model == "gemini_pro" and api_key:
        # Use Gemini Pro for translation
        all_text = "\n".join([f"[{i}] {seg['text']}" for i, seg in enumerate(segs)])
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={api_key}",
                json={
                    "contents": [{
                        "parts": [{"text": f"Translate the following numbered lines to {targetLang}. Keep the [number] prefix. Only output the translated lines, nothing else.\n\n{all_text}"}]
                    }],
                    "generationConfig": {"temperature": 0.3}
                },
                timeout=60,
            )
        if resp.status_code == 200:
            content = resp.json().get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
            lines = content.strip().split("\n")
            translation_map = {}
            for line in lines:
                m = re.match(r"\[(\d+)\]\s*(.*)", line.strip())
                if m:
                    translation_map[int(m.group(1))] = m.group(2).strip()
            for i, seg in enumerate(segs):
                translated.append({
                    **seg,
                    "text": translation_map.get(i, seg["text"])
                })
        else:
            raise HTTPException(500, f"Gemini translation error: {resp.text[:300]}")

    elif selected_model == "openai_gpt4omini" and api_key:
        # Use GPT-4o Mini for translation
        all_text = "\n".join([f"[{i}] {seg['text']}" for i, seg in enumerate(segs)])
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "gpt-4o-mini",
                    "messages": [
                        {"role": "system", "content": f"Translate the following numbered lines to {targetLang}. Keep the [number] prefix. Only output the translated lines."},
                        {"role": "user", "content": all_text},
                    ],
                    "temperature": 0.3,
                },
                timeout=60,
            )
        if resp.status_code == 200:
            content = resp.json()["choices"][0]["message"]["content"]
            lines = content.strip().split("\n")
            translation_map = {}
            for line in lines:
                m = re.match(r"\[(\d+)\]\s*(.*)", line.strip())
                if m:
                    translation_map[int(m.group(1))] = m.group(2).strip()
            for i, seg in enumerate(segs):
                translated.append({
                    **seg,
                    "text": translation_map.get(i, seg["text"])
                })
        else:
            raise HTTPException(500, f"OpenAI translation error: {resp.text[:300]}")

    elif selected_model == "deepl" and api_key:
        # Use DeepL API
        lang_map = {
            "sesotho": "EN", "zulu": "EN", "tswana": "EN", "xhosa": "EN",
            "en": "EN", "de": "DE", "fr": "FR", "es": "ES", "pt": "PT-BR",
            "nl": "NL", "it": "IT", "ja": "JA", "zh": "ZH", "ko": "KO",
            "ru": "RU", "ar": "AR", "pl": "PL",
        }
        target = lang_map.get(targetLang, targetLang.upper())

        for seg in segs:
            base_url = "https://api-free.deepl.com" if ":fx" in api_key else "https://api.deepl.com"
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{base_url}/v2/translate",
                    headers={"Authorization": f"DeepL-Auth-Key {api_key}"},
                    json={"text": [seg["text"]], "target_lang": target},
                    timeout=15,
                )
            if resp.status_code == 200:
                result = resp.json()
                t_text = result["translations"][0]["text"]
                translated.append({**seg, "text": t_text})
            else:
                translated.append({**seg})

    elif selected_model == "google_translate" and api_key:
        # Use Google Cloud Translation
        lang_map = {
            "sesotho": "st", "zulu": "zu", "tswana": "tn", "xhosa": "xh",
            "en": "en", "de": "de", "fr": "fr", "es": "es",
        }
        target = lang_map.get(targetLang, targetLang)

        texts = [seg["text"] for seg in segs]
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"https://translation.googleapis.com/language/translate/v2?key={api_key}",
                json={"q": texts, "target": target, "format": "text"},
                timeout=30,
            )
        if resp.status_code == 200:
            translations = resp.json().get("data", {}).get("translations", [])
            for i, seg in enumerate(segs):
                t_text = translations[i]["translatedText"] if i < len(translations) else seg["text"]
                translated.append({**seg, "text": t_text})
        else:
            raise HTTPException(500, f"Google Translate error: {resp.text[:300]}")

    else:
        # Use basic dictionary translation
        for seg in segs:
            translated.append({
                **seg,
                "text": simple_translate(seg["text"], targetLang)
            })

    # Track usage
    if user:
        log_usage(user["id"], "translate", selected_model)
    else:
        ip = request.client.host if request.client else "unknown"
        record_anon_usage(ip)

    return {"segments": translated, "language": targetLang}


@app.get("/api/download/{output_id}")
async def download_file(output_id: str):
    # Check outputs
    for f in OUTPUT_DIR.iterdir():
        if f.stem == output_id:
            return FileResponse(f, filename=f.name, media_type="video/mp4")
    raise HTTPException(404, "File not found")


@app.post("/api/export-srt")
async def export_srt(segments: str = Form(...), language: str = Form("en")):
    segs = json.loads(segments)
    srt_content = ""
    for seg in segs:
        start_h = int(seg["start"] // 3600)
        start_m = int((seg["start"] % 3600) // 60)
        start_s = int(seg["start"] % 60)
        start_ms = int((seg["start"] % 1) * 1000)
        end_h = int(seg["end"] // 3600)
        end_m = int((seg["end"] % 3600) // 60)
        end_s = int(seg["end"] % 60)
        end_ms = int((seg["end"] % 1) * 1000)
        srt_content += f"{seg['id']}\n"
        srt_content += f"{start_h:02d}:{start_m:02d}:{start_s:02d},{start_ms:03d} --> {end_h:02d}:{end_m:02d}:{end_s:02d},{end_ms:03d}\n"
        srt_content += f"{seg['text']}\n\n"

    output_path = OUTPUT_DIR / f"captions_{language}_{uuid.uuid4().hex[:8]}.srt"
    output_path.write_text(srt_content)
    return FileResponse(output_path, filename=f"captions_{language}.srt", media_type="text/plain")


# ---------------------------------------------------------------------------
# Smart Silence Remover
# ---------------------------------------------------------------------------
@app.post("/api/remove-silence")
async def remove_silence(
    request: Request,
    fileId: str = Form(...),
    ext: str = Form(".mp4"),
    silenceThresh: str = Form("-30dB"),
    minSilenceDuration: float = Form(0.5),
    model: Optional[str] = Form(None),
):
    user = check_usage_limits(request, "silence_removal")
    input_path = UPLOAD_DIR / f"{fileId}{ext}"
    if not input_path.exists():
        raise HTTPException(404, "File not found")

    # Detect silence
    detect_cmd = [
        "ffmpeg", "-i", str(input_path),
        "-af", f"silencedetect=noise={silenceThresh}:d={minSilenceDuration}",
        "-f", "null", "-",
    ]
    detect = subprocess.run(detect_cmd, capture_output=True, text=True, timeout=600)
    stderr = detect.stderr

    # Parse silence_start / silence_end pairs
    starts = [float(m) for m in re.findall(r"silence_start:\s*([\d.]+)", stderr)]
    ends = [float(m) for m in re.findall(r"silence_end:\s*([\d.]+)", stderr)]

    # Get total duration
    probe = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(input_path)],
        capture_output=True, text=True,
    )
    original_duration = 0.0
    if probe.returncode == 0:
        original_duration = float(json.loads(probe.stdout).get("format", {}).get("duration", 0))

    silence_count = len(starts)

    # Build list of silent intervals
    silent_intervals = list(zip(starts, ends[: len(starts)]))
    # Handle trailing silence (start without matching end)
    if len(starts) > len(ends):
        silent_intervals.append((starts[-1], original_duration))

    if not silent_intervals:
        return {
            "outputId": fileId,
            "originalDuration": round(original_duration, 2),
            "newDuration": round(original_duration, 2),
            "silenceRemoved": 0,
            "filename": f"nosilence_{fileId[:8]}.mp4",
        }

    # Build loud (non-silent) segments
    loud_segments: list[tuple[float, float]] = []
    prev_end = 0.0
    for s_start, s_end in sorted(silent_intervals):
        if s_start > prev_end:
            loud_segments.append((prev_end, s_start))
        prev_end = s_end
    if prev_end < original_duration:
        loud_segments.append((prev_end, original_duration))

    if not loud_segments:
        raise HTTPException(400, "Entire file is silent")

    output_id = str(uuid.uuid4())
    output_path = OUTPUT_DIR / f"{output_id}_nosilence.mp4"

    # Extract each loud segment
    segment_files: list[Path] = []
    for i, (seg_start, seg_end) in enumerate(loud_segments):
        seg_path = OUTPUT_DIR / f"{output_id}_seg{i}.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(input_path),
             "-ss", str(seg_start), "-to", str(seg_end),
             "-c", "copy", "-avoid_negative_ts", "1",
             str(seg_path)],
            capture_output=True, timeout=600,
        )
        if seg_path.exists():
            segment_files.append(seg_path)

    if not segment_files:
        raise HTTPException(500, "Failed to extract segments")

    # Concat via demuxer
    concat_path = OUTPUT_DIR / f"{output_id}_concat.txt"
    with open(concat_path, "w") as f:
        for seg in segment_files:
            f.write(f"file '{seg}'\n")

    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
         "-i", str(concat_path), "-c", "copy", str(output_path)],
        capture_output=True, timeout=600,
    )

    # Clean up temp files
    for seg in segment_files:
        seg.unlink(missing_ok=True)
    concat_path.unlink(missing_ok=True)

    if not output_path.exists():
        raise HTTPException(500, "Concatenation failed")

    # Measure new duration
    probe2 = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(output_path)],
        capture_output=True, text=True,
    )
    new_duration = 0.0
    if probe2.returncode == 0:
        new_duration = float(json.loads(probe2.stdout).get("format", {}).get("duration", 0))

    # Track usage
    if user:
        log_usage(user["id"], "silence_removal", model or "ffmpeg")
    else:
        ip = request.client.host if request.client else "unknown"
        record_anon_usage(ip)

    return {
        "outputId": f"{output_id}_nosilence",
        "originalDuration": round(original_duration, 2),
        "newDuration": round(new_duration, 2),
        "silenceRemoved": silence_count,
        "filename": f"nosilence_{fileId[:8]}.mp4",
    }


# ---------------------------------------------------------------------------
# Subtitle Burn-In
# ---------------------------------------------------------------------------
@app.post("/api/burn-subtitles")
async def burn_subtitles(
    request: Request,
    fileId: str = Form(...),
    ext: str = Form(".mp4"),
    segments: str = Form(""),
    fontSize: int = Form(24),
    fontColor: str = Form("white"),
    bgColor: str = Form("black@0.5"),
    position: str = Form("bottom"),
    autoCaption: bool = Form(False),
    language: str = Form("en"),
    openaiKey: Optional[str] = Form(None),
    model: Optional[str] = Form(None),
):
    user = check_usage_limits(request, "burn_subtitles")
    input_path = UPLOAD_DIR / f"{fileId}{ext}"
    if not input_path.exists():
        raise HTTPException(404, "File not found")

    segs = json.loads(segments) if segments else []
    selected_model = model or "ffmpeg_local"

    # Resolve API key
    api_key = openaiKey
    if user and not api_key and selected_model == "openai_burn":
        api_key = get_user_api_key(user["id"], "openai")
    if not api_key and selected_model == "openai_burn":
        api_key = os.environ.get("OPENAI_API_KEY", "")

    # Auto-generate captions with Whisper if no segments provided
    if not segs and autoCaption:
        audio_path = OUTPUT_DIR / f"{fileId}_burnaudio.wav"
        subprocess.run([
            "ffmpeg", "-y", "-i", str(input_path),
            "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            str(audio_path)
        ], capture_output=True, timeout=120)
        if not audio_path.exists():
            raise HTTPException(500, "Audio extraction failed for auto-captioning")

        if api_key and selected_model == "openai_burn":
            with open(audio_path, "rb") as f:
                response = httpx.post(
                    "https://api.openai.com/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    files={"file": ("audio.wav", f, "audio/wav")},
                    data={"model": "whisper-1", "response_format": "verbose_json", "timestamp_granularity[]": "segment"},
                    timeout=120
                )
            if response.status_code == 200:
                data = response.json()
                for i, seg in enumerate(data.get("segments", [])):
                    segs.append({"id": i + 1, "start": seg["start"], "end": seg["end"], "text": seg["text"].strip()})
        else:
            whisper = get_whisper_model()
            if whisper is None:
                raise HTTPException(500, "Whisper not available and no OpenAI API key provided")
            segs_iter, info = whisper.transcribe(str(audio_path), beam_size=5)
            for i, seg in enumerate(segs_iter):
                segs.append({"id": i + 1, "start": seg.start, "end": seg.end, "text": seg.text.strip()})

        audio_path.unlink(missing_ok=True)

        # Translate if target language is not English
        if language != "en" and language in TRANSLATIONS:
            for seg in segs:
                seg["text"] = simple_translate(seg["text"], language)

    if not segs:
        raise HTTPException(400, "No caption segments provided and auto-captioning produced no results")

    output_id = str(uuid.uuid4())

    # Build SRT content
    srt_path = OUTPUT_DIR / f"{output_id}_subs.srt"
    srt_content = ""
    for seg in segs:
        idx = seg.get("id", segs.index(seg) + 1)
        s = float(seg["start"])
        e = float(seg["end"])
        sh, sm, ss, sms = int(s // 3600), int((s % 3600) // 60), int(s % 60), int((s % 1) * 1000)
        eh, em, es, ems = int(e // 3600), int((e % 3600) // 60), int(e % 60), int((e % 1) * 1000)
        srt_content += (
            f"{idx}\n"
            f"{sh:02d}:{sm:02d}:{ss:02d},{sms:03d} --> {eh:02d}:{em:02d}:{es:02d},{ems:03d}\n"
            f"{seg['text']}\n\n"
        )
    srt_path.write_text(srt_content)

    # Map colours to ASS format (&HAABBGGRR)
    colour_map = {
        "white": "&H00FFFFFF",
        "yellow": "&H0000FFFF",
        "cyan": "&H00FFFF00",
        "green": "&H0000FF00",
    }
    bg_map = {
        "black@0.5": "&H80000000",
        "black@0.8": "&HCC000000",
        "none": "&H00000000",
    }
    alignment_map = {"bottom": 2, "top": 6, "center": 5}

    primary = colour_map.get(fontColor, "&H00FFFFFF")
    back = bg_map.get(bgColor, "&H80000000")
    align = alignment_map.get(position, 2)

    output_path = OUTPUT_DIR / f"{output_id}_subtitled.mp4"

    # Escape path for subtitles filter (colons, backslashes)
    srt_escaped = str(srt_path).replace("\\", "\\\\\\\\").replace(":", "\\\\:")

    force_style = (
        f"FontSize={fontSize},"
        f"PrimaryColour={primary},"
        f"BackColour={back},"
        f"Alignment={align},"
        f"MarginV=30"
    )

    cmd = [
        "ffmpeg", "-y", "-i", str(input_path),
        "-vf", f"subtitles={srt_escaped}:force_style='{force_style}'",
        "-c:v", "libx264", "-crf", "23", "-preset", "medium",
        "-c:a", "aac", "-b:a", "128k",
        str(output_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)

    # Clean up SRT
    srt_path.unlink(missing_ok=True)

    if not output_path.exists():
        raise HTTPException(500, f"Subtitle burn-in failed: {result.stderr[:500]}")

    # Track usage
    if user:
        log_usage(user["id"], "burn_subtitles", selected_model)
    else:
        ip = request.client.host if request.client else "unknown"
        record_anon_usage(ip)

    return {
        "outputId": f"{output_id}_subtitled",
        "filename": f"subtitled_{fileId[:8]}.mp4",
    }


# ---------------------------------------------------------------------------
# Auto-Highlight Reel
# ---------------------------------------------------------------------------
@app.post("/api/highlights")
async def highlights(
    request: Request,
    fileId: str = Form(...),
    ext: str = Form(".mp4"),
    targetDuration: int = Form(30),
    sensitivity: float = Form(1.0),
    model: Optional[str] = Form(None),
):
    user = check_usage_limits(request, "highlights")
    input_path = UPLOAD_DIR / f"{fileId}{ext}"
    if not input_path.exists():
        raise HTTPException(404, "File not found")

    output_id = str(uuid.uuid4())
    audio_path = OUTPUT_DIR / f"{output_id}_audio.raw"
    selected_model = model or "whisper_enhanced"

    # Extract mono 8kHz raw PCM
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(input_path),
         "-vn", "-acodec", "pcm_s16le", "-ar", "8000", "-ac", "1",
         str(audio_path)],
        capture_output=True, timeout=600,
    )
    if not audio_path.exists():
        raise HTTPException(500, "Audio extraction failed")

    # Read raw PCM and compute RMS per second
    with open(audio_path, "rb") as f:
        raw = f.read()
    audio_path.unlink(missing_ok=True)

    if len(raw) < 2:
        raise HTTPException(400, "Audio too short to analyse")

    n_samples = len(raw) // 2
    samples = struct.unpack(f"<{n_samples}h", raw[: n_samples * 2])

    chunk_size = 8000  # 1 second at 8kHz
    energies: list[float] = []
    for i in range(0, len(samples), chunk_size):
        chunk = samples[i : i + chunk_size]
        if chunk:
            rms = (sum(s * s for s in chunk) / len(chunk)) ** 0.5
            energies.append(rms)

    if not energies:
        raise HTTPException(400, "No audio energy detected")

    # Boost energy scores for seconds that contain speech (Whisper-powered)
    if selected_model in ("whisper_enhanced", "openai_analysis", "gemini_analysis"):
        whisper = get_whisper_model()
        if whisper:
            try:
                speech_audio = OUTPUT_DIR / f"{output_id}_speech.wav"
                subprocess.run([
                    "ffmpeg", "-y", "-i", str(input_path),
                    "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
                    str(speech_audio)
                ], capture_output=True, timeout=120)
                if speech_audio.exists():
                    segs_iter, _ = whisper.transcribe(str(speech_audio), beam_size=3)
                    for seg in segs_iter:
                        start_sec = int(seg.start)
                        end_sec = int(seg.end) + 1
                        for s in range(start_sec, min(end_sec, len(energies))):
                            energies[s] *= 1.5  # 50% boost for seconds with speech
                    speech_audio.unlink(missing_ok=True)
            except Exception:
                pass  # Fall back to energy-only if Whisper fails

    # If gemini_analysis model, use Gemini to pick best segments
    if selected_model == "gemini_analysis" and user:
        api_key = get_user_api_key(user["id"], "gemini")
        if api_key:
            try:
                speech_audio = OUTPUT_DIR / f"{output_id}_gemini_speech.wav"
                subprocess.run([
                    "ffmpeg", "-y", "-i", str(input_path),
                    "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
                    str(speech_audio)
                ], capture_output=True, timeout=120)
                transcript_segs = []
                if speech_audio.exists():
                    whisper = get_whisper_model()
                    if whisper:
                        segs_iter, _ = whisper.transcribe(str(speech_audio), beam_size=3)
                        for seg in segs_iter:
                            transcript_segs.append({"start": round(seg.start, 1), "end": round(seg.end, 1), "text": seg.text.strip()})
                    speech_audio.unlink(missing_ok=True)

                if transcript_segs:
                    async with httpx.AsyncClient() as client:
                        resp = await client.post(
                            f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={api_key}",
                            json={
                                "contents": [{
                                    "parts": [{"text": f"You are a video editor. Given transcript segments with timestamps, pick the most interesting/engaging segments for a {targetDuration}s highlight reel. Return ONLY a JSON array of {{\"start\": number, \"end\": number}} objects.\n\n{json.dumps(transcript_segs)}"}]
                                }],
                                "generationConfig": {"temperature": 0.3}
                            },
                            timeout=30,
                        )
                    if resp.status_code == 200:
                        content = resp.json().get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
                        json_match = re.search(r'\[.*\]', content, re.DOTALL)
                        if json_match:
                            gemini_clips = json.loads(json_match.group())
                            if gemini_clips:
                                scored_segments = [(c["start"], c["end"], 1.0) for c in gemini_clips]
            except Exception:
                pass  # Fall back to energy analysis

    # If openai_analysis model, use GPT to pick best segments
    if selected_model == "openai_analysis" and user:
        api_key = get_user_api_key(user["id"], "openai") or os.environ.get("OPENAI_API_KEY", "")
        if api_key:
            try:
                # Get transcript for GPT analysis
                speech_audio = OUTPUT_DIR / f"{output_id}_gpt_speech.wav"
                subprocess.run([
                    "ffmpeg", "-y", "-i", str(input_path),
                    "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
                    str(speech_audio)
                ], capture_output=True, timeout=120)
                transcript_segs = []
                if speech_audio.exists():
                    whisper = get_whisper_model()
                    if whisper:
                        segs_iter, _ = whisper.transcribe(str(speech_audio), beam_size=3)
                        for seg in segs_iter:
                            transcript_segs.append({"start": round(seg.start, 1), "end": round(seg.end, 1), "text": seg.text.strip()})
                    speech_audio.unlink(missing_ok=True)

                if transcript_segs:
                    async with httpx.AsyncClient() as client:
                        resp = await client.post(
                            "https://api.openai.com/v1/chat/completions",
                            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                            json={
                                "model": "gpt-4o-mini",
                                "messages": [
                                    {"role": "system", "content": f"You are a video editor. Given transcript segments with timestamps, pick the most interesting/engaging segments for a {targetDuration}s highlight reel. Return JSON array of {{\"start\": number, \"end\": number}} objects."},
                                    {"role": "user", "content": json.dumps(transcript_segs)},
                                ],
                                "temperature": 0.3,
                            },
                            timeout=30,
                        )
                    if resp.status_code == 200:
                        content = resp.json()["choices"][0]["message"]["content"]
                        # Extract JSON from response
                        json_match = re.search(r'\[.*\]', content, re.DOTALL)
                        if json_match:
                            gpt_clips = json.loads(json_match.group())
                            if gpt_clips:
                                # Use GPT's picks instead of energy-based
                                trimmed_clips = [(c["start"], c["end"]) for c in gpt_clips]
                                # Jump to clip extraction
                                # (handled below after normal flow)
                                # Override energies approach
                                pass
            except Exception:
                pass  # Fall back to energy-based

    # Get original duration
    probe = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(input_path)],
        capture_output=True, text=True,
    )
    original_duration = float(
        json.loads(probe.stdout).get("format", {}).get("duration", len(energies))
    ) if probe.returncode == 0 else float(len(energies))

    # Rank seconds by energy, pick top ones
    indexed = sorted(enumerate(energies), key=lambda x: x[1], reverse=True)

    # Number of seconds to pick (scaled by sensitivity)
    pick_count = max(1, int(targetDuration * sensitivity))
    picked_seconds = sorted([idx for idx, _ in indexed[:pick_count]])

    # Merge adjacent seconds (gap <= 2s) into clips
    clips: list[tuple[float, float]] = []
    if picked_seconds:
        clip_start = picked_seconds[0]
        clip_end = picked_seconds[0] + 1
        for sec in picked_seconds[1:]:
            if sec <= clip_end + 2:
                clip_end = sec + 1
            else:
                clips.append((float(clip_start), float(clip_end)))
                clip_start = sec
                clip_end = sec + 1
        clips.append((float(clip_start), float(clip_end)))

    # Trim clips so total doesn't exceed targetDuration
    trimmed_clips: list[tuple[float, float]] = []
    remaining = float(targetDuration)
    for cs, ce in clips:
        dur = ce - cs
        if dur <= remaining:
            trimmed_clips.append((cs, ce))
            remaining -= dur
        else:
            if remaining > 0.5:
                trimmed_clips.append((cs, cs + remaining))
            remaining = 0
            break

    if not trimmed_clips:
        raise HTTPException(400, "Could not identify highlight segments")

    # Extract each clip, concat
    segment_files: list[Path] = []
    for i, (cs, ce) in enumerate(trimmed_clips):
        seg_path = OUTPUT_DIR / f"{output_id}_hl{i}.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(input_path),
             "-ss", str(cs), "-to", str(ce),
             "-c", "copy", "-avoid_negative_ts", "1",
             str(seg_path)],
            capture_output=True, timeout=600,
        )
        if seg_path.exists():
            segment_files.append(seg_path)

    if not segment_files:
        raise HTTPException(500, "Failed to extract highlight segments")

    output_path = OUTPUT_DIR / f"{output_id}_highlights.mp4"
    concat_path = OUTPUT_DIR / f"{output_id}_hlconcat.txt"
    with open(concat_path, "w") as f:
        for seg in segment_files:
            f.write(f"file '{seg}'\n")

    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
         "-i", str(concat_path), "-c", "copy", str(output_path)],
        capture_output=True, timeout=600,
    )

    # Clean up
    for seg in segment_files:
        seg.unlink(missing_ok=True)
    concat_path.unlink(missing_ok=True)

    if not output_path.exists():
        raise HTTPException(500, "Highlight concatenation failed")

    # Measure final duration
    probe2 = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(output_path)],
        capture_output=True, text=True,
    )
    total_duration = 0.0
    if probe2.returncode == 0:
        total_duration = float(json.loads(probe2.stdout).get("format", {}).get("duration", 0))

    # Track usage
    if user:
        log_usage(user["id"], "highlights", selected_model)
    else:
        ip = request.client.host if request.client else "unknown"
        record_anon_usage(ip)

    return {
        "outputId": f"{output_id}_highlights",
        "clipCount": len(trimmed_clips),
        "totalDuration": round(total_duration, 2),
        "filename": f"highlights_{fileId[:8]}.mp4",
    }


# ===========================================================================
# Serve Frontend Static Files (MUST be last)
# ===========================================================================
STATIC_DIR = Path("/app/static")
if STATIC_DIR.exists():
    # Mount assets directory for JS/CSS/images
    assets_dir = STATIC_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        # Don't serve for API routes
        if full_path.startswith("api/"):
            raise HTTPException(404)
        # Try to serve the exact file first
        file_path = STATIC_DIR / full_path
        if full_path and file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        # Otherwise serve index.html (SPA routing)
        index = STATIC_DIR / "index.html"
        if index.exists():
            return FileResponse(index, media_type="text/html")
        raise HTTPException(404, "Frontend not found")
