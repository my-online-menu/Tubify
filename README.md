# Tubeify

An Android music app that searches YouTube, downloads tracks, and plays them with
a background player (lock-screen / notification controls, playlists, library
export/import). Built with **BeeWare/Briefcase + Chaquopy** — a Python
(Flask + Socket.IO) backend running inside an Android WebView, with native Java
for playback.

## Project layout

```
app/src/main/
  python/ytmp3/            # Python app
    main.py                #   Flask + Socket.IO backend (search / download / library / playlists / export-import)
    frontend/
      templates/index.html #   UI markup
      static/script.js     #   all UI + player logic
      static/styles.css    #   theme
  java/org/beeware/android/
    MainActivity.java      # WebView host + JS bridge + file chooser + share
    MusicService.java      # foreground media service (MediaSession, notification, seek)
  res/                     # icons, strings, styles
  AndroidManifest.xml
app/build.gradle           # Chaquopy config (Python version, pip requirements)
requirements.txt           # Python deps (flask, flask-socketio, yt-dlp, requests, ...)
```

Songs and their `.thumb` / `.url` sidecars plus `tubeify_playlists.json` are stored
in app-private internal storage (`~/ytmp3_downloads`), so they survive in-place
app updates.

## Building

Requires: JDK 17, the Android SDK (platform 35, build-tools 35), and a **real
Python 3.12** on `PATH` for Chaquopy's build step.

```bash
# point Gradle at your SDK
echo "sdk.dir=/path/to/Android/Sdk" > local.properties

# build a debug APK
./gradlew assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

> Note: Chaquopy needs to find Python 3.12 to install the pip requirements at
> build time. If it reports "Couldn't find Python 3.12", put a real 3.12
> interpreter first on `PATH` (a Windows Store stub is not sufficient).

## Installing (Xiaomi / MIUI / HyperOS note)

MIUI blocks `adb install` by default (`INSTALL_FAILED_USER_RESTRICTED`). Either
enable **Developer options → Install via USB**, or push the APK and tap-install it:

```bash
adb push app/build/outputs/apk/debug/app-debug.apk /sdcard/Download/
# then open Files → Download → tap the APK
```

Always update in place (never uninstall) to keep your downloaded music — that only
works when the new build is signed with the same debug keystore as the installed one.
