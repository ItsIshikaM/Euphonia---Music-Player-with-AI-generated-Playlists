import os
import re
import json
import random
import hashlib
import traceback
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional
from datetime import datetime

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from google import genai
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from sqlalchemy import create_engine, Column, Integer, String, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import declarative_base, sessionmaker, Session, relationship

load_dotenv()

# --- SQLite Database Setup ---
DB_PATH = os.path.abspath("euphonia.db")
DATABASE_URL = f"sqlite:///{DB_PATH}"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    username = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=True)
    name = Column(String, nullable=False)
    avatar = Column(String, default="https://api.dicebear.com/7.x/bottts/svg?seed=euphonia")
    is_verified = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    likes = relationship("LikedSong", back_populates="user", cascade="all, delete-orphan")

class LikedSong(Base):
    __tablename__ = "liked_songs"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    song_id = Column(String, index=True, nullable=False)
    title = Column(String, nullable=False)
    artist = Column(String, nullable=False)
    image = Column(String, nullable=False)
    preview_url = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    user = relationship("User", back_populates="likes")

Base.metadata.create_all(bind=engine)
print(f"[DATABASE] Connected to SQLite database at: {DB_PATH}")

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# --- Gemini Client Setup ---
gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
if not gemini_key:
    print("[WARNING] GEMINI_API_KEY is not configured in .env!")
gemini_client = genai.Client(api_key=gemini_key) if gemini_key else None

ACTIVE_GEMINI_MODELS = [
    "gemini-3.8-flash",
    "gemini-3.5-flash",
    "gemini-3-flash-preview"
]

# --- Live iTunes Metadata Resolver ---
def resolve_track_metadata(track_dict):
    title = track_dict.get("title", "Unknown")
    artist = track_dict.get("artist", "Unknown")
    safe_id = hashlib.md5(f"{title}-{artist}".encode()).hexdigest()[:10]

    try:
        q = urllib.parse.quote(f"{title} {artist}")
        req = urllib.request.Request(
            f"https://itunes.apple.com/search?term={q}&media=music&entity=song&limit=1",
            headers={"User-Agent": "Euphonia/8.0"}
        )
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            data = json.loads(resp.read().decode())
            if data.get("results"):
                t = data["results"][0]
                img = t.get("artworkUrl100", "").replace("100x100bb", "600x600bb")
                return {
                    "id": str(t.get("trackId", safe_id)),
                    "title": t.get("trackName", title),
                    "artist": t.get("artistName", artist),
                    "image": img,
                    "preview_url": t.get("previewUrl")
                }
    except Exception as e:
        print(f"[METADATA LOOKUP ERROR] {title}: {e}")

    avatar_seed = urllib.parse.quote(f"{title}-{artist}")
    return {
        "id": safe_id,
        "title": title,
        "artist": artist,
        "image": f"https://api.dicebear.com/7.x/identicon/svg?seed={avatar_seed}",
        "preview_url": None
    }

SEED_QUERIES = [
    {"title": "My Love Mine All Mine", "artist": "Mitski"},
    {"title": "Blinding Lights", "artist": "The Weeknd"},
    {"title": "Bad Guy", "artist": "Billie Eilish"},
    {"title": "As It Was", "artist": "Harry Styles"},
    {"title": "Starboy", "artist": "The Weeknd"},
    {"title": "Tum Hi Ho", "artist": "Arijit Singh"},
    {"title": "Seven", "artist": "Jung Kook"},
    {"title": "Despacito", "artist": "Luis Fonsi"}
]

with ThreadPoolExecutor(max_workers=5) as executor:
    INITIAL_CATALOG = list(executor.map(resolve_track_metadata, SEED_QUERIES))

app = FastAPI(title="Euphonia AI Platform")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Schemas ---
class SimpleRegisterReq(BaseModel):
    name: str
    username: str
    email: str
    password: str

class LoginReq(BaseModel):
    login_id: str
    password: str

class GoogleAuthReq(BaseModel):
    credential: str

class PlaylistReq(BaseModel):
    mood: str
    genre: str
    language: str

class LikeReq(BaseModel):
    user_id: int
    song_id: str
    title: str
    artist: str
    image: str
    preview_url: Optional[str] = None

class BatchLikeReq(BaseModel):
    user_id: int
    tracks: List[LikeReq]

class LyricsReq(BaseModel):
    title: str
    artist: str

# --- Endpoints ---

@app.get("/api/search")
def live_search(q: str = Query(..., min_length=1)):
    try:
        encoded_q = urllib.parse.quote(q)
        req = urllib.request.Request(
            f"https://itunes.apple.com/search?term={encoded_q}&media=music&entity=song&limit=15",
            headers={"User-Agent": "Euphonia/8.0"}
        )
        with urllib.request.urlopen(req, timeout=4.0) as resp:
            data = json.loads(resp.read().decode())
            results = []
            for t in data.get("results", []):
                img = t.get("artworkUrl100", "").replace("100x100bb", "600x600bb")
                results.append({
                    "id": str(t.get("trackId")),
                    "title": t.get("trackName", "Unknown"),
                    "artist": t.get("artistName", "Unknown"),
                    "image": img,
                    "preview_url": t.get("previewUrl")
                })
            return {"results": results}
    except Exception as e:
        print(f"[SEARCH ERROR] {e}")
        return {"results": []}

@app.get("/api/catalog")
def get_catalog():
    return {"catalog": INITIAL_CATALOG}

@app.post("/api/generate-playlist")
def generate_playlist(req: PlaylistReq):
    if not gemini_client:
        raise HTTPException(status_code=500, detail="Gemini API is not configured on the server. Please add GEMINI_API_KEY in .env.")

    prompt = f"""
    You are an expert music curator. Recommend 5 distinct, real, existing songs that match this user request:
    - Target Mood / Activity: "{req.mood}"
    - Genre preference: "{req.genre}"
    - Language preference: "{req.language}"

    Respond ONLY with a valid JSON object. Do not include markdown code blocks, backticks, or explanatory text.
    Use this exact JSON structure:
    {{
      "playlist_name": "A creative title representing this mood",
      "tracks": [
        {{"title": "Exact Song Title", "artist": "Exact Main Artist Name"}},
        {{"title": "Exact Song Title", "artist": "Exact Main Artist Name"}},
        {{"title": "Exact Song Title", "artist": "Exact Main Artist Name"}},
        {{"title": "Exact Song Title", "artist": "Exact Main Artist Name"}},
        {{"title": "Exact Song Title", "artist": "Exact Main Artist Name"}}
      ]
    }}
    """

    raw_text = None
    last_err = None

    for model_name in ACTIVE_GEMINI_MODELS:
        try:
            print(f"[AI] Generating playlist with {model_name}...")
            response = gemini_client.models.generate_content(
                model=model_name,
                contents=prompt
            )
            if response and response.text:
                raw_text = response.text.strip()
                break
        except Exception as e:
            print(f"[AI MODEL ERROR] {model_name}: {e}")
            last_err = e

    if not raw_text:
        raise HTTPException(status_code=503, detail=f"AI service temporarily unavailable: {last_err}")

    try:
        if "```" in raw_text:
            match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw_text, re.DOTALL)
            raw_text = match.group(1) if match else raw_text.replace("```json", "").replace("```", "").strip()

        data = json.loads(raw_text)
        tracks_raw = data.get("tracks", [])
        if not tracks_raw:
            raise ValueError("No tracks returned in JSON output")

        with ThreadPoolExecutor(max_workers=5) as executor:
            enriched_tracks = list(executor.map(resolve_track_metadata, tracks_raw))

        return {
            "playlist_name": data.get("playlist_name", f"{req.mood.title()} Mix"),
            "tracks": enriched_tracks
        }
    except Exception as err:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to parse AI output: {err}")

@app.post("/api/lyrics")
def get_lyrics(req: LyricsReq):
    try:
        clean_artist = urllib.parse.quote(req.artist)
        clean_title = urllib.parse.quote(req.title)
        url = f"[https://api.lyrics.ovh/v1/](https://api.lyrics.ovh/v1/){clean_artist}/{clean_title}"
        r = urllib.request.Request(url, headers={"User-Agent": "Euphonia/8.0"})
        with urllib.request.urlopen(r, timeout=1.8) as resp:
            data = json.loads(resp.read().decode())
            if "lyrics" in data and len(data["lyrics"].strip()) > 30:
                return {"lyrics": data["lyrics"].strip()}
    except Exception:
        pass

    if gemini_client:
        prompt = (
            f"Provide the complete, authentic lyrics for '{req.title}' by '{req.artist}'. "
            f"Include verse, pre-chorus, and chorus sections. "
            f"Do not write any introductory remarks or explanations; return only the lyrics."
        )
        for model_name in ACTIVE_GEMINI_MODELS:
            try:
                response = gemini_client.models.generate_content(
                    model=model_name,
                    contents=prompt
                )
                if response and response.text:
                    return {"lyrics": response.text.strip()}
            except Exception as e:
                print(f"[GEMINI LYRICS ERROR] {model_name}: {e}")

    return {"lyrics": f"Lyrics currently unavailable for '{req.title}' by {req.artist}."}

# --- Auth Routes ---
@app.post("/api/auth/register-simple")
def register_direct(req: SimpleRegisterReq, db: Session = Depends(get_db)):
    clean_email = req.email.strip().lower()
    clean_username = req.username.strip().lower()

    if db.query(User).filter(User.email == clean_email).first():
        raise HTTPException(status_code=400, detail="An account with this email already exists.")

    if db.query(User).filter(User.username == clean_username).first():
        raise HTTPException(status_code=400, detail="This username is already taken.")

    pw_hash = hashlib.sha256(req.password.encode()).hexdigest()
    avatar_seed = hashlib.md5(clean_email.encode()).hexdigest()[:6]

    user = User(
        name=req.name.strip(),
        username=clean_username,
        email=clean_email,
        password_hash=pw_hash,
        avatar=f"[https://api.dicebear.com/7.x/bottts/svg?seed=](https://api.dicebear.com/7.x/bottts/svg?seed=){avatar_seed}",
        is_verified=True
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    return {
        "user_id": user.id,
        "name": user.name,
        "username": user.username,
        "email": user.email,
        "avatar": user.avatar
    }

@app.post("/api/auth/login")
def login(req: LoginReq, db: Session = Depends(get_db)):
    login_id = req.login_id.strip().lower()
    pw_hash = hashlib.sha256(req.password.encode()).hexdigest()

    user = db.query(User).filter(
        (User.email == login_id) | (User.username == login_id)
    ).first()

    if not user or user.password_hash != pw_hash:
        raise HTTPException(status_code=401, detail="Invalid username/email or password.")

    return {
        "user_id": user.id,
        "name": user.name,
        "username": user.username,
        "email": user.email,
        "avatar": user.avatar
    }

@app.post("/api/auth/google-verify")
def verify_google(req: GoogleAuthReq, db: Session = Depends(get_db)):
    email = None
    name = "Google User"
    avatar = "[https://api.dicebear.com/7.x/bottts/svg?seed=google](https://api.dicebear.com/7.x/bottts/svg?seed=google)"

    try:
        id_info = id_token.verify_oauth2_token(
            req.credential,
            google_requests.Request(),
            audience=None
        )
        email = id_info.get("email", "").lower()
        name = id_info.get("name", name)
        avatar = id_info.get("picture", avatar)
    except Exception:
        try:
            import base64
            payload_b64 = req.credential.split(".")[1]
            padded = payload_b64 + "=" * (-len(payload_b64) % 4)
            info = json.loads(base64.urlsafe_b64decode(padded).decode())
            email = info.get("email", "").lower()
            name = info.get("name", name)
            avatar = info.get("picture", avatar)
        except Exception as parse_err:
            raise HTTPException(status_code=400, detail=f"Google token verification failed: {parse_err}")

    if not email:
        raise HTTPException(status_code=400, detail="Google authentication failed to supply an email.")

    user = db.query(User).filter(User.email == email).first()
    if not user:
        clean_user = email.split("@")[0] + str(random.randint(10, 99))
        user = User(
            name=name,
            username=clean_user,
            email=email,
            avatar=avatar,
            password_hash=None,
            is_verified=True
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    else:
        user.name = name
        user.avatar = avatar
        db.commit()
        db.refresh(user)

    return {
        "user_id": user.id,
        "name": user.name,
        "username": user.username,
        "email": user.email,
        "avatar": user.avatar
    }

# --- Library Endpoints ---
@app.get("/api/liked-songs/{user_id}")
def get_user_likes(user_id: int, db: Session = Depends(get_db)):
    songs = db.query(LikedSong).filter(LikedSong.user_id == user_id).order_by(LikedSong.id.desc()).all()
    return {
        "liked_songs": [
            {"id": s.song_id, "title": s.title, "artist": s.artist, "image": s.image, "preview_url": s.preview_url}
            for s in songs
        ]
    }

@app.post("/api/like")
def toggle_like(req: LikeReq, db: Session = Depends(get_db)):
    existing = db.query(LikedSong).filter(LikedSong.user_id == req.user_id, LikedSong.song_id == req.song_id).first()
    if existing:
        db.delete(existing)
        db.commit()
        status = "unliked"
    else:
        new_like = LikedSong(
            user_id=req.user_id, song_id=req.song_id, title=req.title,
            artist=req.artist, image=req.image, preview_url=req.preview_url
        )
        db.add(new_like)
        db.commit()
        status = "liked"
    all_ids = [s.song_id for s in db.query(LikedSong.song_id).filter(LikedSong.user_id == req.user_id).all()]
    return {"status": status, "liked_ids": all_ids}

@app.post("/api/like-batch")
def batch_like(req: BatchLikeReq, db: Session = Depends(get_db)):
    existing_ids = {s.song_id for s in db.query(LikedSong.song_id).filter(LikedSong.user_id == req.user_id).all()}
    for t in req.tracks:
        if t.song_id not in existing_ids:
            db.add(LikedSong(
                user_id=req.user_id, song_id=t.song_id, title=t.title,
                artist=t.artist, image=t.image, preview_url=t.preview_url
            ))
            existing_ids.add(t.song_id)
    db.commit()
    return {"status": "success", "liked_ids": list(existing_ids)}

@app.get("/")
def serve_index():
    return FileResponse("index.html")

app.mount("/", StaticFiles(directory="."), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=True)