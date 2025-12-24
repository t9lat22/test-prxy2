"use strict";

/* ===== ELEMENTS ===== */
const navForm = document.getElementById("nav-form");
const navInput = document.getElementById("nav-input");
const home = document.getElementById("home");
const backBtn = document.getElementById("backBtn");
const forwardBtn = document.getElementById("forwardBtn");
const refreshBtn = document.getElementById("refreshBtn");
const newTabBtn = document.getElementById("newTabBtn");
const tabsContainer = document.getElementById("tabsContainer");

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
let pollHandle = null;
let lastKnownLocation = "";

/* ===== TABS ===== */
let tabIdCounter = 0;
let tabs = []; // each: { id, title, history: [], historyIndex, frame, tabEl }
let activeTabId = null;

/* ===== CONFIG ===== */
const POLL_INTERVAL_MS = 1000; // adjust if needed
const FALLBACK_SEARCH = "https://www.google.com/search?q=%s";
const DEFAULT_NEW_TAB_URL = "https://4texas4.github.io/tools/search.html";

/* ===== HELPERS (URL normalization / search) ===== */
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

/* ===== UNWRAP proxied URL into original target URL (keeps UI readable) ===== */
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

/* ===== TRANSPORT / SW helper ===== */
async function ensureTransportAndSW() {
  // registerSW() may already be available in global scope (register-sw.js)
  try {
    await registerSW();
  } catch (err) {
    console.warn("registerSW failed:", err);
    // continue; some hosts may not need it
  }

  const wispUrl =
    (location.protocol === "https:" ? "wss" : "ws") +
    "://" +
    location.host +
    "/wisp/";

  try {
    if ((await connection.getTransport()) !== "/epoxy/index.mjs") {
      await connection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl }]);
    }
  } catch (err) {
    console.warn("setTransport failed:", err);
  }
}

/* ===== TAB UI helpers ===== */
function createTabElement(tab) {
  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.dataset.tabId = tab.id;
  tabEl.innerHTML = `
    <span class="tab-title">${escapeHtml(tab.title || "New Tab")}</span>
    <button class="tab-close" title="Close">×</button>
  `;

  tabEl.addEventListener("click", (e) => {
    if (e.target.classList.contains("tab-close")) return;
    switchToTab(tab.id);
  });

  tabEl.querySelector(".tab-close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tab.id);
  });

  return tabEl;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/* ===== TABS: create / switch / close / load ===== */
async function createTab(url = DEFAULT_NEW_TAB_URL, switchTo = true) {
  await ensureTransportAndSW();

  const id = ++tabIdCounter;
  const tab = {
    id,
    title: "New Tab",
    history: [],
    historyIndex: -1,
    frame: null,
    tabEl: null,
  };
  tabs.push(tab);

  // create UI element
  const tabEl = createTabElement(tab);
  tabsContainer.appendChild(tabEl);
  tab.tabEl = tabEl;

  // create frame
  try {
    const f = scramjet.createFrame();
    f.frame.id = `sj-frame-${id}`;
    f.frame.style.display = "none"; // hidden until switched to
    f.frame.style.position = "fixed";
    f.frame.style.top = getFrameTop() + "px"; // 84px: tabs + URL bar
    f.frame.style.left = "0";
    f.frame.style.width = "100vw";
    f.frame.style.height = `calc(100vh - ${getFrameTop()}px)`;
    f.frame.style.border = "none";
    f.frame.style.backgroundColor = "#111";
    f.frame.style.zIndex = "10";
    document.body.appendChild(f.frame);
    tab.frame = f;

    attachFrameNavigationHandlersForTab(f, tab.id);

    // load initial URL (push into tab history)
    await loadUrlInTab(tab, url, true);
  } catch (e) {
    // fallback: create plain iframe if scramjet frame fails
    const iframe = document.createElement("iframe");
    iframe.id = `sj-frame-${id}`;
    iframe.style.display = "none";
    iframe.style.position = "fixed";
    iframe.style.top = getFrameTop() + "px";
    iframe.style.left = "0";
    iframe.style.width = "100vw";
    iframe.style.height = `calc(100vh - ${getFrameTop()}px)`;
    iframe.style.border = "none";
    document.body.appendChild(iframe);
    tab.frame = { frame: iframe, go: (u) => (iframe.src = u) };
    attachFrameNavigationHandlersForTab(tab.frame, tab.id);
    await loadUrlInTab(tab, url, true);
  }

  if (switchTo) switchToTab(id);
  return tab;
}

function getFrameTop() {
  // tabsbar height 36 + topbar height 48 => top = 84
  // Keep consistent with CSS
  return 84;
}

function switchToTab(tabId) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;

  // hide all frames & remove active class from tabs
  tabs.forEach((t) => {
    try {
      if (t.frame && t.frame.frame) t.frame.frame.style.display = "none";
    } catch (e) {}
    if (t.tabEl) t.tabEl.classList.remove("active");
  });

  // show chosen
  try {
    tab.frame.frame.style.display = "";
  } catch (e) {}
  if (tab.tabEl) tab.tabEl.classList.add("active");
  activeTabId = tabId;

  // update nav input and nav buttons
  if (tab.historyIndex >= 0) {
    navInput.value = tab.history[tab.historyIndex];
    lastKnownLocation = tab.history[tab.historyIndex];
  } else {
    navInput.value = "";
    lastKnownLocation = "";
  }
  updateNavButtonsForActiveTab();
}

async function closeTab(tabId) {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  const tab = tabs[idx];

  // remove frame element
  try {
    if (tab.frame && tab.frame.frame) tab.frame.frame.remove();
  } catch (e) {}

  // remove tab element
  try {
    if (tab.tabEl) tab.tabEl.remove();
  } catch (e) {}

  tabs.splice(idx, 1);

  // if closed active, switch to neighbor or create new
  if (activeTabId === tabId) {
    if (tabs.length > 0) {
      const next = tabs[Math.max(0, idx - 1)];
      switchToTab(next.id);
    } else {
      // create a fresh tab
      createTab(DEFAULT_NEW_TAB_URL, true);
    }
  }
}

/* ===== NAV / HISTORY functions per-tab ===== */
function updateNavButtonsForActiveTab() {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) {
    backBtn.disabled = true;
    forwardBtn.disabled = true;
    return;
  }
  backBtn.disabled = !(tab.historyIndex > 0);
  forwardBtn.disabled = !(tab.historyIndex < tab.history.length - 1);
}

function pushHistoryForTab(tab, rawUrl, replace = false) {
  if (!tab || !rawUrl) return;
  const normalized = unwrapProxiedUrl(rawUrl);
  const final = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalized)
    ? normalized
    : ensureProtocol(normalized);

  if (replace && tab.historyIndex >= 0) {
    tab.history[tab.historyIndex] = final;
    updateNavButtonsForActiveTab();
    return;
  }

  tab.history = tab.history.slice(0, tab.historyIndex + 1);

  if (tab.historyIndex >= 0 && tab.history[tab.historyIndex] === final) {
    // duplicate
    updateNavButtonsForActiveTab();
    return;
  }

  tab.history.push(final);
  tab.historyIndex = tab.history.length - 1;
  updateNavButtonsForActiveTab();
}

async function loadUrlInTab(tab, url, push = true) {
  if (!tab) return;
  if (!tab.frame) {
    // create frame if somehow missing
    await createTab(url, false);
    return;
  }

  tab.title = "Loading...";
  if (tab.tabEl)
    tab.tabEl.querySelector(".tab-title").textContent = "Loading...";

  // use frame.go if available
  try {
    if (typeof tab.frame.go === "function") {
      tab.frame.go(url);
    } else if (tab.frame.frame) {
      tab.frame.frame.src = url;
    }
  } catch (e) {
    try {
      if (tab.frame.frame) tab.frame.frame.src = url;
    } catch (err) {}
  }

  if (push) pushHistoryForTab(tab, url);
}

/* ===== ATTACH FRAME NAV HANDLERS (per tab) ===== */
function attachFrameNavigationHandlersForTab(f, tabId) {
  const tab = () => tabs.find((t) => t.id === tabId);
  // when scramjet provides onNavigate
  if (typeof f.onNavigate === "function") {
    try {
      f.onNavigate((newUrl) => {
        handleFrameNavigation(tabId, newUrl);
      });
    } catch (e) {}
  }
  // if scramjet uses event emitter
  if (typeof f.on === "function") {
    try {
      f.on("navigate", (newUrl) => handleFrameNavigation(tabId, newUrl));
    } catch (e) {}
  }

  // load event
  try {
    f.frame.addEventListener("load", () => {
      try {
        const cw = f.frame.contentWindow;
        // try same-origin title
        try {
          if (cw && cw.document && cw.document.title) {
            setTabTitle(tabId, cw.document.title);
          }
        } catch (e) {}
        // try location href
        try {
          if (cw && cw.location && cw.location.href) {
            handleFrameNavigation(tabId, cw.location.href);
            return;
          }
        } catch (e) {}
      } catch (e) {}
      // fallback to src
      try {
        if (f.frame.src) handleFrameNavigation(tabId, f.frame.src);
      } catch (e) {}
    });
  } catch (e) {}

  // polling fallback for cross-origin pages and SPA navigations
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(() => {
    const currentTab = tabs.find((t) => t.id === tabId);
    if (!currentTab || !currentTab.frame || !currentTab.frame.frame) return;
    try {
      const cw = currentTab.frame.frame.contentWindow;
      if (cw && cw.location && cw.location.href) {
        handleFrameNavigation(tabId, cw.location.href);
        // try to set title if same-origin
        try {
          if (cw.document && cw.document.title)
            setTabTitle(tabId, cw.document.title);
        } catch (e) {}
        return;
      }
    } catch (e) {}
    try {
      if (currentTab.frame.frame.src)
        handleFrameNavigation(tabId, currentTab.frame.frame.src);
    } catch (e) {}
  }, POLL_INTERVAL_MS);
}

/* ===== FRAME NAV HANDLER (updates UI + history + title) ===== */
function handleFrameNavigation(tabId, rawUrl) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const unwrapped = unwrapProxiedUrl(rawUrl);
  // update input if this is active tab
  if (activeTabId === tabId) {
    if (document.activeElement !== navInput) {
      if (navInput.value !== unwrapped) navInput.value = unwrapped;
      lastKnownLocation = unwrapped;
    }
  }

  // push to this tab history (avoid duplicates)
  if (tab.history[tab.historyIndex] !== unwrapped)
    pushHistoryForTab(tab, unwrapped);
  // also set a nicer title if nothing else
  trySetTabTitleFromUrl(tabId, unwrapped);
}

/* ===== TAB TITLE helpers ===== */
function setTabTitle(tabId, title) {
  const t = tabs.find((x) => x.id === tabId);
  if (!t) return;
  t.title = title || t.title || "";
  if (t.tabEl)
    t.tabEl.querySelector(".tab-title").textContent = title || t.title;
}

function trySetTabTitleFromUrl(tabId, url) {
  if (!url) return;
  try {
    const u = new URL(url);
    const hostname = u.hostname.replace(/^www\./, "");
    if (
      !tabs.find((x) => x.id === tabId).title ||
      tabs.find((x) => x.id === tabId).title === "Loading..."
    ) {
      setTabTitle(tabId, hostname);
    }
  } catch (e) {
    // fallback: show raw
    setTabTitle(tabId, url);
  }
}

/* ===== NAV / UI actions (Back/Forward/Refresh) ===== */
function goBackActiveTab() {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) return;
  if (tab.historyIndex <= 0) return;
  tab.historyIndex--;
  const u = tab.history[tab.historyIndex];
  updateNavButtonsForActiveTab();
  try {
    if (typeof tab.frame.go === "function") tab.frame.go(u);
    else tab.frame.frame.src = u;
  } catch (e) {
    try {
      tab.frame.frame.src = u;
    } catch (er) {}
  }
  navInput.value = u;
  lastKnownLocation = u;
}

function goForwardActiveTab() {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) return;
  if (tab.historyIndex >= tab.history.length - 1) return;
  tab.historyIndex++;
  const u = tab.history[tab.historyIndex];
  updateNavButtonsForActiveTab();
  try {
    if (typeof tab.frame.go === "function") tab.frame.go(u);
    else tab.frame.frame.src = u;
  } catch (e) {
    try {
      tab.frame.frame.src = u;
    } catch (er) {}
  }
  navInput.value = u;
  lastKnownLocation = u;
}

function refreshActiveTab() {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab || tab.historyIndex < 0) return;
  const u = tab.history[tab.historyIndex];
  try {
    if (typeof tab.frame.go === "function") tab.frame.go(u);
    else tab.frame.frame.src = u;
  } catch (e) {
    try {
      tab.frame.frame.src = u;
    } catch (er) {}
  }
  navInput.value = u;
  lastKnownLocation = u;
}

/* ===== EVENTS ===== */
navForm.addEventListener("submit", (e) => {
  e.preventDefault();
  // if no tabs, create one first
  if (!activeTabId) {
    createTab(navInput.value || DEFAULT_NEW_TAB_URL, true);
    return;
  }
  const url = normalizeInputToUrl(navInput.value);
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) {
    createTab(url, true);
    return;
  }
  loadUrlInTab(tab, url, true);
});

backBtn.addEventListener("click", (e) => {
  e.preventDefault();
  goBackActiveTab();
});
forwardBtn.addEventListener("click", (e) => {
  e.preventDefault();
  goForwardActiveTab();
});
refreshBtn.addEventListener("click", (e) => {
  e.preventDefault();
  refreshActiveTab();
});
newTabBtn.addEventListener("click", (e) => {
  e.preventDefault();
  createTab(DEFAULT_NEW_TAB_URL, true);
});

/* keyboard shortcuts */
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
    e.preventDefault();
    navInput.focus();
    navInput.select();
  }
  if (e.altKey && !e.shiftKey && e.key === "ArrowLeft") {
    e.preventDefault();
    goBackActiveTab();
  }
  if (e.altKey && !e.shiftKey && e.key === "ArrowRight") {
    e.preventDefault();
    goForwardActiveTab();
  }
});

/* ===== BOOT: start with one tab (google) ===== */
(async function boot() {
  await ensureTransportAndSW();
  // create first tab and open google
  const t = await createTab(DEFAULT_NEW_TAB_URL, true);
  // make sure UI buttons reflect initial state
  updateNavButtonsForActiveTab();
})();
