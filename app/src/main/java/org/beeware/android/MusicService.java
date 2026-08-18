package org.beeware.android;

import android.app.*;
import android.content.*;
import android.media.*;
import android.os.*;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.support.v4.media.MediaMetadataCompat;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;


/*test */
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

public class MusicService extends Service {

    public static final String ACTION_PLAY_AUDIO = "PLAY_AUDIO";
    public static final String ACTION_TOGGLE_PLAY = "TOGGLE_PLAY_PAUSE";
    public static final String ACTION_NEXT = "NEXT_TRACK";
    public static final String ACTION_PREV = "PREV_TRACK";

    private static final String CHANNEL_ID = "music_playback";
    private static final int NOTIF_ID = 1;

    public static MusicService instance;
    public WebView musicWebView;

    private MediaPlayer player;
    private MediaSessionCompat mediaSession;
    private AudioManager audioManager;
    private PowerManager.WakeLock wakeLock;
    private AudioFocusRequest focusRequest;

    private String currentUrl;
    private String currentThumb;
    private String currentTitle = "Nothing playing";
    private Bitmap currentArt;   // album art for the notification / lock screen
    private int currentColor = 0; // dominant colour of the art (0 = none) for the colorized box
    private boolean isPreparing = false;
    // Guards against the poll-check and onCompletion both advancing the same
    // track-end (which would skip a song). Reset when a new track starts.
    private boolean autoAdvancing = false;
    private Handler autoNextHandler;
private Runnable autoNextRunnable;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;

        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);

        createNotificationChannel();
        initMediaSession();
        initPlayer();

        startForeground(NOTIF_ID, buildNotification(false));
    }

    private void initMediaSession() {
        mediaSession = new MediaSessionCompat(this, "MusicService");
        mediaSession.setActive(true);
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { resume(); }
            @Override public void onPause() { pause(); }
            @Override public void onSkipToNext() { notifyJSNext(); }
            @Override public void onSkipToPrevious() { notifyJSPrev(); }
            @Override public void onSeekTo(long pos) {
                if (player != null && !isPreparing) {
                    try {
                        player.seekTo((int) pos);   // notification scrubber → seek
                        updateState(isPlaying());   // reflect new position immediately
                        syncJS();                   // keep the web timeline in sync
                    } catch (Exception e) {
                        e.printStackTrace();
                    }
                }
            }
        });
    }

  private void initPlayer() {
    player = new MediaPlayer();
    player.setAudioAttributes(
            new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
    );

    player.setOnPreparedListener(mp -> {
        isPreparing = false;
        acquireWakeLock();
        mp.start();
        updateState(true);
        syncJS();

        // Start periodic completion check for MP4s
        startAutoNextCheck();
    });

    player.setOnCompletionListener(mp -> {
        isPreparing = false;
        releaseWakeLock();

        // Advance via the guarded path so we don't double-skip with the poll.
        handleAutoAdvance();
    });
}

// Single entry point for "track ended → go to next". Both the poll check and
// onCompletion call this; the guard ensures only the first one per track wins.
private void handleAutoAdvance() {
    if (autoAdvancing) return;
    autoAdvancing = true;
    stopAutoNextCheck();
    notifyJSNext();
}


// UPDATE this method in MusicService.java
private void startAutoNextCheck() {
    if (autoNextHandler == null) autoNextHandler = new Handler(Looper.getMainLooper());
    if (autoNextRunnable != null) autoNextHandler.removeCallbacks(autoNextRunnable);

    autoNextRunnable = new Runnable() {
        @Override
        public void run() {
            if (player != null && player.isPlaying() && !isPreparing) {
                int pos = player.getCurrentPosition();
                int dur = player.getDuration();

                // Increase buffer to 500ms and check that duration is valid
                if (dur > 1000 && pos >= dur - 500) {
                    handleAutoAdvance(); // guarded; also stops the check
                    return;
                }
            }
            autoNextHandler.postDelayed(this, 500); // Check every half second instead of 200ms
        }
    };
    autoNextHandler.postDelayed(autoNextRunnable, 500);
}

private void stopAutoNextCheck() {
    if (autoNextHandler != null && autoNextRunnable != null) {
        autoNextHandler.removeCallbacks(autoNextRunnable);
    }
}


    // ==================== NOTIFY JS ====================
private void notifyJSNext() {
        // Use the local reference if available, otherwise use the global instance
        final WebView targetWebView = (musicWebView != null) ? musicWebView : 
                                     (MainActivity.instance != null ? MainActivity.instance.findViewById(android.R.id.content).findViewWithTag("webview_tag") : null);

        if (targetWebView != null) {
            targetWebView.post(() -> {
                // We add window. to ensure it finds the global JS function
                targetWebView.evaluateJavascript("if(window.playNextTrack) { window.playNextTrack('android-system'); }", null);
            });
        } else if (MainActivity.instance != null) {
            // Fallback to the helper method in MainActivity
            MainActivity.instance.triggerJsNextTrack();
        }
    }

    private void notifyJSPrev() {
    final WebView targetWebView = (musicWebView != null) ? musicWebView : 
                                 (MainActivity.instance != null ? MainActivity.instance.findViewById(android.R.id.content).findViewWithTag("webview_tag") : null);

    if (targetWebView != null) {
        targetWebView.post(() -> {
            // Match the function name in your script.js
            targetWebView.evaluateJavascript("if(window.playPrevTrack) { window.playPrevTrack(); }", null);
        });
    }
}

    // ==================== COMMANDS ====================
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) return START_STICKY;

        switch (intent.getAction()) {
            case ACTION_PLAY_AUDIO:
                String url = intent.getStringExtra("audioFile");
                String thumb = intent.getStringExtra("thumbUrl");
                // Reset the auto-next check whenever a new song starts
                stopAutoNextCheck();
                if (url != null) {
                    currentThumb = thumb;
                    play(url);
                    // Load the thumbnail as album art (notification background).
                    updateNotificationMetadata(currentTitle, thumb);
                }
                break;
            case ACTION_TOGGLE_PLAY:
                if (isPlaying()) pause(); else resume();
                break;
            case ACTION_NEXT:
                notifyJSNext();
                break;
            case ACTION_PREV:
                notifyJSPrev();
                break;
        }

        return START_STICKY;
    }

    // ==================== PLAYER CONTROL ====================
    private void play(String url) {
        try {
            if (player == null) initPlayer();

            requestAudioFocus();

            player.reset();
            currentUrl = url;
            isPreparing = true;
            autoAdvancing = false; // new track: re-arm auto-advance
            currentArt = null;     // clear old art until the new thumb loads
            currentColor = 0;      // clear old box colour until new art loads

            acquireWakeLock();

            currentTitle = URLDecoder.decode(
                    url.substring(url.lastIndexOf('/') + 1),
                    StandardCharsets.UTF_8.name()
            );

            player.setDataSource(url);
            player.prepareAsync();
            updateState(false);

        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void pause() {
        if (player != null && player.isPlaying()) {
            player.pause();
            releaseWakeLock();
            abandonAudioFocus();
            updateState(false);
            syncJS();
            stopAutoNextCheck();
        }
    }

    private void resume() {
        if (player != null && currentUrl != null && !isPreparing) {
            int result = requestAudioFocus();
            if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return;

            if (!player.isPlaying()) {
                player.start();
                acquireWakeLock();
                updateState(true);
                syncJS();
            }
        }
    }

    public boolean isPlaying() { return player != null && player.isPlaying(); }

    // ==================== MEDIA SESSION & NOTIFICATION ====================
private void updateNotificationMetadata(String title, String thumbUrl) {
    final String startedUrl = currentUrl; // guard against a race with the next song
    new Thread(() -> {
        Bitmap art = null;
        try {
            if (thumbUrl != null && !thumbUrl.isEmpty()) {
                URL url = new URL(thumbUrl);
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                connection.setDoInput(true);
                connection.connect();
                InputStream input = connection.getInputStream();
                art = BitmapFactory.decodeStream(input);
            }
        } catch (Exception e) {
            e.printStackTrace();
        }

        final Bitmap finalArt = art;
        final int finalColor = (art != null) ? dominantColor(art) : 0;
        new Handler(Looper.getMainLooper()).post(() -> {
            // Ignore if the user already moved on to a different song.
            if (startedUrl != null && !startedUrl.equals(currentUrl)) return;

            currentArt = finalArt;
            currentColor = finalColor;
            // Rebuild metadata (incl. art) + notification through the normal path.
            updateState(isPlaying());
        });
    }).start();
}

// Average colour of the artwork, darkened so white controls/text stay readable.
// Used to colorize the whole notification box (Spotify-style).
private int dominantColor(Bitmap bmp) {
    try {
        Bitmap small = Bitmap.createScaledBitmap(bmp, 16, 16, true);
        long r = 0, g = 0, b = 0;
        int count = 0;
        for (int y = 0; y < small.getHeight(); y++) {
            for (int x = 0; x < small.getWidth(); x++) {
                int px = small.getPixel(x, y);
                r += (px >> 16) & 0xff;
                g += (px >> 8) & 0xff;
                b += px & 0xff;
                count++;
            }
        }
        if (count == 0) return 0;
        int ar = (int) (r / count * 0.55);
        int ag = (int) (g / count * 0.55);
        int ab = (int) (b / count * 0.55);
        return 0xff000000 | (ar << 16) | (ag << 8) | ab;
    } catch (Exception e) {
        return 0;
    }
}





    
private void updateMetadata() {
    if (mediaSession == null || player == null || isPreparing) return;

    try {
        // Use the MediaMetadataCompat class we just imported
        MediaMetadataCompat.Builder builder = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, "Tubeify")
                // This value is what actually "stretches" the timeline slider
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, player.getDuration());

        // Keep the album art on every metadata refresh so it isn't clobbered.
        if (currentArt != null) {
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, currentArt);
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, currentArt);
        }

        mediaSession.setMetadata(builder.build());
    } catch (Exception e) {
        e.printStackTrace();
    }
}

    
    private void updateState(boolean playing) {
    if (mediaSession == null || player == null) return;

    long position = PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN;
    try {
        if (!isPreparing) {
            position = player.getCurrentPosition(); // Get real position from player
        }
    } catch (Exception e) {
        e.printStackTrace();
    }

    PlaybackStateCompat state = new PlaybackStateCompat.Builder()
            .setState(
                    playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                    position, 
                    playing ? 1.0f : 0f // 1.0f tells Android to "tick" the clock forward
            )
            .setActions(
                    PlaybackStateCompat.ACTION_PLAY |
                    PlaybackStateCompat.ACTION_PAUSE |
                    PlaybackStateCompat.ACTION_PLAY_PAUSE |
                    PlaybackStateCompat.ACTION_SKIP_TO_NEXT |
                    PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS |
                    PlaybackStateCompat.ACTION_SEEK_TO // Enables scrubbing in notification
            )
            .build();

    mediaSession.setPlaybackState(state);

    // Update the metadata so the slider knows the "Max" duration
    updateMetadata();

    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    nm.notify(NOTIF_ID, buildNotification(playing));
}

    private Notification buildNotification(boolean playing) {
        PendingIntent toggleIntent = PendingIntent.getService(
                this, 0,
                new Intent(this, MusicService.class).setAction(ACTION_TOGGLE_PLAY),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        PendingIntent nextIntent = PendingIntent.getService(
                this, 1,
                new Intent(this, MusicService.class).setAction(ACTION_NEXT),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        PendingIntent prevIntent = PendingIntent.getService(
                this, 2,
                new Intent(this, MusicService.class).setAction(ACTION_PREV),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(currentTitle)
                .setContentText("Tubeify")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .addAction(android.R.drawable.ic_media_previous, "Prev", prevIntent)
                .addAction(
                        playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        playing ? "Pause" : "Play",
                        toggleIntent
                )
                .addAction(android.R.drawable.ic_media_next, "Next", nextIntent)
                .setStyle(new MediaStyle()
                        .setMediaSession(mediaSession.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2))
                .setOngoing(playing);

        // Album art = large icon (the system also uses it as the media-player
        // background on Android 12+ lock screen / quick-settings).
        if (currentArt != null) {
            builder.setLargeIcon(currentArt);
        }
        // Tint the whole notification box with the artwork's dominant colour.
        if (currentColor != 0) {
            builder.setColorized(true).setColor(currentColor);
        }

        return builder.build();
    }

    // ==================== AUDIO FOCUS ====================
    private int requestAudioFocus() {
        int result = AudioManager.AUDIOFOCUS_REQUEST_FAILED;

        if (Build.VERSION.SDK_INT >= 26) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(
                            new AudioAttributes.Builder()
                                    .setUsage(AudioAttributes.USAGE_MEDIA)
                                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                                    .build()
                    )
                    .setOnAudioFocusChangeListener(focus -> {
    switch (focus) {
        case AudioManager.AUDIOFOCUS_LOSS:
            if (player != null && !player.isPlaying() && !isPreparing) {
                // Do nothing here to let completion handle auto-next
            } else {
                pause();
            }
            break;
        case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
            pause();
            break;
        case AudioManager.AUDIOFOCUS_GAIN:
            if (player != null && !player.isPlaying() && !isPreparing) resume();
            break;
    }
})

                    .build();
            result = audioManager.requestAudioFocus(focusRequest);
        } else {
            result = audioManager.requestAudioFocus(focus -> {
                if (focus <= 0) pause();
                else if (focus > 0 && player != null && !player.isPlaying() && !isPreparing) resume();
            }, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }

        return result;
    }

    private void abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= 26 && focusRequest != null) {
            audioManager.abandonAudioFocusRequest(focusRequest);
        } else {
            audioManager.abandonAudioFocus(null);
        }
    }

    // ==================== WAKELOCK ====================
    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Tubeify::Audio");
        }
        if (!wakeLock.isHeld()) wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    // ==================== NOTIFICATION CHANNEL ====================
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Music Playback",
                    NotificationManager.IMPORTANCE_LOW
            );
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    // ==================== JS INTERFACE ====================
    private void syncJS() {
        if (musicWebView != null) {
            musicWebView.post(() ->
                    musicWebView.evaluateJavascript("syncMiniPlayButton();", null)
            );
        }
    }

   @JavascriptInterface
public void playAudioJS(String url, String thumb) {
    // 1. Save the thumb to the class variable
    this.currentThumb = thumb;

    // 2. Check if it's the same song
    if (currentUrl != null && currentUrl.equals(url)) {
        if (isPlaying()) {
            return;
        } else {
            resume();
            return;
        }
    }

    // 3. If it's a new song, play it
    play(url);

    // 4. Update the notification background image
    // Note: Use 'thumb' directly here
    updateNotificationMetadata(currentTitle, thumb);
}

    @JavascriptInterface
    public void togglePlayPauseJS() {
        if (isPlaying()) pause(); else resume();
    }

    @JavascriptInterface
    public boolean isPlayingJS() { return isPlaying(); }

    @JavascriptInterface
public float getCurrentPositionJS() {
    // If player is null or busy preparing, return 0 to avoid crashes
    if (player != null && !isPreparing) {
        try {
            return player.getCurrentPosition() / 1000f;
        } catch (Exception e) { return 0; }
    }
    return 0;
}

@JavascriptInterface
public float getDurationJS() {
    if (player != null && !isPreparing) {
        try {
            return player.getDuration() / 1000f;
        } catch (Exception e) { return 0; }
    }
    return 0;
}

  @JavascriptInterface
public void seekJS(float seconds) {
    if (player != null) {
        try {
            // Android MediaPlayer uses milliseconds (seconds * 1000)
            int msec = (int) (seconds * 1000);
            
            // Safety check: don't seek outside the song length
            int duration = player.getDuration();
            if (msec < 0) msec = 0;
            if (msec > duration) msec = duration;
            
            player.seekTo(msec);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}

    @JavascriptInterface
    public void nextTrackJS() { notifyJSNext(); }

    @JavascriptInterface
    public void prevTrackJS() { notifyJSPrev(); }

    // ==================== SERVICE LIFECYCLE ====================
    @Override
    public void onDestroy() {
        super.onDestroy();
        if (player != null) player.release();
        stopAutoNextCheck();

        releaseWakeLock();
        abandonAudioFocus();
        if (mediaSession != null) mediaSession.release();
        instance = null;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }
}
