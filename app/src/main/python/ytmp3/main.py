import threading
from pathlib import Path
import os
import re
import time
import json
from urllib.parse import quote
from flask import Flask, render_template, request, send_file, abort, Response, redirect
from flask_socketio import SocketIO
from flask import Flask, request, jsonify  # Add 'jsonify' here
# NOTE: yt_dlp is a very heavy import (hundreds of extractors). It is imported
# lazily inside search()/_download_url() so the backend starts — and the UI
# appears — much faster; yt_dlp only loads on the first search/download.

# ---------------- Storage ----------------
DOWNLOAD_DIR = Path.home() / "ytmp3_downloads"
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Playlists are stored as a single JSON file in app-private home (survives
# app updates, same as the songs). Shape:
#   {"playlists": [{"id": "...", "name": "...", "songs": ["file.mp4", ...]}]}
PLAYLISTS_FILE = Path.home() / "tubeify_playlists.json"
_playlists_lock = threading.Lock()


def _load_playlists():
    if not PLAYLISTS_FILE.exists():
        return []
    try:
        with open(PLAYLISTS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        playlists = data.get("playlists", []) if isinstance(data, dict) else []
        # Normalise structure defensively.
        clean = []
        for p in playlists:
            if not isinstance(p, dict):
                continue
            clean.append({
                "id": str(p.get("id") or ""),
                "name": str(p.get("name") or "Untitled"),
                "songs": [s for s in (p.get("songs") or []) if isinstance(s, str)],
            })
        return clean
    except Exception:
        return []


def _save_playlists(playlists):
    tmp = Path(str(PLAYLISTS_FILE) + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"playlists": playlists}, fh, indent=2)
    tmp.replace(PLAYLISTS_FILE)


# ---------------- Library scan cache ----------------
# Scanning the downloads dir (stat + sort of every file) happens on every
# library/playlist request. Cache the result and invalidate it only when the
# set of files actually changes (a download finishes or a song is removed).
MEDIA_EXT = (".mp4", ".m4a", ".mp3")
_songs_cache = None
_songs_cache_lock = threading.Lock()


def _scan_songs():
    """List songs newest-first as {title, path, thumbnail}. Thumbnails point at
    the local /thumb route (locally cached image, works offline)."""
    try:
        files = sorted(DOWNLOAD_DIR.iterdir(), key=os.path.getmtime, reverse=True)
    except Exception:
        try:
            files = list(DOWNLOAD_DIR.iterdir())
        except Exception:
            files = []

    songs = []
    for f in files:
        if f.suffix not in MEDIA_EXT:
            continue
        songs.append({
            "title": f.stem,
            "path": f.name,
            "thumbnail": "/thumb/" + quote(f.name, safe=""),
        })
    return songs


def _get_songs():
    global _songs_cache
    with _songs_cache_lock:
        if _songs_cache is None:
            _songs_cache = _scan_songs()
        return _songs_cache


def _invalidate_songs():
    global _songs_cache
    with _songs_cache_lock:
        _songs_cache = None


def _song_info_map():
    """Map filename -> {title, thumbnail} for every song currently on disk."""
    return {s["path"]: {"title": s["title"], "thumbnail": s["thumbnail"]}
            for s in _get_songs()}

# ---------------- Flask Backend ----------------
app = Flask(
    __name__,
    template_folder="frontend/templates",
    static_folder="frontend/static"
)
socketio = SocketIO(app, async_mode="eventlet", cors_allowed_origins="*")

# ---------------- Routes ----------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/search", methods=["POST"])
def search():
    query = request.form.get("query", "")
    if not query:
        return jsonify({"error": "No query"}), 400

    try:
        import yt_dlp  # lazy: keeps app startup fast
        ydl_opts = {
            "quiet": True,
            "skip_download": True,
            "extract_flat": True,  # Keep it fast
            "noplaylist": True,    # Do not pull in playlist objects
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # We fetch 20 to ensure we have enough "normal" videos after filtering
            search_query = f"ytsearch20:{query}"
            info = ydl.extract_info(search_query, download=False)
            entries = info.get("entries", [])

        results = []
        for v in entries:
            if not v: continue

            # 1. FILTER: Ignore Shorts, Playlists, and Channels
            # Flat extraction usually uses 'url' or 'id' for the link
            video_id = v.get("id")
            video_url = v.get("url") or v.get("webpage_url") or f"https://www.youtube.com/watch?v={video_id}"
            
            # Skip if it's a Short, a Playlist, or a Channel link
            if "/shorts/" in video_url or "/playlist?" in video_url or "/channel/" in video_url:
                continue

            # 2. FIX THUMBNAILS: Flat results nest thumbnails in a list
            thumb = v.get("thumbnail")
            if not thumb and v.get("thumbnails"):
                # Get the last thumb in the list (usually higher quality)
                thumb = v.get("thumbnails")[-1].get("url")

            # 3. FIX DURATION: Skip if duration is missing (often indicates non-video results)
            duration_sec = v.get("duration")
            if not duration_sec:
                continue
                
            mins, secs = divmod(int(duration_sec), 60)
            duration_str = f"{mins}:{secs:02d}"

            results.append({
                "title": v.get("title"),
                "url": video_url,
                "thumbnail": thumb,
                "duration": duration_str,
                "channel": v.get("uploader") or v.get("channel", "YouTube")
            })

            # Limit to 10 clean results
            if len(results) >= 10:
                break

        return jsonify(results)

    except Exception as e:
        print(f"Search Error: {e}")
        return jsonify({"error": "Search failed"}), 500

@app.route("/playlist")
def playlist():
    # Tags come fresh from the (small) playlists file; the song list is cached.
    with _playlists_lock:
        playlists = _load_playlists()
    tags_by_song = {}
    for p in playlists:
        tag = {"id": p["id"], "name": p["name"]}
        for song in p["songs"]:
            tags_by_song.setdefault(song, []).append(tag)

    video = []
    for s in _get_songs():
        video.append({
            "title": s["title"],
            "path": s["path"],
            "thumbnail": s["thumbnail"],
            "playlists": tags_by_song.get(s["path"], []),
        })

    return jsonify({"video": video})


# ---------------- Local thumbnail cache ----------------
@app.route("/thumb/<path:name>")
def thumb(name):
    """Serve a locally-cached thumbnail image (works offline). If it isn't
    cached yet, bounce to the remote URL from the .thumb sidecar — a background
    task fills in the local copies so later loads are instant and offline."""
    jpg = DOWNLOAD_DIR / (name + ".jpg")
    if jpg.exists():
        return send_file(jpg, mimetype="image/jpeg", conditional=True)

    tp = Path(str(DOWNLOAD_DIR / name) + ".thumb")
    if tp.exists():
        try:
            u = tp.read_text(errors="ignore").strip()
            if u:
                return redirect(u)
        except Exception:
            pass
    abort(404)


def _cache_thumb(media_filename, url):
    """Download a thumbnail image next to its song as '<file>.jpg'. Non-fatal."""
    if not url:
        return
    jpg = DOWNLOAD_DIR / (media_filename + ".jpg")
    if jpg.exists():
        return
    try:
        import urllib.request
        data = urllib.request.urlopen(url, timeout=10).read()
        if data:
            jpg.write_bytes(data)
    except Exception:
        pass


def _backfill_thumbs():
    """Fetch local thumbnail copies for songs that only have a remote URL, so
    the library renders instantly and works offline. Runs in a daemon thread."""
    try:
        files = list(DOWNLOAD_DIR.iterdir())
    except Exception:
        return
    for f in files:
        if f.suffix not in MEDIA_EXT:
            continue
        if Path(str(f) + ".jpg").exists():
            continue
        tp = Path(str(f) + ".thumb")
        if not tp.exists():
            continue
        try:
            url = tp.read_text(errors="ignore").strip()
        except Exception:
            continue
        _cache_thumb(f.name, url)


@app.route("/download/<filename>")
def download(filename):
    file_path = DOWNLOAD_DIR / filename
    if not file_path.exists():
        abort(404)

    # Serve the right MIME so audio-only downloads play correctly too.
    mime = {
        ".m4a": "audio/mp4",
        ".mp3": "audio/mpeg",
    }.get(file_path.suffix, "video/mp4")

    return send_file(
        file_path,
        mimetype=mime,
        conditional=True
    )


@app.route("/remove", methods=["POST"])
def remove():
    data = request.get_json()
    path = data.get("path")
    if not path:
        return {"success": False}

    file_path = DOWNLOAD_DIR / path
    # Sidecars: "<file>.thumb" (URL), "<file>.url" (source), "<file>.jpg" (image)
    for sidecar in (".thumb", ".url", ".jpg"):
        p = Path(str(file_path) + sidecar)
        if p.exists():
            p.unlink()

    if file_path.exists():
        file_path.unlink()

    _invalidate_songs()  # the file set changed

    # Also drop the song from any playlists that referenced it.
    with _playlists_lock:
        playlists = _load_playlists()
        changed = False
        for p in playlists:
            if path in p["songs"]:
                p["songs"] = [s for s in p["songs"] if s != path]
                changed = True
        if changed:
            _save_playlists(playlists)

    return {"success": True}


# ---------------- Playlists ----------------
@app.route("/playlists")
def get_playlists():
    """Return all playlists with their songs resolved to full song info."""
    with _playlists_lock:
        playlists = _load_playlists()

    info = _song_info_map()
    out = []
    for p in playlists:
        songs = []
        for path in p["songs"]:
            meta = info.get(path)
            if not meta:
                continue  # song was deleted from disk; skip
            songs.append({
                "path": path,
                "title": meta["title"],
                "thumbnail": meta["thumbnail"],
            })
        out.append({
            "id": p["id"],
            "name": p["name"],
            "count": len(songs),
            "songs": songs,
        })
    return jsonify({"playlists": out})


@app.route("/playlists/create", methods=["POST"])
def create_playlist():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"success": False, "error": "Name required"}), 400

    with _playlists_lock:
        playlists = _load_playlists()
        pid = "pl_" + str(int(time.time() * 1000))
        playlists.append({"id": pid, "name": name, "songs": []})
        _save_playlists(playlists)
    return jsonify({"success": True, "id": pid})


@app.route("/playlists/rename", methods=["POST"])
def rename_playlist():
    data = request.get_json(force=True, silent=True) or {}
    pid = data.get("id")
    name = (data.get("name") or "").strip()
    if not pid or not name:
        return jsonify({"success": False, "error": "id and name required"}), 400

    with _playlists_lock:
        playlists = _load_playlists()
        for p in playlists:
            if p["id"] == pid:
                p["name"] = name
        _save_playlists(playlists)
    return jsonify({"success": True})


@app.route("/playlists/delete", methods=["POST"])
def delete_playlist():
    data = request.get_json(force=True, silent=True) or {}
    pid = data.get("id")
    with _playlists_lock:
        playlists = [p for p in _load_playlists() if p["id"] != pid]
        _save_playlists(playlists)
    return jsonify({"success": True})


@app.route("/playlists/add", methods=["POST"])
def add_to_playlist():
    data = request.get_json(force=True, silent=True) or {}
    pid = data.get("id")
    path = data.get("path")
    if not pid or not path:
        return jsonify({"success": False, "error": "id and path required"}), 400

    with _playlists_lock:
        playlists = _load_playlists()
        for p in playlists:
            if p["id"] == pid and path not in p["songs"]:
                p["songs"].append(path)
        _save_playlists(playlists)
    return jsonify({"success": True})


@app.route("/playlists/remove", methods=["POST"])
def remove_from_playlist():
    data = request.get_json(force=True, silent=True) or {}
    pid = data.get("id")
    path = data.get("path")
    if not pid or not path:
        return jsonify({"success": False, "error": "id and path required"}), 400

    with _playlists_lock:
        playlists = _load_playlists()
        for p in playlists:
            if p["id"] == pid:
                p["songs"] = [s for s in p["songs"] if s != path]
        _save_playlists(playlists)
    return jsonify({"success": True})


# ---------------- Core Download Helper ----------------
def _download_url(url, progress_cb=None):
    """Download a single URL into DOWNLOAD_DIR.

    Saves a "<file>.thumb" sidecar (thumbnail URL) and a "<file>.url" sidecar
    (the source YouTube URL, used later for export/import).
    Returns the final filename. Raises on failure.
    """
    final = {"name": None}

    def progress_hook(d):
        if d["status"] == "downloading":
            downloaded = d.get("downloaded_bytes", 0)
            total = d.get("total_bytes", 0) or d.get("total_bytes_estimate", 0)
            percent = int(downloaded / total * 100) if total else 0
            if progress_cb:
                progress_cb(percent)

        elif d["status"] == "finished":
            filename = d.get("filename")
            info = d.get("info_dict", {})

            if not filename:
                raise Exception("Missing filename")

            final["name"] = Path(filename).name

            thumb = info.get("thumbnail", "")
            if thumb:
                try:
                    Path(filename + ".thumb").write_text(thumb)
                except Exception:
                    pass
                # Cache the image locally too (offline + fast library render).
                _cache_thumb(Path(filename).name, thumb)

            # Persist the source URL so the song can be exported/re-imported later.
            source_url = info.get("webpage_url") or url
            try:
                Path(filename + ".url").write_text(source_url)
            except Exception:
                pass

    import yt_dlp  # lazy: keeps app startup fast
    ydl_opts = {
        # Prefer a single progressive MP4 (audio+video) when YouTube still
        # offers one, otherwise fall back to an audio-only m4a stream, which is
        # essentially always available and needs no ffmpeg merge. This keeps
        # downloads working for newer videos that no longer expose itag 18.
        "format": (
            "best[ext=mp4][acodec!=none][vcodec!=none]/"
            "best[ext=mp4][acodec!=none]/"
            "bestaudio[ext=m4a]/bestaudio/best"
        ),
        "outtmpl": str(DOWNLOAD_DIR / "%(title).200s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "retries": 5,
        "progress_hooks": [progress_hook],
        "allow_unplayable_formats": False,
        "merge_output_format": None,
        # Force the Android player client. Without a JS runtime (which Android
        # has none of), the default clients return URLs that fail with HTTP 403
        # on download. The android client returns progressive URLs that work.
        "extractor_args": {"youtube": {"player_client": ["android"]}},
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.extract_info(url, download=True)

    if not final["name"]:
        raise Exception("Download failed")

    final_path = DOWNLOAD_DIR / final["name"]
    # Audio-only fallbacks are much smaller than a video, so use a low floor
    # just to catch truly empty/failed downloads.
    if not final_path.exists() or final_path.stat().st_size < 50_000:
        raise Exception("Download produced an invalid or empty file")

    _invalidate_songs()  # a new file was added
    return final["name"]


def _existing_urls():
    """Return a set of source URLs already present in the library."""
    urls = set()
    for f in DOWNLOAD_DIR.glob("*.url"):
        try:
            u = f.read_text(errors="ignore").strip()
            if u:
                urls.add(u)
        except Exception:
            pass
    return urls


def _video_id_from_thumb(thumb_url):
    """YouTube thumbnail URLs embed the 11-char video id: .../vi/<id>/... ."""
    m = re.search(r"/vi(?:_webp)?/([A-Za-z0-9_-]{11})", thumb_url or "")
    return m.group(1) if m else None


def _backfill_urls():
    """Recover source URLs for songs downloaded before URL-saving existed.

    Older songs have a "<file>.thumb" sidecar but no "<file>.url". The YouTube
    video id can be pulled out of the thumbnail URL, letting us rebuild the
    watch URL so these songs become exportable too. Returns count recovered.
    """
    recovered = 0
    try:
        files = list(DOWNLOAD_DIR.iterdir())
    except Exception:
        return 0

    for f in files:
        if f.suffix not in (".mp4", ".m4a", ".mp3"):
            continue

        url_path = Path(str(f) + ".url")
        if url_path.exists():
            continue

        thumb_path = Path(str(f) + ".thumb")
        if not thumb_path.exists():
            continue

        try:
            thumb = thumb_path.read_text(errors="ignore").strip()
        except Exception:
            continue

        vid = _video_id_from_thumb(thumb)
        if vid:
            try:
                url_path.write_text(f"https://www.youtube.com/watch?v={vid}")
                recovered += 1
            except Exception:
                pass

    return recovered


def _build_library_export():
    """Build a list of {title, url, thumbnail} for every song that has a URL."""
    # Recover URLs for legacy songs first so they can be exported too.
    _backfill_urls()

    songs = []
    for f in DOWNLOAD_DIR.iterdir():
        if f.suffix not in (".mp4", ".m4a", ".mp3"):
            continue

        url_path = Path(str(f) + ".url")
        if not url_path.exists():
            continue  # Can't export a song without a known source URL.

        try:
            url = url_path.read_text(errors="ignore").strip()
        except Exception:
            continue
        if not url:
            continue

        thumb = ""
        thumb_path = Path(str(f) + ".thumb")
        if thumb_path.exists():
            try:
                thumb = thumb_path.read_text(errors="ignore").strip()
            except Exception:
                thumb = ""

        songs.append({"title": f.stem, "url": url, "thumbnail": thumb})

    return songs


# ---------------- Export ----------------
@app.route("/export_data")
def export_data():
    """Raw JSON for in-app display (copy / share)."""
    return jsonify({"songs": _build_library_export()})


@app.route("/export")
def export_file():
    """Downloadable JSON file (browser / DownloadManager)."""
    payload = json.dumps({"songs": _build_library_export()}, indent=2)
    return Response(
        payload,
        mimetype="application/json",
        headers={
            "Content-Disposition": "attachment; filename=tubeify_library.json"
        },
    )


# ---------------- Socket Download ----------------
@socketio.on("download")
def handle_download(data):
    url = data.get("url")
    if not url:
        socketio.emit("error", {"error": "No URL"})
        return

    def run():
        try:
            socketio.emit("started", {"url": url})

            last_emit = [0]

            def cb(percent):
                now = time.time()
                if now - last_emit[0] > 0.3:
                    socketio.emit("progress", {"percent": percent})
                    last_emit[0] = now

            final_filename = _download_url(url, cb)

            socketio.emit("progress", {"percent": 100})
            socketio.emit("completed", {
                "file_path": final_filename,
                "format": "mp4"
            })

        except Exception as e:
            socketio.emit("error", {"error": str(e)})

    threading.Thread(target=run, daemon=True).start()


# ---------------- Socket Import ----------------
@socketio.on("import_library")
def handle_import(data):
    songs = data.get("songs", []) or []

    def run():
        existing = _existing_urls()
        total = len(songs)
        added = skipped = failed = 0

        socketio.emit("import_started", {"total": total})

        for i, song in enumerate(songs):
            url = (song.get("url") or "").strip()
            title = song.get("title") or url

            if not url:
                failed += 1
                socketio.emit("import_progress", {
                    "current": i + 1, "total": total,
                    "title": title, "status": "failed"
                })
                continue

            if url in existing:
                skipped += 1
                socketio.emit("import_progress", {
                    "current": i + 1, "total": total,
                    "title": title, "status": "skipped"
                })
                continue

            socketio.emit("import_progress", {
                "current": i + 1, "total": total,
                "title": title, "status": "downloading", "percent": 0
            })

            try:
                last_emit = [0]

                def cb(percent, idx=i, t=title):
                    now = time.time()
                    if now - last_emit[0] > 0.3:
                        socketio.emit("import_progress", {
                            "current": idx + 1, "total": total,
                            "title": t, "status": "downloading",
                            "percent": percent
                        })
                        last_emit[0] = now

                _download_url(url, cb)
                existing.add(url)
                added += 1
            except Exception as e:
                failed += 1
                socketio.emit("import_progress", {
                    "current": i + 1, "total": total,
                    "title": title, "status": "failed",
                    "error": str(e)
                })

        socketio.emit("import_done", {
            "added": added, "skipped": skipped, "failed": failed
        })

    threading.Thread(target=run, daemon=True).start()


# ---------------- Start Flask ----------------
def start_backend():
    # Run one-time maintenance in the background so it never delays startup:
    #   - recover source URLs for legacy songs (needed for export)
    #   - cache thumbnail images locally (offline + instant library render)
    def _maintenance():
        try:
            _backfill_urls()
        except Exception as e:
            print(f"URL backfill skipped: {e}")
        try:
            _backfill_thumbs()
        except Exception as e:
            print(f"Thumb backfill skipped: {e}")

    threading.Thread(target=_maintenance, daemon=True).start()

    threading.Thread(
        target=lambda: socketio.run(
            app,
            host="127.0.0.1",
            port=8000,
            debug=False,
            allow_unsafe_werkzeug=True
        ),
        daemon=True
    ).start()
