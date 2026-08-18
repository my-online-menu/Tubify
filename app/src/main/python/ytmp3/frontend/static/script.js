// ================= SOCKET =================
const socket = io("http://127.0.0.1:8000");

// ================= STATE =================
let playlist = [];
let currentIndex = -1;
let currentPlayingPath = ""; // stable id of the song currently playing (for the green border)
let shuffle = false;       // shuffle-play toggle
let shuffleBag = [];       // remaining shuffled indices for the current cycle
let playHistory = [];      // indices actually played, so Prev works in shuffle
let currentPlayer = null; // <audio> element for playback
let currentFile = "";
let currentThumb = "";
let downloadInProgress = false;
let downloadFallbackTimer = null;

// ================= DOM =================
const miniPlayer = document.getElementById("miniPlayer");
const miniCover = document.getElementById("miniCover");
const miniInfo = document.getElementById("miniInfo");
const playPauseBtn = miniPlayer.querySelector(".playPauseBtn");
const fullTime = document.getElementById("fullTime");

miniPlayer.style.display = "none";

// ================= TABS =================
function switchTab(section, event) {
    document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
    document.getElementById(section).classList.add("active");
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    (event.currentTarget || event.target).classList.add("active");

    // Refresh data when entering a tab
    if (section === "videoSection") {
        loadLibrary();
    } else if (section === "playlistSection") {
        // Always land on the overview, then refresh
        const detail = document.getElementById("playlistDetail");
        const overview = document.getElementById("playlistOverview");
        if (detail) detail.style.display = "none";
        if (overview) overview.style.display = "block";
        loadPlaylists();
    }
}

// ================= SEARCH SYSTEM =================
document.getElementById("searchBtn").addEventListener("click", doSearch);

function doSearch() {
    const q = document.getElementById("queryInput").value.trim();
    if (!q) return alert("Enter search term");

    showOverlay("searchOverlay", true);
    const container = document.getElementById("searchResults");
    container.innerHTML = "";

    fetch("/search", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "query=" + encodeURIComponent(q)
    })
    .then(r => r.json())
    .then(results => {
        showOverlay("searchOverlay", false);

        if (!results || !results.length || results.error) {
            container.innerHTML = `<p style="color:#bbb; text-align:center; margin-top:20px;">
                ${results.error || "No videos found. Try different keywords."}</p>`;
            return;
        }

        results.forEach(v => {
            const div = document.createElement("div");
            div.className = "list-item";
            // Clean up titles that might have quotes
            const safeTitle = v.title.replace(/'/g, "\\'");
            
            div.innerHTML = `
               <img loading="lazy" decoding="async" src="${v.thumbnail || '/static/video-placeholder.png'}"
     onerror="this.src='/static/video-placeholder.png';">
                <div class="item-info">
                    <strong>${v.title}</strong><br>
                    <small>${v.channel} • ${v.duration}</small>
                    <div style="margin-top:8px; display:flex; gap:10px;">
                       <button class="save-btn" onclick="downloadVideo('${v.url}', event)">Save</button>
                        <button class="preview-btn" onclick="openPreview('${v.url}')">Preview</button>
                    </div>
                </div>
            `;
            container.appendChild(div);
        });
    })
    .catch(err => {
        console.error(err);
        showOverlay("searchOverlay", false);
        alert("Search failed. Please check your connection.");
    });
}

// ================= PREVIEW SYSTEM =================
function openPreview(videoUrl) {
    const modal = document.getElementById("previewModal");
    const container = document.getElementById("iframeContainer");

    // Bulletproof Regex to find the 11-char ID
    const regExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = videoUrl.match(regExp);
    const videoId = (match && match[2].length === 11) ? match[2] : null;

    if (videoId) {
        // Stop background music if it's playing
        if (typeof stopCurrentTrack === "function") stopCurrentTrack(); 
        
        container.innerHTML = `
            <iframe width="100%" height="100%" 
                src="https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1" 
                frameborder="0" 
                allow="autoplay; encrypted-media; picture-in-picture" 
                allowfullscreen>
            </iframe>`;

        modal.style.display = "flex";
    } else {
        alert("Preview unavailable for this link.");
    }
}

function closePreview() {
    const modal = document.getElementById("previewModal");
    const container = document.getElementById("iframeContainer");
    container.innerHTML = ""; // Stop video/audio immediately
    modal.style.display = "none";
}

// ================= PREVIEW SYSTEM =================

/**
 * Opens a YouTube preview modal and handles UI/Android state
 * @param {string} videoUrl - The full YouTube URL
 * @param {string} title - The title of the video
 */
function openPreview(videoUrl, title) {
    const modal = document.getElementById("previewModal");
    const container = document.getElementById("iframeContainer");
    const downloadBtn = document.getElementById("previewDownloadBtn");

    // SAFETY CHECK: Prevents "Cannot set property innerHTML of null"
    if (!modal || !container || !downloadBtn) {
        console.error("Preview Error: One or more HTML elements (previewModal, iframeContainer, previewDownloadBtn) are missing.");
        return;
    }

    // Extract Video ID (handles normal, shortened, and playlist URLs)
    let videoId = "";
    try {
        if (videoUrl.includes("v=")) {
            videoId = videoUrl.split("v=")[1].split("&")[0];
        } else if (videoUrl.includes("youtu.be/")) {
            videoId = videoUrl.split("youtu.be/")[1].split("?")[0];
        } else if (videoUrl.includes("/shorts/")) {
            videoId = videoUrl.split("/shorts/")[1].split("?")[0];
        }
    } catch (e) {
        console.error("Regex/Split Error:", e);
        alert("Could not extract Video ID");
        return;
    }

    if (videoId) {
        // 1. Pause background audio using the global function
        if (typeof stopCurrentTrack === "function") {
            stopCurrentTrack(); 
        }

        // 2. Pause Android Service if playing
        if (typeof Android !== "undefined" && Android.isPlayingJS()) {
            Android.togglePlayPauseJS();
        }

        // 3. Inject the Iframe (Auto-play enabled)
container.innerHTML = `
    <iframe width="100%" height="100%" 
        src="https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&modestbranding=1&rel=0&hl=en&origin=http://127.0.0.1:8000" 
        frameborder="0" 
        allow="autoplay; encrypted-media; picture-in-picture" 
        allowfullscreen>
    </iframe>`;

        // 4. Configure the download button click event
        downloadBtn.onclick = (event) => {
            closePreview();
            // Passing null/event as second param for the enhanced downloadVideo logic
            downloadVideo(videoUrl, event); 
        };

        // 5. Show the modal
        modal.style.display = "flex";
    } else {
        alert("Invalid YouTube URL for preview");
    }
}

/**
 * Closes the preview and kills the iframe to stop audio/video
 */
function closePreview() {
    const modal = document.getElementById("previewModal");
    const container = document.getElementById("iframeContainer");
    
    if (modal) modal.style.display = "none";
    if (container) container.innerHTML = ""; // This stops the YouTube video immediately
}

function closePreview() {
    const modal = document.getElementById("previewModal");
    const container = document.getElementById("iframeContainer");
    container.innerHTML = ""; // This kills the video and the audio immediately
    modal.style.display = "none";
}

// ================= DOWNLOAD =================
function downloadVideo(url, event) {
    if (downloadInProgress) return alert("A download is already running");

    // 1. Target the specific button clicked in the list
    let specificBtn = null;
    if (event && event.target) {
        specificBtn = event.target;
        specificBtn.disabled = true;
        specificBtn.innerHTML = "Pending...";
        specificBtn.style.opacity = "0.5";
        specificBtn.style.cursor = "not-allowed";
    }

    downloadInProgress = true;

    // 2. Disable main search button for safety
    const searchBtn = document.getElementById("searchBtn");
    if (searchBtn) {
        searchBtn.disabled = true;
        searchBtn.style.opacity = 0.6;
        searchBtn.style.cursor = "not-allowed";
    }

    // 3. UI Feedback
    initProgressOverlay("Downloading...");

    // 4. Communication with Backend
    socket.emit("download", { url });

    // 5. Fallback timer
    clearTimeout(downloadFallbackTimer);
    downloadFallbackTimer = setTimeout(() => {
        finalizeDownload("Downloaded ✓");
        // Re-enable specific button if fallback hits
        if (specificBtn) {
            specificBtn.innerHTML = "Saved ✓";
        }
    }, 15000);
}

// ================= INIT DOWNLOAD PROGRESS =================
function initProgressOverlay(text) {
    const overlay = document.getElementById("loadingOverlay");

    // Show overlay
    overlay.style.display = "flex";

    // Text
    let p = overlay.querySelector("p");
    if (!p) {
        p = document.createElement("p");
        overlay.appendChild(p);
    }
    p.textContent = text;

    // Progress bar
    if (!progressBar) {
        progressBar = document.createElement("div");
        progressBar.className = "progress-bar";
        overlay.appendChild(progressBar);
    }
    if (!progressText) {
        progressText = document.createElement("div");
        progressText.className = "progress-text";
        overlay.appendChild(progressText);
    }

    updateProgress(0);
}


// ================= LIBRARY =================
let originalLibrary = []; 

// ================= LIBRARY =================
function loadLibrary() {
    fetch("/playlist")
        .then(r => {
            if (!r.ok) throw new Error("Backend starting...");
            return r.json();
        })
        .then(data => {
            originalLibrary = data.video || [];
            playlist = [...originalLibrary];
            renderLibrary(playlist);
            const title = document.getElementById("libraryTitle");
            if (title) title.textContent = `Library (${originalLibrary.length})`;
            console.log("Library loaded successfully");
        })
        .catch(err => {
            console.warn("Retrying library load in 1s...", err);
            // If offline or backend not ready, wait and try again
            setTimeout(loadLibrary, 1000);
        });
}

// New helper function to draw the list
function renderLibrary(items) {
    const container = document.getElementById("videoList");
    if (!container) return;

    // Build in a fragment and insert once (fewer reflows for big libraries).
    const frag = document.createDocumentFragment();

    // Map path -> master index once, instead of findIndex per row (O(n) vs O(n^2)).
    const indexByPath = {};
    originalLibrary.forEach((item, i) => { indexByPath[item.path] = i; });

    items.forEach((v) => {
        const masterIndex = indexByPath[v.path];

        const div = document.createElement("div");
        div.className = "list-item";
        div.dataset.path = v.path;
        if (v.path && v.path === currentPlayingPath) div.classList.add("active");

        const tags = (v.playlists || [])
            .map(p => `<span class="song-tag">${escapeHtml(p.name)}</span>`)
            .join("");

        // We only pass the INDEX to the functions.
        // This avoids all quote/syntax errors.
        div.innerHTML = `
            <img loading="lazy" decoding="async" src="${v.thumbnail || '/static/video-placeholder.png'}"
     onerror="this.src='/static/video-placeholder.png';">
            <div class="item-info" style="white-space:normal;">
                <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(v.title)}</div>
                <div class="song-tags">${tags}</div>
            </div>
            <button class="addtag-btn" onclick="openAddToPlaylist(${masterIndex})" title="Add to playlist">＋</button>
            <button class="icon-btn play-btn" onclick="playByIndex(${masterIndex})">▶</button>
            <button class="icon-btn del-btn" onclick="removeByIndex(${masterIndex})">✕</button>
        `;
        frag.appendChild(div);
    });

    container.innerHTML = "";
    container.appendChild(frag);
}
// Mark the row of the currently-playing song (green border) wherever it appears.
function updateNowPlayingHighlight() {
    document.querySelectorAll(".list-item").forEach(el => {
        if (el.dataset && el.dataset.path && el.dataset.path === currentPlayingPath) {
            el.classList.add("active");
        } else {
            el.classList.remove("active");
        }
    });
}

// New helper to play by index safely
function playByIndex(index) {
    // Playing from the Library: the play queue IS the library.
    playlist = [...originalLibrary];
    resetShuffleState();

    const track = playlist[index];
    if (!track) return;

    // We clean the path here just before playing
    const cleanPath = track.path.startsWith('/') ? track.path.substring(1) : track.path;
    const playUrl = `/download/${encodeURIComponent(cleanPath)}`;

    playAudio(playUrl, track.thumbnail, index);
}

// New helper to remove by index safely (with confirmation)
function removeByIndex(index) {
    const track = originalLibrary[index];
    if (!track) return;
    tbConfirm(
        "Delete song",
        `Permanently delete “${track.title}” from your device?`,
        "Delete",
        () => { if (typeof removeVideo === 'function') removeVideo(track.path); }
    );
}
// Simple Filter Function
function filterLibrary() {
    const query = document.getElementById("librarySearch").value.toLowerCase();
    
    // Filter the original array based on the title
    const filtered = originalLibrary.filter(song => 
        song.title.toLowerCase().includes(query)
    );
    
    renderLibrary(filtered);
}



// ================= STATE =================
let isAndroidPlayer = false;

// ================= PLAYER =================

function playAudio(file, thumb, index) {
    stopCurrentTrack();

    currentFile = file; // This is now already encoded from playByIndex
    currentThumb = thumb;
    currentIndex = index;
    currentPlayingPath = playlist[index]?.path || "";
    updateNowPlayingHighlight();

    miniInfo.textContent = playlist[index]?.title || "Unknown";
    miniCover.src = thumb || "/static/video-placeholder.png";
    miniPlayer.style.display = "flex";

    if (typeof Android !== "undefined" && Android.playAudioJS) {
        isAndroidPlayer = true;
        // Construct the local address for Android
        // We use 'file' because it's already /download/encoded_name
        const fullUrl = "http://127.0.0.1:8000" + file;
        Android.playAudioJS(fullUrl, thumb || "");
        currentPlayer = null;
    } else {
        isAndroidPlayer = false;
        initAudio(file);
        bindWebTimeline();
    }

    syncMiniPlayButton();
    updateFullAudioPlayer(); 
}

// REPLACE your window.playNextTrack with this one
window.playNextTrack = function(source) {
    if (!playlist || playlist.length === 0) return;

    currentIndex = (currentIndex + 1) % playlist.length;
    const track = playlist[currentIndex];

    if (track) {
        const cleanPath = track.path.startsWith('/') ? track.path.substring(1) : track.path;
        const fileUrl = `http://127.0.0.1:8000/download/${encodeURIComponent(cleanPath)}`;
        
        miniInfo.textContent = track.title;
        miniCover.src = track.thumbnail || "/static/video-placeholder.png";

        if (typeof Android !== "undefined" && Android.playAudioJS) {
            Android.playAudioJS(fileUrl, track.thumbnail || "");
        } else {
            initAudio(`/download/${cleanPath}`);
        }
        
        updateFullAudioPlayer();
        syncMiniPlayButton();
    }
};

function initAudio(src) {
    stopCurrentTrack();

    currentPlayer = document.createElement("audio");
    currentPlayer.src = src;
    currentPlayer.autoplay = true;
    currentPlayer.preload = "auto";
    currentPlayer.style.display = "none";
    document.body.appendChild(currentPlayer);

    // Ensure duration is loaded for MP4
    currentPlayer.addEventListener("canplaythrough", () => {
        audioTimeline.max = currentPlayer.duration || 0;
    });

   // ====================== AUTO-NEXT FIX ======================
const playNextHandler = () => {
    if (!currentPlayer) return;

    const dur = currentPlayer.duration;
    if (!isFinite(dur)) return; // skip if duration unknown

    // Trigger next track if within 0.3s of end
    if (currentPlayer.currentTime + 0.3 >= dur) {
        goToNextTrack("web-ended");
    }
};

currentPlayer.addEventListener("ended", playNextHandler);
currentPlayer.addEventListener("timeupdate", playNextHandler);

// Also update timeline when metadata is loaded
currentPlayer.addEventListener("loadedmetadata", () => {
    if (!isFinite(currentPlayer.duration)) return;
    audioTimeline.max = currentPlayer.duration;
});


    currentPlayer.addEventListener("play", () => {
        syncMiniPlayButton();
        syncFullPlayButton();
    });
    currentPlayer.addEventListener("pause", () => {
        syncMiniPlayButton();
        syncFullPlayButton();
    });

    currentPlayer.play().catch(() => {
        const resume = () => { currentPlayer.play(); 
            document.removeEventListener("click", resume);
            document.removeEventListener("keydown", resume);
        };
        document.addEventListener("click", resume);
        document.addEventListener("keydown", resume);
    });

    // Full player UI update
    if (currentIndex >= 0 && playlist[currentIndex]) {
        fullCover.src = currentThumb || playlist[currentIndex].thumbnail || "/static/video-placeholder.png";
        fullInfo.textContent = playlist[currentIndex].title || "No file playing";
    }
}


// ================= STOP CURRENT TRACK =================
function stopCurrentTrack() {
    if (currentPlayer) {
        currentPlayer.pause();
        currentPlayer.src = "";
        currentPlayer.remove();
        currentPlayer = null;
    }
}



// ================= MINI PLAYER CONTROLS =================
function toggleMiniPlay() {
    if (currentPlayer && !isAndroidPlayer) {
        // Web/desktop audio
        if (currentPlayer.paused) {
            currentPlayer.play().catch(() => {
                // fallback for autoplay restrictions
            }).finally(syncMiniPlayButton);
        } else {
            currentPlayer.pause();
            syncMiniPlayButton();
        }
    } else if (isAndroidPlayer && typeof Android.togglePlayPauseJS !== "undefined") {
        // Android playback
        Android.togglePlayPauseJS();
        // short delay to sync button state
        setTimeout(syncMiniPlayButton, 100);
    } else {
        syncMiniPlayButton();
    }
}


function closeMiniPlayer() {
    if (currentPlayer) currentPlayer.pause();
    else if (typeof Android !== "undefined" && Android.isPlayingJS && Android.togglePlayPauseJS) {
        if (Android.isPlayingJS()) Android.togglePlayPauseJS();
    }
    miniPlayer.style.display = "none";
    currentIndex = -1;
    currentPlayingPath = "";
    updateNowPlayingHighlight();
    loadLibrary();
}

// ================= PLAY NEXT TRACK =================
// ================= SHUFFLE =================
function buildShuffleBag(exclude) {
    shuffleBag = [];
    for (let i = 0; i < playlist.length; i++) if (i !== exclude) shuffleBag.push(i);
    for (let i = shuffleBag.length - 1; i > 0; i--) {   // Fisher–Yates
        const j = Math.floor(Math.random() * (i + 1));
        const t = shuffleBag[i]; shuffleBag[i] = shuffleBag[j]; shuffleBag[j] = t;
    }
}

// Next index: shuffled (each song once per cycle, no immediate repeat) or linear.
function nextIndexAfter(idx) {
    if (playlist.length <= 1) return 0;
    if (shuffle) {
        if (!shuffleBag.length) buildShuffleBag(idx);
        return shuffleBag.length ? shuffleBag.pop() : (idx + 1) % playlist.length;
    }
    return (idx + 1) % playlist.length;
}

function resetShuffleState() {
    shuffleBag = [];
    playHistory = [];
}

function toggleShuffle() {
    shuffle = !shuffle;
    shuffleBag = [];
    if (shuffle) buildShuffleBag(currentIndex);
    syncShuffleButton();
}

function syncShuffleButton() {
    const b = document.getElementById("shuffleBtn");
    if (b) b.classList.toggle("active", shuffle);
}

window.playNextTrack = function(source) {
    console.log("Auto-playing next track. Triggered by:", source);

    if (!playlist || playlist.length === 0) return;

    // Remember where we were so Prev can retrace (esp. in shuffle).
    if (currentIndex >= 0) {
        playHistory.push(currentIndex);
        if (playHistory.length > 300) playHistory.shift();
    }

    // Calculate next index (shuffle-aware)
    currentIndex = nextIndexAfter(currentIndex);
    const track = playlist[currentIndex];

    if (track) {
        // Clean path: remove leading slash if it exists to avoid //
        const cleanPath = track.path.startsWith('/') ? track.path.substring(1) : track.path;
        const fileUrl = `http://127.0.0.1:8000/download/${encodeURIComponent(cleanPath)}`;
        
        // Update UI labels immediately
        miniInfo.textContent = track.title;
        miniCover.src = track.thumbnail || "/static/video-placeholder.png";
        currentPlayingPath = track.path;
        updateNowPlayingHighlight();

        // Call the Android Service to start the new file
        if (typeof Android !== "undefined" && Android.playAudioJS) {
            Android.playAudioJS(fileUrl, track.thumbnail || "");
        } else {
            initAudio(`/download/${cleanPath}`);
        }
        
        updateFullAudioPlayer();
        syncMiniPlayButton();
        console.log("Successfully switched to:", track.title);
    }
};






// ================= PLAY PREV TRACK =================
function playPrevTrack() {
    if (!playlist.length) return;

    if (shuffle && playHistory.length) {
        currentIndex = playHistory.pop();   // go back through what actually played
    } else {
        currentIndex = (currentIndex - 1 + playlist.length) % playlist.length;
    }
    const track = playlist[currentIndex];
    if (!track) return;

    miniInfo.textContent = track.title;
    miniCover.src = track.thumbnail || "/static/video-placeholder.png";
    currentPlayingPath = track.path;
    updateNowPlayingHighlight();

    if (isAndroidPlayer && typeof Android.playAudioJS === "function") {
        const fileUrl = "http://127.0.0.1:8000/download/" + encodeURIComponent(track.path);
        Android.playAudioJS(fileUrl, track.thumbnail || "");
    } else {
        initAudio(`/download/${track.path}`);
    }

    syncMiniPlayButton();
}
 
// ================= FULL PLAYER ELEMENTS =================
const fullAudioPlayer = document.getElementById("fullAudioPlayer");
const fullCover = document.getElementById("fullCover");
const fullInfo = document.getElementById("fullInfo");
const fullPlayPauseBtn = document.getElementById("fullPlayPauseBtn");
const audioTimeline = document.getElementById("audioTimeline");

// #fullTime stays inside .slider-container (positioned by CSS).

// ================= TIME UTILS =================
function formatTime(sec) {
    const minutes = Math.floor(sec / 60);
    const seconds = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds}`;
}

// ================= UPDATE FULL PLAYER =================
function updateFullAudioPlayer() {
    if (currentIndex < 0 || !playlist.length) return;

    const track = playlist[currentIndex];

    fullCover.src = track.thumbnail || "/static/video-placeholder.png";
    fullInfo.textContent = track.title || "No file playing";

    syncFullPlayButton();
    syncShuffleButton();
}

// ================= WEB TIMELINE SYNC =================
function bindWebTimeline() {
    if (!currentPlayer || isAndroidPlayer) return;

    currentPlayer.onloadedmetadata = () => {
        audioTimeline.max = currentPlayer.duration || 0;
    };

    currentPlayer.ontimeupdate = () => {
        if (!isFinite(currentPlayer.duration)) return;

        audioTimeline.value = currentPlayer.currentTime;
        fullTime.textContent =
            formatTime(currentPlayer.currentTime) +
            " / " +
            formatTime(currentPlayer.duration);
    };
}

// ================= SEEK =================
audioTimeline.addEventListener("input", (e) => {
    userIsDragging = true;
    const val = parseFloat(e.target.value);
    const max = parseFloat(e.target.max) || 0;
    // Update text immediately while sliding
    if (fullTime) fullTime.textContent = formatTime(val) + " / " + formatTime(max);
});

audioTimeline.addEventListener("change", (e) => {
    userIsDragging = false;
    const seekTo = parseFloat(e.target.value);
    if (!isAndroidPlayer && currentPlayer) {
        currentPlayer.currentTime = seekTo;
    } else if (isAndroidPlayer && Android?.seekJS) {
        Android.seekJS(seekTo);
    }
});

// ================= PLAY/PAUSE TOGGLE =================
function toggleFullPlay() {
    if (!isAndroidPlayer && currentPlayer) {
        currentPlayer.paused ? currentPlayer.play() : currentPlayer.pause();
        syncFullPlayButton();
        syncMiniPlayButton?.();
    } else if (isAndroidPlayer && Android?.togglePlayPauseJS) {
        Android.togglePlayPauseJS();
        setTimeout(syncFullPlayButton, 100);
        setTimeout(() => syncMiniPlayButton?.(), 100);
    }
}

// ================= OPEN/CLOSE FULL PLAYER =================
miniPlayer.addEventListener("click", e => {
    if (e.target.closest("button")) return;

    fullAudioPlayer.style.display = "flex";
    fullAudioPlayer.style.animation = "popIn 0.25s ease";
    updateFullAudioPlayer();
});

function closeFullAudioPlayer() {
    fullAudioPlayer.style.animation = "popOut 0.25s ease forwards";
    setTimeout(() => {
        fullAudioPlayer.style.display = "none";
    }, 250);
}

// ================= ANDROID TIMELINE SYNC =================
let androidTimelineInterval = null;
let userIsDragging = false; 

// Add helper listeners to stop sync while touching
audioTimeline.addEventListener("mousedown", () => { userIsDragging = true; });
audioTimeline.addEventListener("touchstart", () => { userIsDragging = true; });
audioTimeline.addEventListener("mouseup", () => { userIsDragging = false; });
audioTimeline.addEventListener("touchend", () => { userIsDragging = false; });

function startAndroidTimelineSync() {
    if (androidTimelineInterval) clearInterval(androidTimelineInterval);

    androidTimelineInterval = setInterval(() => {
        // Ensure we are in Android mode and the bridge exists
        if (typeof Android === "undefined" || !isAndroidPlayer || userIsDragging) return;

        try {
            // These now point to the methods we just added to JSBridge in Java
            const pos = Android.getCurrentPositionJS();
            const dur = Android.getDurationJS();

            if (dur > 0) {
                audioTimeline.max = dur;
                audioTimeline.value = pos;
                
                const timeString = formatTime(pos);
                if (fullTime) fullTime.textContent = timeString;
            } else {
                if (fullTime) fullTime.textContent = "0:00";
            }
        } catch (e) {
            console.error("Bridge Sync Error:", e);
        }
    }, 800);
}
startAndroidTimelineSync();

// ================= FULL PLAYER PLAY/PAUSE SYNC =================
function syncFullPlayButton() {
    if (!isAndroidPlayer && currentPlayer) {
        fullPlayPauseBtn.textContent =
            currentPlayer.paused ? "▶" : "❚❚";
    } else if (isAndroidPlayer && Android?.isPlayingJS) {
        fullPlayPauseBtn.textContent =
            Android.isPlayingJS() ? "❚❚" : "▶";
    }
}

// ================= AUTO UPDATE ON TRACK CHANGE =================
const _playAudio = playAudio;
playAudio = function (file, thumb, index) {
    _playAudio(file, thumb, index);

    // Bind timeline only for web
    if (!isAndroidPlayer) bindWebTimeline();

    setTimeout(updateFullAudioPlayer, 50);
};

const _playNextTrack = playNextTrack;
playNextTrack = function () {
    _playNextTrack();
    setTimeout(updateFullAudioPlayer, 50);
};

const _playPrevTrack = playPrevTrack;
playPrevTrack = function () {
    _playPrevTrack();
    setTimeout(updateFullAudioPlayer, 50);
};


// Full-player styling and popIn/popOut keyframes now live in styles.css.















// ================= REMOVE =================
function removeVideo(path) {
    fetch("/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) })
        .then(loadLibrary);
}

 

// ================= DOWNLOAD PROGRESS =================
let progressBar = null;
let progressText = null;

function initProgressOverlay(text) {
    const overlay = document.getElementById("loadingOverlay");
    showOverlay("loadingOverlay", true);

    // Text
    let p = overlay.querySelector("p");
    if (!p) {
        p = document.createElement("p");
        overlay.appendChild(p);
    }
    p.textContent = text;

    // Progress bar
    if (!progressBar) {
        progressBar = document.createElement("div");
        progressBar.className = "progress-bar";
        overlay.appendChild(progressBar);
    }
    if (!progressText) {
        progressText = document.createElement("div");
        progressText.className = "progress-text";
        overlay.appendChild(progressText);
    }

    updateProgress(0);
}

function updateProgress(percent) {
    if (!progressBar || !progressText) return;
    progressBar.style.width = percent + "%";
    progressText.textContent = percent.toFixed(0) + "%";
}

function resetProgress() {
    if (progressBar) progressBar.style.width = "0%";
    if (progressText) progressText.textContent = "";
}

function setOverlayText(text) {
    const overlay = document.getElementById("loadingOverlay");
    const p = overlay.querySelector("p");
    if (p) p.textContent = text;
}

// ================= SOCKET EVENTS =================
socket.on("progress", d => {
    if (!downloadInProgress) return;
    updateProgress(Math.min(d.percent || 0, 99));
});

socket.on("completed", () => finalizeDownload("Downloaded ✓"));

socket.on("error", d => {
    finalizeDownload("Download failed");
    alert(d.error || "Download failed");
});

// ================= FINALIZE DOWNLOAD =================
function finalizeDownload(message) {
    clearTimeout(downloadFallbackTimer);
    downloadInProgress = false;

    updateProgress(100);
    setOverlayText(message);
    loadLibrary(); // refresh library

    // 1. Re-enable the main search button
    const searchBtn = document.getElementById("searchBtn");
    if (searchBtn) {
        searchBtn.disabled = false;
        searchBtn.style.opacity = 1;
        searchBtn.style.cursor = "pointer";
    }

    // 2. Re-enable any specific "Save" buttons in the list
    // We look for any button that was set to "Pending..."
    const allSaveBtns = document.querySelectorAll(".save-btn");
    allSaveBtns.forEach(btn => {
        if (btn.innerHTML === "Pending...") {
            // If the download was successful, mark it as Saved
            if (message.includes("Downloaded")) {
                btn.innerHTML = "Saved ✓";
                btn.style.background = "#28a745"; // Success green
            } else {
                // If it failed, reset it back to Save
                btn.innerHTML = "Save";
                btn.disabled = false;
                btn.style.opacity = 1;
                btn.style.cursor = "pointer";
            }
        }
    });

    // 3. Hide overlay after a short delay
    setTimeout(() => {
        showOverlay("loadingOverlay", false);
        resetProgress();
    }, 1500);
}
// ================= UTILS =================
function showOverlay(id, show) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = show ? "flex" : "none";
}

function updateProgress(percent) {
    if (!progressBar || !progressText) return;
    progressBar.style.width = percent + "%";
    progressText.textContent = percent.toFixed(0) + "%";
}

function resetProgress() {
    if (progressBar) progressBar.style.width = "0%";
    if (progressText) progressText.textContent = "";
}

function setOverlayText(text) {
    const overlay = document.getElementById("loadingOverlay");
    const p = overlay.querySelector("p");
    if (p) p.textContent = text;
}
// ================= MINI PLAYER SYNC =================
function syncMiniPlayButton() {
    if (currentPlayer) {
        playPauseBtn.textContent = currentPlayer.paused ? "▶" : "❚❚";
    } else if (typeof Android !== "undefined" && Android.isPlayingJS) {
        playPauseBtn.textContent = Android.isPlayingJS() ? "❚❚" : "▶";
    }
}


// ================= BACKGROUND POLLING =================
function startBackgroundSync() {
    setInterval(() => { if (typeof Android !== "undefined" && Android.isPlayingJS) syncMiniPlayButton(); }, 2000);
}

// ================= EXPORT / IMPORT =================
let lastExportJSON = "";

function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove("open");
}

// ----- EXPORT -----
function openExport() {
    const modal = document.getElementById("exportModal");
    const info = document.getElementById("exportInfo");
    const text = document.getElementById("exportText");
    const shareBtn = document.getElementById("shareExportBtn");

    // Hide the native "Share file" button when not running inside Android
    if (shareBtn) {
        shareBtn.style.display =
            (typeof Android !== "undefined" && Android.shareLibraryJS) ? "" : "none";
    }

    info.textContent = "Loading…";
    text.value = "";
    modal.classList.add("open");

    fetch("/export_data")
        .then(r => r.json())
        .then(data => {
            const songs = data.songs || [];
            lastExportJSON = JSON.stringify({ songs }, null, 2);
            text.value = lastExportJSON;
            if (!songs.length) {
                info.textContent =
                    "No exportable songs yet. Only songs downloaded with this updated version include a source link.";
            } else {
                info.textContent =
                    `${songs.length} song${songs.length === 1 ? "" : "s"} ready to export.`;
            }
        })
        .catch(err => {
            console.error("Export load failed", err);
            info.textContent = "Could not load library for export.";
        });
}

function copyExport() {
    const text = document.getElementById("exportText");
    if (!text.value) return;
    text.select();
    text.setSelectionRange(0, 999999);
    try {
        // Modern API first, fall back to execCommand for the WebView
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text.value);
        } else {
            document.execCommand("copy");
        }
        alert("Library JSON copied to clipboard");
    } catch (e) {
        document.execCommand("copy");
        alert("Library JSON copied");
    }
}

function shareExport() {
    if (!lastExportJSON) return alert("Nothing to share yet");
    if (typeof Android !== "undefined" && Android.shareLibraryJS) {
        Android.shareLibraryJS(lastExportJSON);
    } else {
        // Web fallback: trigger a normal file download
        window.location = "/export";
    }
}

// ----- IMPORT -----
function openImport() {
    document.getElementById("importText").value = "";
    document.getElementById("importFile").value = "";
    document.getElementById("importProgress").style.display = "none";
    document.getElementById("importProgressBar").style.width = "0%";
    document.getElementById("importProgressText").textContent = "";
    const btn = document.getElementById("startImportBtn");
    btn.disabled = false;
    btn.textContent = "Start Import";
    document.getElementById("importModal").classList.add("open");
}

function loadImportFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        document.getElementById("importText").value = e.target.result || "";
    };
    reader.onerror = () => alert("Could not read that file");
    reader.readAsText(file);
}

function startImport() {
    const raw = document.getElementById("importText").value.trim();
    if (!raw) return alert("Pick a file or paste exported JSON first");

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return alert("That doesn't look like valid JSON");
    }

    // Accept either {songs:[...]} or a bare [...] array
    const songs = Array.isArray(parsed) ? parsed : (parsed.songs || []);
    const valid = songs.filter(s => s && s.url);
    if (!valid.length) return alert("No songs with URLs found in that file");

    const btn = document.getElementById("startImportBtn");
    btn.disabled = true;
    btn.textContent = "Importing…";

    const progress = document.getElementById("importProgress");
    const bar = document.getElementById("importProgressBar");
    const txt = document.getElementById("importProgressText");
    progress.style.display = "flex";
    bar.style.width = "0%";
    txt.textContent = `Starting import of ${valid.length} song(s)…`;

    socket.emit("import_library", { songs: valid });
}

// ----- IMPORT SOCKET EVENTS -----
socket.on("import_started", d => {
    const txt = document.getElementById("importProgressText");
    if (txt) txt.textContent = `Importing 0 / ${d.total}…`;
});

socket.on("import_progress", d => {
    const bar = document.getElementById("importProgressBar");
    const txt = document.getElementById("importProgressText");
    if (!bar || !txt) return;

    const overall = d.total ? (d.current - 1 + (d.percent || 0) / 100) / d.total : 0;
    bar.style.width = Math.min(overall * 100, 100).toFixed(0) + "%";

    let label = `${d.current} / ${d.total}`;
    if (d.status === "skipped") label += " — already saved";
    else if (d.status === "failed") label += " — failed";
    else label += ` — ${d.percent || 0}%`;
    txt.textContent = `${label}: ${d.title || ""}`;
});

socket.on("import_done", d => {
    const bar = document.getElementById("importProgressBar");
    const txt = document.getElementById("importProgressText");
    const btn = document.getElementById("startImportBtn");
    if (bar) bar.style.width = "100%";
    if (txt) {
        txt.textContent =
            `Done — ${d.added} added, ${d.skipped} skipped, ${d.failed} failed`;
    }
    if (btn) {
        btn.disabled = false;
        btn.textContent = "Start Import";
    }
    loadLibrary();
});

// ================= PLAYLISTS =================
let allPlaylists = [];
let currentPlaylistSongs = [];
let currentPlaylistId = null;
let currentPlaylistName = "";
let addTargetPath = null;

function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function loadPlaylists() {
    return fetch("/playlists")
        .then(r => r.json())
        .then(data => {
            allPlaylists = data.playlists || [];
            renderPlaylists();
            return allPlaylists;
        })
        .catch(err => console.warn("Playlist load failed", err));
}

function renderPlaylists() {
    const container = document.getElementById("playlistList");
    if (!container) return;

    if (!allPlaylists.length) {
        container.innerHTML =
            `<div class="playlist-empty">No playlists yet. Tap “+ New” to create one,
             then add songs from your Library with the ＋ button.</div>`;
        return;
    }

    container.innerHTML = "";
    allPlaylists.forEach(p => {
        const cover = (p.songs[0] && p.songs[0].thumbnail) || "/static/video-placeholder.png";
        const div = document.createElement("div");
        div.className = "playlist-card";
        div.onclick = () => openPlaylist(p.id);
        div.innerHTML = `
            <img class="pl-cover" loading="lazy" decoding="async" src="${cover}" onerror="this.src='/static/video-placeholder.png';">
            <div class="pl-meta">
                <div class="pl-name">${escapeHtml(p.name)}</div>
                <div class="pl-count">${p.count} song${p.count === 1 ? "" : "s"}</div>
            </div>
        `;
        container.appendChild(div);
    });
}

function openPlaylist(id) {
    const p = allPlaylists.find(x => x.id === id);
    if (!p) return;

    currentPlaylistId = id;
    currentPlaylistName = p.name;
    currentPlaylistSongs = p.songs || [];

    document.getElementById("playlistOverview").style.display = "none";
    document.getElementById("playlistDetail").style.display = "block";
    document.getElementById("playlistDetailName").textContent = p.name;

    renderPlaylistSongs();
}

function renderPlaylistSongs() {
    const container = document.getElementById("playlistDetailSongs");
    if (!container) return;

    if (!currentPlaylistSongs.length) {
        container.innerHTML =
            `<div class="playlist-empty">This playlist is empty. Add songs from your
             Library using the ＋ button.</div>`;
        return;
    }

    container.innerHTML = "";
    currentPlaylistSongs.forEach((v, i) => {
        const div = document.createElement("div");
        div.className = "list-item";
        div.dataset.path = v.path;
        if (v.path && v.path === currentPlayingPath) div.classList.add("active");
        div.innerHTML = `
            <img loading="lazy" decoding="async" src="${v.thumbnail || '/static/video-placeholder.png'}"
                 onerror="this.src='/static/video-placeholder.png';">
            <span class="item-info">${escapeHtml(v.title)}</span>
            <button class="icon-btn play-btn" onclick="playPlaylistSong(${i})">▶</button>
            <button class="icon-btn del-btn" onclick="removeFromPlaylist(${i})">✕</button>
        `;
        container.appendChild(div);
    });
}

function closePlaylistDetail() {
    document.getElementById("playlistDetail").style.display = "none";
    document.getElementById("playlistOverview").style.display = "block";
    currentPlaylistId = null;
    loadPlaylists();
}

function playPlaylistSong(index) {
    if (!currentPlaylistSongs.length) return;

    // Playing from a playlist: the play queue IS this playlist.
    playlist = currentPlaylistSongs;
    resetShuffleState();

    const track = playlist[index];
    if (!track) return;

    const cleanPath = track.path.startsWith('/') ? track.path.substring(1) : track.path;
    playAudio(`/download/${encodeURIComponent(cleanPath)}`, track.thumbnail, index);
}

// ----- Reusable in-app dialogs (match the app style) -----
function tbPrompt(title, defaultValue, placeholder, onOk) {
    const modal = document.getElementById("inputModal");
    const field = document.getElementById("inputModalField");
    const okBtn = document.getElementById("inputModalOk");

    document.getElementById("inputModalTitle").textContent = title;
    field.value = defaultValue || "";
    field.placeholder = placeholder || "";

    const submit = () => {
        const val = field.value.trim();
        if (!val) { field.focus(); return; }
        closeModal("inputModal");
        onOk(val);
    };
    okBtn.onclick = submit;
    field.onkeydown = (e) => { if (e.key === "Enter") submit(); };

    modal.classList.add("open");
    setTimeout(() => { field.focus(); field.select(); }, 60);
}

function tbConfirm(title, message, okLabel, onOk) {
    document.getElementById("confirmModalTitle").textContent = title;
    document.getElementById("confirmModalMsg").textContent = message;
    const ok = document.getElementById("confirmModalOk");
    ok.textContent = okLabel || "Confirm";
    ok.onclick = () => { closeModal("confirmModal"); onOk(); };
    document.getElementById("confirmModal").classList.add("open");
}

function createPlaylistPrompt() {
    tbPrompt("New playlist", "", "Playlist name", (name) => {
        fetch("/playlists/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name })
        }).then(r => r.json()).then(() => loadPlaylists());
    });
}

function renameCurrentPlaylist() {
    if (!currentPlaylistId) return;
    tbPrompt("Rename playlist", currentPlaylistName, "Playlist name", (name) => {
        fetch("/playlists/rename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: currentPlaylistId, name })
        }).then(r => r.json()).then(() => {
            currentPlaylistName = name;
            document.getElementById("playlistDetailName").textContent = name;
        });
    });
}

function deleteCurrentPlaylist() {
    if (!currentPlaylistId) return;
    tbConfirm("Delete playlist", "Delete this playlist? Your songs stay in the Library.", "Delete", () => {
        fetch("/playlists/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: currentPlaylistId })
        }).then(r => r.json()).then(() => closePlaylistDetail());
    });
}

function removeFromPlaylist(index) {
    const track = currentPlaylistSongs[index];
    if (!track || !currentPlaylistId) return;
    tbConfirm(
        "Remove from playlist",
        `Remove “${track.title}” from this playlist? It stays in your Library.`,
        "Remove",
        () => {
            fetch("/playlists/remove", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: currentPlaylistId, path: track.path })
            }).then(r => r.json()).then(() => {
                currentPlaylistSongs.splice(index, 1);
                renderPlaylistSongs();
            });
        }
    );
}

// ----- ADD TO PLAYLIST (from the Library) -----
function openAddToPlaylist(masterIndex) {
    const track = originalLibrary[masterIndex];
    if (!track) return;

    addTargetPath = track.path;
    document.getElementById("addToPlaylistSong").textContent = track.title;
    document.getElementById("newPlaylistInline").value = "";
    document.getElementById("addToPlaylistModal").classList.add("open");

    // Load fresh playlist data so membership checkmarks are accurate
    fetch("/playlists").then(r => r.json()).then(data => {
        allPlaylists = data.playlists || [];
        renderAddToPlaylistOptions();
    });
}

function renderAddToPlaylistOptions() {
    const box = document.getElementById("addToPlaylistOptions");
    if (!box) return;

    if (!allPlaylists.length) {
        box.innerHTML = `<div class="tb-modal-sub">No playlists yet — create one below.</div>`;
        return;
    }

    box.innerHTML = "";
    allPlaylists.forEach(p => {
        const inIt = p.songs.some(s => s.path === addTargetPath);
        const opt = document.createElement("div");
        opt.className = "tb-pl-option" + (inIt ? " checked" : "");
        opt.onclick = () => toggleSongInPlaylist(p.id, inIt);
        opt.innerHTML = `
            <div class="pl-check">${inIt ? "✓" : ""}</div>
            <div>${escapeHtml(p.name)}</div>
        `;
        box.appendChild(opt);
    });
}

// Update just one song's tag chips in place (avoids re-fetching + re-rendering
// the entire library after a playlist toggle).
function updateRowTagsForPath(path) {
    const tags = allPlaylists
        .filter(p => (p.songs || []).some(s => (s.path || s) === path))
        .map(p => ({ id: p.id, name: p.name }));

    // Keep the master library data in sync for future full re-renders.
    const song = originalLibrary.find(s => s.path === path);
    if (song) song.playlists = tags;

    const html = tags.map(t => `<span class="song-tag">${escapeHtml(t.name)}</span>`).join("");
    document.querySelectorAll(".list-item").forEach(el => {
        if (el.dataset && el.dataset.path === path) {
            const box = el.querySelector(".song-tags");
            if (box) box.innerHTML = html;
        }
    });
}

function toggleSongInPlaylist(id, currentlyIn) {
    const endpoint = currentlyIn ? "/playlists/remove" : "/playlists/add";
    fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, path: addTargetPath })
    }).then(r => r.json()).then(() => {
        const p = allPlaylists.find(x => x.id === id);
        if (p) {
            if (currentlyIn) {
                p.songs = p.songs.filter(s => s.path !== addTargetPath);
            } else {
                p.songs.push({ path: addTargetPath });
            }
        }
        renderAddToPlaylistOptions();
        updateRowTagsForPath(addTargetPath); // patch just this row's tags
    });
}

function createPlaylistInline() {
    const input = document.getElementById("newPlaylistInline");
    const name = input.value.trim();
    if (!name) return;

    fetch("/playlists/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
    }).then(r => r.json()).then(res => {
        input.value = "";
        // If a song is targeted, drop it straight into the new playlist
        if (res.id && addTargetPath) {
            return fetch("/playlists/add", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: res.id, path: addTargetPath })
            });
        }
    }).then(() => {
        return fetch("/playlists").then(r => r.json());
    }).then(data => {
        if (data) allPlaylists = data.playlists || [];
        renderAddToPlaylistOptions();
        if (addTargetPath) updateRowTagsForPath(addTargetPath);
    });
}

// ================= INIT =================
loadLibrary();
startBackgroundSync();
