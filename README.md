<div align="center">

<img src="docs/icon.png" width="96" height="96" alt="Tubify">

# Tubify

**Search, download and play music from YouTube — right on your phone.**
Free, offline, no ads.

### [⬇ Download the app](https://my-online-menu.github.io/Tubify/) &nbsp;·&nbsp; [Latest release](https://github.com/my-online-menu/Tubify/releases/latest)

</div>

---

## Features

- 🔍 **Search & save** — find any track or paste a link and save it in a tap
- 🎵 **Offline library** — your songs live on your device and play without a connection
- 📃 **Playlists** — group songs and see which playlists each track belongs to
- ▶️ **Background player** — lock-screen & notification controls, keeps playing in the background
- ↔️ **Export & import** — move your whole library to a new phone
- ✨ **Clean, modern dark UI**

## Install

Head to the **[download page](https://my-online-menu.github.io/Tubify/)**, get the APK, open it on
your Android phone, and allow the install when prompted.

## Build from source

A [BeeWare](https://beeware.org/) / [Chaquopy](https://chaquo.com/chaquopy/) app — a Python
(Flask + Socket.IO) backend running in an Android WebView, with native Java for playback.

Requirements: **JDK 17**, the **Android SDK** (platform 35, build-tools 35), and **Python 3.12**.

```bash
echo "sdk.dir=/path/to/Android/Sdk" > local.properties
./gradlew assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

### Project layout

```
app/src/main/
  python/ytmp3/            # Flask + Socket.IO backend + web UI
    main.py                #   search / download / library / playlists / export-import
    frontend/              #   index.html, script.js, styles.css
  java/org/beeware/android/
    MainActivity.java      # WebView host + JS bridge
    MusicService.java      # foreground media service (MediaSession, notification)
```

## License

See [LICENSE](LICENSE).
