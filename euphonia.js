let currentUser = null;
let userLikedIds = new Set();
let currentAIPlaylist = [];
let catalogTracks = [];
let currentPlaylistQueue = [];
let currentTrackIndex = -1;
let currentPlayingTrack = null;
let isAudioLooping = false;
let authMode = "login";
let searchDebounceTimer = null;

const trackRegistry = {};

document.addEventListener("DOMContentLoaded", () => {
    const savedTheme = localStorage.getItem("euphonia_theme");
    if (savedTheme === "night") {
        document.body.className = "night-theme";
        const btn = document.getElementById("themeBtn");
        if (btn) btn.innerHTML = '<i class="fa-solid fa-sun"></i> Day Mode';
    }

    const savedUser = localStorage.getItem("euphonia_user_session");
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
            renderUserSession();
        } catch (e) {
            currentUser = null;
        }
    }

    setupAudioPlayerListeners();

    const aiForm = document.getElementById("aiPlaylistForm");
    if (aiForm) {
        aiForm.addEventListener("submit", handleGeneratePlaylist);
    }

    document.addEventListener("click", (e) => {
        const container = document.getElementById("authLoggedIn");
        const dropdown = document.getElementById("profileDropdown");
        if (dropdown && container && !container.contains(e.target)) {
            dropdown.style.display = "none";
        }
    });

    fetchCatalog();
    fetchUserLikes();
    initGoogleAuthSDK();
});

// =========================================================
// SPA VIEWS ROUTER
// =========================================================
function switchView(viewName) {
    document.querySelectorAll(".app-view").forEach(el => el.classList.remove("active-view"));
    document.querySelectorAll(".nav-link").forEach(el => el.classList.remove("active"));

    if (viewName === "home") {
        document.getElementById("viewHome").classList.add("active-view");
        document.getElementById("navHome").classList.add("active");
    } else if (viewName === "explore") {
        document.getElementById("viewExplore").classList.add("active-view");
        document.getElementById("navExplore").classList.add("active");
        const searchInput = document.getElementById("exploreSearchInput");
        if (searchInput && searchInput.value.trim()) {
            performLiveSearch(searchInput.value.trim());
        } else {
            renderTrackCards(catalogTracks, document.getElementById("browseGrid"));
        }
    } else if (viewName === "liked") {
        document.getElementById("viewLiked").classList.add("active-view");
        document.getElementById("navLiked").classList.add("active");
        fetchUserLikes();
    } else if (viewName === "about") {
        document.getElementById("viewAbout").classList.add("active-view");
        document.getElementById("navAbout").classList.add("active");
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
}

// =========================================================
// LIVE SEARCH & CATALOG
// =========================================================
async function fetchCatalog() {
    try {
        const res = await fetch("/api/catalog");
        if (!res.ok) throw new Error(await extractErrorMessage(res));
        const data = await res.json();
        catalogTracks = data.catalog || [];
        catalogTracks.forEach(t => { trackRegistry[t.id] = t; });
        renderTrackCards(catalogTracks, document.getElementById("browseGrid"));
    } catch (e) {
        console.error("Catalog fetch error:", e);
    }
}

function handleSearchInput(term) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
        performLiveSearch(term);
    }, 350);
}

async function performLiveSearch(term) {
    const q = term.trim();
    const container = document.getElementById("browseGrid");
    if (!container) return;

    if (!q) {
        renderTrackCards(catalogTracks, container);
        return;
    }

    container.innerHTML = `<div class="loader"><i class="fa-solid fa-spinner fa-spin"></i> Searching songs for "${escapeHtml(q)}"...</div>`;

    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error("Search failed");
        const data = await res.json();
        const results = data.results || [];

        if (results.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; width: 100%; padding: 40px; color: var(--text-sub);">
                    <i class="fa-solid fa-magnifying-glass" style="font-size: 2rem; margin-bottom: 12px; opacity: 0.5;"></i>
                    <p>No songs found for "<strong>${escapeHtml(q)}</strong>". Try an artist or song name.</p>
                </div>`;
            return;
        }

        results.forEach(t => { trackRegistry[t.id] = t; });
        renderTrackCards(results, container);
    } catch (e) {
        console.error("Search error:", e);
        container.innerHTML = `<p class="empty-state">Failed to perform search. Please check your network connection.</p>`;
    }
}

function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderTrackCards(tracks, targetElement) {
    if (!targetElement) return;
    targetElement.innerHTML = "";

    if (!tracks || tracks.length === 0) {
        targetElement.innerHTML = "<p class='empty-state'>No tracks to display.</p>";
        return;
    }

    tracks.forEach(track => {
        trackRegistry[track.id] = track;
        const isLiked = userLikedIds.has(track.id);
        const card = document.createElement("div");
        card.className = "card";
        card.dataset.id = track.id;

        const safeTitle = (track.title || "").replace(/'/g, "\\'");
        const safeArtist = (track.artist || "").replace(/'/g, "\\'");
        const coverImg = track.image || "img/1.png";

        card.innerHTML = `
            <div class="thumbnail">
                <img src="${coverImg}" alt="${escapeHtml(track.title)}" loading="lazy">
            </div>
            <div class="song"><p title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</p></div>
            <div class="artist"><p title="${escapeHtml(track.artist)}">${escapeHtml(track.artist)}</p></div>
            <div class="card-actions">
                <button class="btn-card-action" onclick="playAudioTrack(trackRegistry['${track.id}'], currentPlaylistQueue)">
                    <i class="fa-solid fa-play"></i> Play
                </button>
                <button class="btn-card-action" onclick="openLyrics('${safeTitle}', '${safeArtist}')">
                    <i class="fa-solid fa-align-left"></i> Lyrics
                </button>
                <button class="btn-card-action btn-card-like ${isLiked ? 'liked' : ''}" onclick="toggleLike('${track.id}')" title="Like track">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="${isLiked ? '#ff4d6d' : 'none'}" stroke="${isLiked ? '#ff4d6d' : 'currentColor'}" stroke-width="2">
                        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                    </svg>
                </button>
            </div>
        `;
        targetElement.appendChild(card);
    });
}

// =========================================================
// AUDIO PLAYER ENGINE
// =========================================================
function setupAudioPlayerListeners() {
    const audio = document.getElementById("audioElement");
    const playSvg = document.getElementById("playIconSvg");
    const pauseSvg = document.getElementById("pauseIconSvg");
    const seeker = document.getElementById("deckSeeker");
    const curTime = document.getElementById("deckCurrentTime");
    const durTime = document.getElementById("deckDuration");

    audio.addEventListener("timeupdate", () => {
        if (!audio.duration) return;
        const percent = (audio.currentTime / audio.duration) * 100;
        seeker.value = percent;
        curTime.innerText = formatTime(audio.currentTime);
        durTime.innerText = formatTime(audio.duration);
    });

    audio.addEventListener("play", () => {
        playSvg.style.display = "none";
        pauseSvg.style.display = "block";
    });

    audio.addEventListener("pause", () => {
        playSvg.style.display = "block";
        pauseSvg.style.display = "none";
    });

    audio.addEventListener("ended", () => {
        if (!isAudioLooping) playNextTrack();
    });
}

function playAudioTrack(track, queueList = null) {
    if (queueList && queueList.length) {
        currentPlaylistQueue = queueList;
        currentTrackIndex = currentPlaylistQueue.findIndex(t => t.id === track.id);
    }

    currentPlayingTrack = track;
    const playerDeck = document.getElementById("playerDeck");
    const audio = document.getElementById("audioElement");

    playerDeck.style.display = "flex";
    document.getElementById("deckTitle").innerText = track.title;
    document.getElementById("deckArtist").innerText = track.artist;
    document.getElementById("deckCover").src = track.image;

    const isLiked = userLikedIds.has(track.id);
    const likeBtn = document.getElementById("deckLikeBtn");
    const heartSvg = document.getElementById("deckHeartIcon");
    likeBtn.className = `deck-btn-icon ${isLiked ? 'active' : ''}`;
    heartSvg.setAttribute("fill", isLiked ? "#ff4d6d" : "none");
    heartSvg.setAttribute("stroke", isLiked ? "#ff4d6d" : "currentColor");

    if (track.preview_url) {
        audio.src = track.preview_url;
        audio.play().catch(e => console.log("Playback interrupted:", e));
    } else {
        audio.src = "";
        alert(`Preview stream is unavailable for "${track.title}".`);
    }
}

function togglePlayPause() {
    const audio = document.getElementById("audioElement");
    if (audio.paused) audio.play();
    else audio.pause();
}

function seekAudio(value) {
    const audio = document.getElementById("audioElement");
    if (audio.duration) audio.currentTime = (value / 100) * audio.duration;
}

function changeVolume(val) {
    const audio = document.getElementById("audioElement");
    audio.volume = parseFloat(val);
}

function toggleMute() {
    const audio = document.getElementById("audioElement");
    audio.muted = !audio.muted;
}

function toggleLoop() {
    isAudioLooping = !isAudioLooping;
    document.getElementById("audioElement").loop = isAudioLooping;
    document.getElementById("deckLoopBtn").classList.toggle("active", isAudioLooping);
}

function playNextTrack() {
    if (!currentPlaylistQueue.length) return;
    currentTrackIndex = (currentTrackIndex + 1) % currentPlaylistQueue.length;
    playAudioTrack(currentPlaylistQueue[currentTrackIndex]);
}

function playPrevTrack() {
    if (!currentPlaylistQueue.length) return;
    currentTrackIndex = (currentTrackIndex - 1 + currentPlaylistQueue.length) % currentPlaylistQueue.length;
    playAudioTrack(currentPlaylistQueue[currentTrackIndex]);
}

function closePlayer() {
    document.getElementById("audioElement").pause();
    document.getElementById("playerDeck").style.display = "none";
}

function formatTime(seconds) {
    if (isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// =========================================================
// AI PLAYLIST GENERATOR
// =========================================================
async function handleGeneratePlaylist(e) {
    e.preventDefault();
    const mood = document.getElementById("moodInput").value;
    const genre = document.getElementById("genreSelect").value;
    const language = document.getElementById("langSelect").value;
    const loader = document.getElementById("aiLoading");
    const container = document.getElementById("aiPlaylistResults");
    const heading = document.getElementById("playlistHeading");
    const resultHeader = document.getElementById("aiResultHeader");

    loader.style.display = "block";
    container.innerHTML = "";
    heading.innerText = "";
    if (resultHeader) resultHeader.style.display = "none";

    try {
        const response = await fetch("/api/generate-playlist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mood, genre, language })
        });

        if (!response.ok) {
            throw new Error(await extractErrorMessage(response));
        }

        const data = await response.json();
        currentAIPlaylist = data.tracks || [];
        currentAIPlaylist.forEach(t => { trackRegistry[t.id] = t; });

        heading.innerText = `Playlist: ${data.playlist_name}`;
        if (resultHeader) resultHeader.style.display = "flex";
        renderTrackCards(currentAIPlaylist, container);
    } catch (err) {
        console.error("AI Error:", err);
        alert(`AI Generation Error: ${err.message}`);
    } finally {
        loader.style.display = "none";
    }
}

async function addAllAIToLiked() {
    if (!currentUser) {
        openAuthModal("login");
        return;
    }
    if (!currentAIPlaylist.length) return;

    const payload = currentAIPlaylist.map(t => ({
        user_id: currentUser.user_id,
        song_id: t.id,
        title: t.title,
        artist: t.artist,
        image: t.image,
        preview_url: t.preview_url
    }));

    try {
        const res = await fetch("/api/like-batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id: currentUser.user_id, tracks: payload })
        });

        if (!res.ok) throw new Error(await extractErrorMessage(res));

        const data = await res.json();
        userLikedIds = new Set(data.liked_ids);

        syncAllLikeButtons();
        fetchUserLikes();

        const btn = document.getElementById("addAllLikedBtn");
        if (btn) {
            btn.innerHTML = `<i class="fa-solid fa-check"></i> Added All to Liked!`;
            setTimeout(() => {
                btn.innerHTML = `
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 4px;">
                        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                    </svg>
                    Save All to Liked Songs
                `;
            }, 2200);
        }
    } catch (e) {
        console.error("Batch like error:", e);
        alert(e.message);
    }
}

// =========================================================
// LIKED SONGS & LIBRARY VIEW
// =========================================================
async function toggleLike(songId) {
    if (!currentUser) {
        openAuthModal("login");
        return;
    }

    const track = trackRegistry[songId] || { id: songId, title: "Unknown", artist: "Unknown", image: "" };

    try {
        const response = await fetch("/api/like", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                user_id: currentUser.user_id,
                song_id: songId,
                title: track.title,
                artist: track.artist,
                image: track.image,
                preview_url: track.preview_url
            })
        });

        if (!response.ok) throw new Error(await extractErrorMessage(response));

        const data = await response.json();
        userLikedIds = new Set(data.liked_ids);

        syncAllLikeButtons();
        fetchUserLikes();

        if (currentPlayingTrack && currentPlayingTrack.id === songId) {
            const likeBtn = document.getElementById("deckLikeBtn");
            const heartSvg = document.getElementById("deckHeartIcon");
            const isNowLiked = userLikedIds.has(songId);
            likeBtn.className = `deck-btn-icon ${isNowLiked ? 'active' : ''}`;
            heartSvg.setAttribute("fill", isNowLiked ? "#ff4d6d" : "none");
            heartSvg.setAttribute("stroke", isNowLiked ? "#ff4d6d" : "currentColor");
        }
    } catch (e) {
        console.error("Like error:", e);
    }
}

function toggleCurrentPlayingLike() {
    if (currentPlayingTrack) toggleLike(currentPlayingTrack.id);
}

function syncAllLikeButtons() {
    document.querySelectorAll(".card").forEach(card => {
        const sid = card.dataset.id;
        const btn = card.querySelector(".btn-card-like");
        if (btn) {
            const isLiked = userLikedIds.has(sid);
            btn.className = `btn-card-action btn-card-like ${isLiked ? 'liked' : ''}`;
            const svg = btn.querySelector("svg");
            if (svg) {
                svg.setAttribute("fill", isLiked ? "#ff4d6d" : "none");
                svg.setAttribute("stroke", isLiked ? "#ff4d6d" : "currentColor");
            }
        }
    });

    const badge = document.getElementById("likedCountBadge");
    if (badge) badge.innerText = userLikedIds.size;
    const navBadge = document.getElementById("navLikedCount");
    if (navBadge) navBadge.innerText = userLikedIds.size;
    const textCount = document.getElementById("likedCountText");
    if (textCount) textCount.innerText = `${userLikedIds.size} songs`;
}

async function fetchUserLikes() {
    const container = document.getElementById("likedSongsResults");
    if (!container) return;

    if (!currentUser) {
        container.innerHTML = "<p class='empty-state'>Log in to view and save your liked songs library.</p>";
        userLikedIds.clear();
        syncAllLikeButtons();
        return;
    }

    try {
        const res = await fetch(`/api/liked-songs/${currentUser.user_id}`);
        if (!res.ok) throw new Error(await extractErrorMessage(res));

        const data = await res.json();
        userLikedIds = new Set(data.liked_songs.map(s => s.id));
        data.liked_songs.forEach(t => { trackRegistry[t.id] = t; });
        renderTrackCards(data.liked_songs, container);
        syncAllLikeButtons();
    } catch (e) {
        console.error("Fetch likes error:", e);
    }
}

function playAllLiked() {
    const likedTracks = Array.from(userLikedIds).map(id => trackRegistry[id]).filter(Boolean);
    if (likedTracks.length) {
        playAudioTrack(likedTracks[0], likedTracks);
    }
}

// =========================================================
// LYRICS MODAL
// =========================================================
async function openLyrics(title, artist) {
    const modal = document.getElementById("lyricsModal");
    const mTitle = document.getElementById("lyricsTitle");
    const mArtist = document.getElementById("lyricsArtist");
    const mBody = document.getElementById("lyricsBody");

    mTitle.innerText = title;
    mArtist.innerText = artist;
    mBody.innerHTML = `<div class="loader"><i class="fa-solid fa-spinner fa-spin"></i> Fetching lyrics from AI...</div>`;
    modal.style.display = "flex";

    try {
        const res = await fetch("/api/lyrics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, artist })
        });
        if (!res.ok) throw new Error(await extractErrorMessage(res));
        const data = await res.json();
        mBody.innerText = data.lyrics || "No lyrics found.";
    } catch (e) {
        mBody.innerText = "Lyrics currently unavailable.";
    }
}

function closeLyrics() { 
    document.getElementById("lyricsModal").style.display = "none"; 
}

function openCurrentPlayerLyrics() { 
    if (currentPlayingTrack) openLyrics(currentPlayingTrack.title, currentPlayingTrack.artist); 
}

// =========================================================
// OFFICIAL GOOGLE SIGN-IN SDK & AUTH
// =========================================================
function initGoogleAuthSDK() {
    if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.initialize({
            client_id: "674408550081-1v02esgg0tbff47fmaanh29qhfcoi9p8.apps.googleusercontent.com", // Replace with your production Google Client ID
            callback: handleGoogleAuthCallback,
            auto_select: false,
            cancel_on_tap_outside: true
        });

        const target = document.getElementById("googleBtnContainer");
        if (target) {
            google.accounts.id.renderButton(target, {
                type: "standard",
                theme: "outline",
                size: "large",
                text: "continue_with",
                shape: "pill",
                width: 280
            });
        }
    } else {
        setTimeout(initGoogleAuthSDK, 400);
    }
}

async function handleGoogleAuthCallback(response) {
    try {
        const res = await fetch("/api/auth/google-verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ credential: response.credential })
        });

        if (!res.ok) throw new Error(await extractErrorMessage(res));

        const data = await res.json();
        currentUser = data;
        localStorage.setItem("euphonia_user_session", JSON.stringify(currentUser));
        renderUserSession();
        closeAuthModal();
        fetchUserLikes();
    } catch (err) {
        alert("Google Sign-In Error: " + err.message);
    }
}

function openAuthModal(mode) {
    authMode = mode;
    const modal = document.getElementById("authModal");
    const title = document.getElementById("authTitle");
    const sub = document.getElementById("authSubtitle");
    const signupFields = document.getElementById("signupFields");
    const submitBtn = document.getElementById("authSubmitBtn");
    const authIdLabel = document.getElementById("authIdLabel");
    const prompt = document.getElementById("authSwitchPrompt");
    const link = document.getElementById("authSwitchLink");
    const errBox = document.getElementById("authErrorMsg");

    errBox.style.display = "none";

    if (authMode === "signup") {
        title.innerText = "Create Your Account";
        sub.innerText = "Sign up with Google or your email to save your library.";
        signupFields.style.display = "block";
        authIdLabel.innerText = "Email Address";
        submitBtn.innerText = "Sign Up";
        prompt.innerText = "Already have an account?";
        link.innerText = "Log in";
    } else {
        title.innerText = "Welcome Back to Euphonia";
        sub.innerText = "Log in with your Google account or credentials.";
        signupFields.style.display = "none";
        authIdLabel.innerText = "Username or Email";
        submitBtn.innerText = "Log In";
        prompt.innerText = "Don't have an account?";
        link.innerText = "Sign up";
    }
    modal.style.display = "flex";
}

function closeAuthModal() {
    document.getElementById("authModal").style.display = "none";
}

function toggleAuthMode() {
    openAuthModal(authMode === "login" ? "signup" : "login");
}

async function handleAuthSubmit(e) {
    e.preventDefault();
    const errBox = document.getElementById("authErrorMsg");
    errBox.style.display = "none";

    if (authMode === "signup") {
        const name = document.getElementById("authName").value.trim();
        const username = document.getElementById("authUsername").value.trim();
        const email = document.getElementById("authEmail").value.trim();
        const password = document.getElementById("authPassword").value;

        try {
            const res = await fetch("/api/auth/register-simple", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, username, email, password })
            });

            if (!res.ok) throw new Error(await extractErrorMessage(res));

            const data = await res.json();
            currentUser = data;
            localStorage.setItem("euphonia_user_session", JSON.stringify(currentUser));
            renderUserSession();
            closeAuthModal();
            fetchUserLikes();
        } catch (err) {
            errBox.innerText = err.message;
            errBox.style.display = "block";
        }
    } else {
        const login_id = document.getElementById("authEmail").value.trim();
        const password = document.getElementById("authPassword").value;

        try {
            const res = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ login_id, password })
            });

            if (!res.ok) throw new Error(await extractErrorMessage(res));

            const data = await res.json();
            currentUser = data;
            localStorage.setItem("euphonia_user_session", JSON.stringify(currentUser));
            renderUserSession();
            closeAuthModal();
            fetchUserLikes();
        } catch (err) {
            errBox.innerText = err.message;
            errBox.style.display = "block";
        }
    }
}

function renderUserSession() {
    if (!currentUser) return;
    document.getElementById("authLoggedOut").style.display = "none";
    const loggedInView = document.getElementById("authLoggedIn");
    loggedInView.style.display = "flex";

    document.getElementById("userName").innerText = currentUser.name;
    document.getElementById("userAvatar").src = currentUser.avatar;
    document.getElementById("dropdownName").innerText = currentUser.name;
    document.getElementById("dropdownUsername").innerText = `@${currentUser.username || 'user'}`;
    document.getElementById("dropdownAvatar").src = currentUser.avatar;
    document.getElementById("likedOwnerName").innerText = `${currentUser.name}'s`;
}

function logoutUser() {
    currentUser = null;
    userLikedIds.clear();
    localStorage.removeItem("euphonia_user_session");
    closeProfileDropdown();
    document.getElementById("authLoggedOut").style.display = "flex";
    document.getElementById("authLoggedIn").style.display = "none";
    document.getElementById("likedOwnerName").innerText = "Your";
    syncAllLikeButtons();
    switchView("home");
}

function toggleProfileDropdown() {
    const dropdown = document.getElementById("profileDropdown");
    dropdown.style.display = dropdown.style.display === "none" ? "block" : "none";
}

function closeProfileDropdown() {
    const dropdown = document.getElementById("profileDropdown");
    if (dropdown) dropdown.style.display = "none";
}

function toggleTheme() {
    if (document.body.classList.contains("night-theme")) {
        document.body.className = "day-theme";
        localStorage.setItem("euphonia_theme", "day");
        document.getElementById("themeBtn").innerHTML = '<i class="fa-solid fa-moon"></i> Night Mode';
    } else {
        document.body.className = "night-theme";
        localStorage.setItem("euphonia_theme", "night");
        document.getElementById("themeBtn").innerHTML = '<i class="fa-solid fa-sun"></i> Day Mode';
    }
}

async function extractErrorMessage(response) {
    const rawText = await response.text();
    try {
        const errJson = JSON.parse(rawText);
        return errJson.detail || `Server error (${response.status})`;
    } catch {
        return rawText || `Server returned error ${response.status}`;
    }
}
