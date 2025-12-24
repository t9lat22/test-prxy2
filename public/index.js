"use strict";

/* ===== ELEMENTS ===== */
const navForm = document.getElementById("nav-form");
const navInput = document.getElementById("nav-input");
const home = document.getElementById("home");
const backBtn = document.getElementById("backBtn");
const forwardBtn = document.getElementById("forwardBtn");
const refreshBtn = document.getElementById("refreshBtn");

const error = document.getElementById("sj-error");
const errorCode = document.getElementById("sj-error-code");

/* ===== SCRAMJET SETUP ===== */
const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
  files: {
    wasm: "/scram/scramjet.wasm.wasm",
    all: "/scram/scramjet.all.js",
    sync: "/scram/scramjet.sync.js",
  },
});

scramjet.init();

const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

/* ===== STATE ===== */
let frame = null;
let lastKnownLocation = "";
let pollHandle = null;

/* ===== HISTORY STATE (single-tab) ===== */
let historyStack = [];
let historyIndex = -1;
let lastPushedUrl = null;

/* ===== CONFIG ===== */
const POLL_INTERVAL_MS = 1000; // adjust if needed
const FALLBACK_SEARCH = "https://www.google.com/search?q=%s";

/* ===== HELPERS ===== */
function ensureProtocol(u) {
  if (!u) return u;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) return u;
  return "https://" + u;
}

function isLikelyHost(input) {
  return (
    /\./.test(input) && !/\s/.test(input) && !/^\d+(\.\d+){1,}$/.test(input)
  );
}

function buildSearchUrl(q) {
  try {
    if (typeof search === "function") {
      const s = search(q);
      if (typeof s === "string" && s) return s;
    }
  } catch (e) {}
  return FALLBACK_SEARCH.replace("%s", encodeURIComponent(q));
}

function normalizeInputToUrl(input) {
  input = (input || "").trim();
  if (!input) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) return input;
  if (isLikelyHost(input)) return ensureProtocol(input);
  return buildSearchUrl(input);
}

/* ===== NEW: unwrap proxied URL into original target URL ===== */
function unwrapProxiedUrl(maybeProxied) {
  if (!maybeProxied || typeof maybeProxied !== "string") return maybeProxied;

  try {
    const parsed = new URL(maybeProxied);
    if (/^https?:$/.test(parsed.protocol)) {
      const decodedCandidate = findAndDecodeEncodedUrl(maybeProxied);
      if (decodedCandidate) return decodedCandidate;
      return maybeProxied;
    }
  } catch (e) {}

  const encodedMatch = maybeProxied.match(/https%3A%2F%2F[^&?#)]+/i);
  if (encodedMatch && encodedMatch[0]) {
    try {
      const decoded = decodeURIComponent(encodedMatch[0]);
      if (/^https?:\/\//.test(decoded)) return decoded;
    } catch (e) {}
  }

  const pathSegmentMatch = maybeProxied.match(
    /\/(scram|scramjet|s|proxy)\/([^?#/].+)$/i
  );
  if (pathSegmentMatch && pathSegmentMatch[2]) {
    try {
      const candidate = decodeURIComponent(pathSegmentMatch[2]);
      if (/^https?:\/\//.test(candidate)) return candidate;
    } catch (e) {
      if (/^https?:\/\//.test(pathSegmentMatch[2])) return pathSegmentMatch[2];
    }
  }

  try {
    const u = new URL(maybeProxied);
    for (const key of ["url", "u", "target", "q", "qurl"]) {
      const val = u.searchParams.get(key);
      if (val) {
        try {
          const d = decodeURIComponent(val);
          if (/^https?:\/\//.test(d)) return d;
        } catch (e) {}
        if (/^https?:\/\//.test(val)) return val;
      }
    }
  } catch (e) {}

  try {
    const parts = maybeProxied.split("/");
    for (let i = parts.length - 1; i >= 0; i--) {
      try {
        const dec = decodeURIComponent(parts[i]);
        if (/^https?:\/\//.test(dec)) return dec;
      } catch (e) {}
    }
  } catch (e) {}

  return maybeProxied;
}

function findAndDecodeEncodedUrl(str) {
  const m = str.match(/(https%3A%2F%2F[A-Za-z0-9%._~\-!$&'()*+,;=:@\/?]+)/i);
  if (m && m[1]) {
    try {
      const dec = decodeURIComponent(m[1]);
      if (/^https?:\/\//.test(dec)) return dec;
    } catch (e) {}
  }
  return null;
}

/* ===== NAV INPUT SET / HISTORY PUSH ===== */
function trySetNavInputIfDifferent(url) {
  if (!url) return;
  let cleaned = unwrapProxiedUrl(url);

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(cleaned)) {
    cleaned = ensureProtocol(cleaned);
  }

  if (cleaned !== lastKnownLocation) {
    lastKnownLocation = cleaned;
    try {
      navInput.value = cleaned;
    } catch (e) {}
    // frame navigation observed (link click / in-iframe nav) — maybe push it
    maybePushFromFrame(cleaned);
  }
}

/* ===== FRAME NAV UPDATE STRATEGIES ===== */
function attachFrameNavigationHandlers(f) {
  if (typeof f.onNavigate === "function") {
    try {
      f.onNavigate((newUrl) => {
        trySetNavInputIfDifferent(newUrl);
      });
    } catch (e) {}
  }

  if (typeof f.on === "function") {
    try {
      f.on("navigate", (newUrl) => trySetNavInputIfDifferent(newUrl));
    } catch (e) {}
  }

  try {
    f.frame.addEventListener("load", () => {
      try {
        const cw = f.frame.contentWindow;
        if (cw && cw.location && cw.location.href) {
          trySetNavInputIfDifferent(cw.location.href);
          return;
        }
      } catch (e) {
        // cross-origin — ignore
      }
      try {
        if (f.frame.src) trySetNavInputIfDifferent(f.frame.src);
      } catch (e) {}
    });
  } catch (e) {}

  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(() => {
    if (!f || !f.frame) return;
    try {
      const cw = f.frame.contentWindow;
      if (cw && cw.location && cw.location.href) {
        trySetNavInputIfDifferent(cw.location.href);
        return;
      }
    } catch (e) {
      // cross-origin — ignore
    }
    try {
      if (f.frame.src) trySetNavInputIfDifferent(f.frame.src);
    } catch (e) {}
  }, POLL_INTERVAL_MS);
}

/* ===== HISTORY HELPERS ===== */
function updateNavButtons() {
  backBtn.disabled = historyIndex <= 0;
  forwardBtn.disabled = historyIndex >= historyStack.length - 1;
}

function pushHistory(url, replace = false) {
  if (!url) return;
  // normalize display form (unwrap proxied so history is readable)
  const normalized = unwrapProxiedUrl(url);
  // If replace requested, overwrite current entry
  if (replace && historyIndex >= 0) {
    historyStack[historyIndex] = normalized;
    lastPushedUrl = normalized;
    updateNavButtons();
    return;
  }

  // drop any "forward" history
  historyStack = historyStack.slice(0, historyIndex + 1);

  // avoid pushing duplicate consecutive entries
  if (historyIndex >= 0 && historyStack[historyIndex] === normalized) {
    lastPushedUrl = normalized;
    updateNavButtons();
    return;
  }

  historyStack.push(normalized);
  historyIndex = historyStack.length - 1;
  lastPushedUrl = normalized;
  updateNavButtons();
}

function maybePushFromFrame(cleanedUrl) {
  // cleanedUrl is already unwrapped and normalized by trySetNavInputIfDifferent
  if (!cleanedUrl) return;
  if (historyIndex >= 0 && historyStack[historyIndex] === cleanedUrl) return;
  // If lastPushedUrl equals cleanedUrl, skip duplicate
  if (lastPushedUrl && lastPushedUrl === cleanedUrl) return;
  pushHistory(cleanedUrl);
}

/* ===== NAVIGATION (goTo) ===== */
async function goTo(input) {
  error.textContent = "";
  errorCode.textContent = "";

  const target = normalizeInputToUrl(input);
  if (!target) return;

  try {
    await registerSW();
  } catch (err) {
    error.textContent = "Failed to register service worker.";
    errorCode.textContent = err.toString();
    return;
  }

  const url = target;

  let wispUrl =
    (location.protocol === "https:" ? "wss" : "ws") +
    "://" +
    location.host +
    "/wisp/";

  try {
    if ((await connection.getTransport()) !== "/epoxy/index.mjs") {
      await connection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl }]);
    }
  } catch (err) {
    error.textContent = "Failed to establish proxy transport.";
    errorCode.textContent = err.toString();
    return;
  }

  if (!frame) {
    frame = scramjet.createFrame();
    frame.frame.id = "sj-frame";
    document.body.appendChild(frame.frame);

    attachFrameNavigationHandlers(frame);
  }

  if (home) {
    home.style.display = "none";
  }

  // show the URL immediately in the input
  trySetNavInputIfDifferent(url);

  try {
    // Use frame.go where available; this triggers frame.onNavigate handlers
    frame.go(url);
    // push immediate history entry so back/forward works immediately
    // store the unwrapped form in history
    pushHistory(url);
  } catch (err) {
    try {
      frame.frame.src = url;
      pushHistory(url);
    } catch (e) {}
    error.textContent = "Navigation failed.";
    errorCode.textContent = err.toString();
  }
}

/* ===== BACK / FORWARD / REFRESH ===== */
function goBack() {
  if (historyIndex <= 0) return;
  historyIndex--;
  const u = historyStack[historyIndex];
  updateNavButtons();
  if (!frame) return;
  try {
    frame.go(u);
  } catch (e) {
    try {
      frame.frame.src = u;
    } catch (err) {}
  }
  // update last known location/ui
  lastKnownLocation = u;
  navInput.value = u;
}

function goForward() {
  if (historyIndex >= historyStack.length - 1) return;
  historyIndex++;
  const u = historyStack[historyIndex];
  updateNavButtons();
  if (!frame) return;
  try {
    frame.go(u);
  } catch (e) {
    try {
      frame.frame.src = u;
    } catch (err) {}
  }
  lastKnownLocation = u;
  navInput.value = u;
}

function refreshCurrent() {
  if (!frame || historyIndex < 0) return;
  const u = historyStack[historyIndex];
  try {
    frame.go(u);
  } catch (e) {
    try {
      // forcing src = same url to reload
      frame.frame.src = u;
    } catch (err) {}
  }
  // Keep input showing current URL
  lastKnownLocation = u;
  navInput.value = u;
}

/* ===== EVENTS ===== */
navForm.addEventListener("submit", (e) => {
  e.preventDefault();
  goTo(navInput.value);
});

backBtn.addEventListener("click", (e) => {
  e.preventDefault();
  goBack();
});
forwardBtn.addEventListener("click", (e) => {
  e.preventDefault();
  goForward();
});
refreshBtn.addEventListener("click", (e) => {
  e.preventDefault();
  refreshCurrent();
});

/* ===== EXTRA: keyboard shortcuts ===== */
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
    e.preventDefault();
    navInput.focus();
    navInput.select();
  }
  // Alt+Left / Alt+Right as back/forward
  if (e.altKey && !e.shiftKey && e.key === "ArrowLeft") {
    e.preventDefault();
    goBack();
  }
  if (e.altKey && !e.shiftKey && e.key === "ArrowRight") {
    e.preventDefault();
    goForward();
  }
});
