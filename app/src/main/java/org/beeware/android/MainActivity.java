package org.beeware.android;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.ValueCallback;
import android.content.Intent;
import android.net.Uri;
import android.webkit.JavascriptInterface;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;
import android.view.WindowManager;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends AppCompatActivity {

    private static final String BACKEND_URL = "http://127.0.0.1:8000";
    private static final int FILE_CHOOSER_CODE = 1001;
    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
public static MainActivity instance;
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
instance = this; // <--- ADD THIS LINE HERE
        // Hide ActionBar
        if (getSupportActionBar() != null) getSupportActionBar().hide();

        // Full screen immersive mode
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().getInsetsController().hide(
                android.view.WindowInsets.Type.statusBars()
            );
        } else {
            getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN
            );
        }

        // Start Python / Flask backend
        if (!Python.isStarted()) {
            Python.start(new AndroidPlatform(this));
        }
        Python py = Python.getInstance();
        py.getModule("ytmp3.main").callAttr("start_backend");

        // Start Music Service
        Intent serviceIntent = new Intent(this, MusicService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }

        // Setup WebView
        webView = new WebView(this);
        webView.setTag("webview_tag"); // Add this line
if (MusicService.instance != null) {
            MusicService.instance.musicWebView = webView;
        }
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);

        // --- ADD THIS LINE TO FIX PREVIEW UNAVAILABLE ---
        settings.setUserAgentString("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36");
        // Keep the HTTP cache between launches so static assets (script/css/
        // socket.io) and locally-served thumbnails don't re-download every start.
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        // ------------------------------------------------
        settings.setAllowFileAccess(true);
settings.setAllowContentAccess(true);
settings.setAllowUniversalAccessFromFileURLs(true);
settings.setAllowFileAccessFromFileURLs(true);
        // IMPORTANT: Allow autoplay without user gesture
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Optional: allow debugging
        WebView.setWebContentsDebuggingEnabled(true);

       // --- REPLACE THEM WITH THIS BLOCK ---
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                // If it fails (offline startup), wait 1 second and retry
                if (failingUrl.equals(BACKEND_URL)) {
                    view.postDelayed(() -> view.loadUrl(BACKEND_URL), 1000);
                }
            }

            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) {
                // For newer Android versions
                if (request.getUrl().toString().equals(BACKEND_URL)) {
                    view.postDelayed(() -> view.loadUrl(BACKEND_URL), 1000);
                }
            }
        });

        // Enable <input type="file"> (used by the Library import picker)
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;

                Intent intent;
                try {
                    intent = params.createIntent();
                } catch (Exception e) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("application/json");
                }

                try {
                    startActivityForResult(intent, FILE_CHOOSER_CODE);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        // Add JS bridge to control MusicService
        webView.addJavascriptInterface(new JSBridge(), "Android");

        webView.loadUrl(BACKEND_URL);
        setContentView(webView);
    }
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_CODE) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                results = new Uri[]{ data.getData() };
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

public void triggerJsNextTrack() {
    if (webView != null) {
        webView.post(() -> {
            webView.evaluateJavascript("window.playNextTrack('android-safety-trigger');", null);
        });
    }
}
    private class JSBridge {

        @JavascriptInterface
        public void setPlaylistJS(String jsonPlaylist) {
            // Optional: handle playlist on Android side if needed
        }

        @JavascriptInterface
        public void playAudioJS(String url, String thumb) {
            if (MusicService.instance != null) {
                Intent intent = new Intent(MainActivity.this, MusicService.class);
                intent.setAction(MusicService.ACTION_PLAY_AUDIO);
                intent.putExtra("audioFile", url);
                intent.putExtra("thumbUrl", thumb);
                startService(intent);
            }
        }

        @JavascriptInterface
        public void togglePlayPauseJS() {
            if (MusicService.instance != null) {
                Intent intent = new Intent(MainActivity.this, MusicService.class);
                intent.setAction(MusicService.ACTION_TOGGLE_PLAY);
                startService(intent);
            }
        }

        @JavascriptInterface
        public void nextTrackJS() {
            if (MusicService.instance != null) {
                Intent intent = new Intent(MainActivity.this, MusicService.class);
                intent.setAction(MusicService.ACTION_NEXT);
                startService(intent);
            }
        }

        @JavascriptInterface
        public void prevTrackJS() {
            if (MusicService.instance != null) {
                Intent intent = new Intent(MainActivity.this, MusicService.class);
                intent.setAction(MusicService.ACTION_PREV);
                startService(intent);
            }
        }
        @JavascriptInterface
    public float getCurrentPositionJS() {
        if (MusicService.instance != null) {
            return MusicService.instance.getCurrentPositionJS();
        }
        return 0;
    }

    @JavascriptInterface
    public float getDurationJS() {
        if (MusicService.instance != null) {
            return MusicService.instance.getDurationJS();
        }
        return 0;
    }

    @JavascriptInterface
    public void seekJS(float seconds) {
        if (MusicService.instance != null) {
            MusicService.instance.seekJS(seconds);
        }
    }

        @JavascriptInterface
        public boolean isPlayingJS() {
            return MusicService.instance != null && MusicService.instance.isPlaying();
        }

        @JavascriptInterface
        public void shareLibraryJS(String json) {
            try {
                File dir = new File(getCacheDir(), "shared");
                if (!dir.exists()) dir.mkdirs();

                File file = new File(dir, "tubeify_library.json");
                FileOutputStream fos = new FileOutputStream(file);
                fos.write(json.getBytes(StandardCharsets.UTF_8));
                fos.close();

                Uri uri = FileProvider.getUriForFile(
                        MainActivity.this,
                        "com.selvi.ytmp3.ytmp3.fileprovider",
                        file
                );

                Intent share = new Intent(Intent.ACTION_SEND);
                share.setType("application/json");
                share.putExtra(Intent.EXTRA_STREAM, uri);
                share.putExtra(Intent.EXTRA_SUBJECT, "Tubeify Library");
                share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                Intent chooser = Intent.createChooser(share, "Share Tubeify Library");
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(chooser);
            } catch (Exception e) {
                e.printStackTrace();
            }
        }
    }
}
