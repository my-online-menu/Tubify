import threading
import webview
from flask import Flask, render_template, request, Response, send_file
import requests
import os
import re

app = Flask(__name__)
BACKEND_URL = "http://127.0.0.1:5000"
DOWNLOAD_DIR = os.path.abspath("downloads")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

@app.route('/')
def index():
    return render_template("index.html")

@app.route('/playlist')
def playlist():
    try:
        r = requests.get(f"{BACKEND_URL}/playlist")
        return r.text
    except Exception as e:
        return str(e), 500

@app.route('/search', methods=['POST'])
def search():
    query = request.form.get('query', '')
    try:
        r = requests.post(f"{BACKEND_URL}/search", data={'query': query})
        return r.text
    except Exception as e:
        return str(e), 500

# ---------------- FIXED DOWNLOAD WITH RANGE SUPPORT ----------------
@app.route('/download/<filename>')
def download(filename):
    # Path to local file (ensure it matches backend storage)
    file_path = os.path.join(DOWNLOAD_DIR, filename)

    # First, check if file exists locally; if not, download from backend
    if not os.path.exists(file_path):
        # Download file from backend
        r = requests.get(f"{BACKEND_URL}/download/{filename}", stream=True)
        with open(file_path, 'wb') as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)

    # Handle Range headers for seekable video/audio
    range_header = request.headers.get('Range', None)
    if not range_header:
        return send_file(file_path, as_attachment=False)

    size = os.path.getsize(file_path)
    byte1, byte2 = 0, None
    m = re.search(r'bytes=(\d+)-(\d*)', range_header)
    if m:
        g = m.groups()
        byte1 = int(g[0])
        if g[1]:
            byte2 = int(g[1])
    byte2 = byte2 or size - 1
    length = byte2 - byte1 + 1

    with open(file_path, 'rb') as f:
        f.seek(byte1)
        data = f.read(length)

    rv = Response(data, 206, mimetype="video/mp4", content_type="video/mp4", direct_passthrough=True)
    rv.headers.add('Content-Range', f'bytes {byte1}-{byte2}/{size}')
    rv.headers.add('Accept-Ranges', 'bytes')
    return rv

@app.route('/remove', methods=['POST'])
def remove():
    data = request.get_json()
    try:
        r = requests.post(f"{BACKEND_URL}/remove", json=data)
        # Also remove local cached copy
        file_path = os.path.join(DOWNLOAD_DIR, data.get('path', ''))
        if os.path.exists(file_path):
            os.remove(file_path)
        return r.text
    except Exception as e:
        return str(e), 500

def run_flask():
    app.run(host="127.0.0.1", port=8000)

if __name__ == "__main__":
    threading.Thread(target=run_flask, daemon=True).start()
    webview.create_window("MaxTralala Mobile", "http://127.0.0.1:8000", width=400, height=700)
    webview.start()
