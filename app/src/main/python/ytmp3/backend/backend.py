import os
from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit
import yt_dlp

app = Flask(__name__)
app.config['SECRET_KEY'] = os.urandom(24).hex()
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

DOWNLOAD_DIR = os.path.abspath("downloads")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

# ---------------- SEARCH ----------------
@app.route('/search', methods=['POST'])
def search():
    query = request.form.get('query', '')
    if not query:
        return jsonify({'error': 'No query'}), 400

    try:
        with yt_dlp.YoutubeDL({'quiet': True}) as ydl:
            info = ydl.extract_info(f"ytsearch5:{query}", download=False)['entries']
            return jsonify([{
                'title': v.get('title'),
                'url': v.get('webpage_url'),
                'thumbnail': v.get('thumbnail'),
                'description': v.get('description', '')
            } for v in info])
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ---------------- PLAYLIST ----------------
@app.route('/playlist')
def playlist():
    data = {'audio': [], 'video': []}

    for f in os.listdir(DOWNLOAD_DIR):
        if not (f.endswith('.mp3') or f.endswith('.mp4')):
            continue

        thumb = ''
        thumb_path = os.path.join(DOWNLOAD_DIR, f + '.thumb')
        if os.path.exists(thumb_path):
            with open(thumb_path, 'r', encoding='utf-8') as t:
                thumb = t.read().strip()

        item = {'title': f, 'path': f, 'thumbnail': thumb}

        if f.endswith('.mp3'):
            data['audio'].append(item)
        else:
            data['video'].append(item)

    return jsonify(data)


# ---------------- FILE STREAM (IMPORTANT) ----------------
@app.route('/download/<filename>')
def download_file(filename):
    # ❗ as_attachment=False allows inline video playback
    return send_from_directory(DOWNLOAD_DIR, filename, as_attachment=False)


# ---------------- REMOVE ----------------
@app.route('/remove', methods=['POST'])
def remove_file():
    data = request.get_json()
    path = data.get('path')
    if not path:
        return jsonify({'success': False}), 400

    try:
        file_path = os.path.join(DOWNLOAD_DIR, path)
        thumb_path = file_path + '.thumb'

        if os.path.exists(file_path):
            os.remove(file_path)
        if os.path.exists(thumb_path):
            os.remove(thumb_path)

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


# ---------------- SOCKET DOWNLOAD ----------------
@socketio.on('download')
def handle_download(data):
    url = data.get('url')
    fmt = data.get('format', 'mp3')

    if not url:
        emit('error', {'error': 'No URL provided'})
        return

    ydl_opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4' if fmt == 'mp4' else 'bestaudio/best',
        'outtmpl': os.path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s'),
        'noplaylist': True,
        'quiet': True,
        'progress_hooks': [lambda d: emit('progress', d)],
    }

    if fmt == 'mp3':
        ydl_opts['postprocessors'] = [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '192'
        }]
    # No need for postprocessor for MP4 video conversion; yt-dlp downloads MP4 directly.

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)

            filename = ydl.prepare_filename(info)

            # normalize extension
            if fmt == 'mp3':
                filename = filename.replace('.webm', '.mp3').replace('.m4a', '.mp3')
            else:
                filename = filename.replace('.mkv', '.mp4').replace('.webm', '.mp4')

            # ✅ save thumbnail for BOTH audio and video
            thumbnail = info.get('thumbnail', '')
            if thumbnail:
                with open(filename + '.thumb', 'w', encoding='utf-8') as f:
                    f.write(thumbnail)

            emit('completed', {
                'file_path': os.path.basename(filename),
                'thumbnail': thumbnail,
                'format': fmt
            })

    except Exception as e:
        emit('error', {'error': str(e)})


# ---------------- RUN ----------------
if __name__ == "__main__":
    print("Backend running at http://127.0.0.1:5000")
    socketio.run(app, host='127.0.0.1', port=5000, debug=True)
