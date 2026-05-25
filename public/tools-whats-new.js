(function () {
  "use strict";

  const PLUGIN_NAME = "tools-whats-new";
  const TAG = "[Tools What's New]";
  const WINDOW_MARKER = "__ToolsWhatsNewBootstrap_v3_native_whats_new";
  const CARD_CLASS = "twn-card";
  const FALLBACK_CLASS = "twn-fallback-card";
  const STYLE_ID = "twn-style";
  const MAX_ITEMS = 18;
  const MAX_APPS = 36;
  const PER_APP = 3;
  const PLAY_NEXT_MAX_APPS = 24;
  const PLAY_NEXT_STRATEGY = "balanced-play-next-v2";
  const NATIVE_WAIT_MS = 4500;
  const NATIVE_MERGE_START_DELAY_MS = 5000;
  const POPUP_SCAN_MS = 1000;
  const TWO_WEEKS_SECONDS = 14 * 24 * 60 * 60;

  if (window[WINDOW_MARKER]) return;
  window[WINDOW_MARKER] = true;

  const STATE = {
    req: null,
    modules: null,
    nativePatchInstalled: false,
    nativePatchFailed: false,
    nativePatchAttempts: 0,
    nativePayloadPromise: null,
    nativePayload: null,
    nativeRowsPromise: null,
    nativeRowsKey: "",
    nativeRows: [],
    nativePatchInstalledAt: 0,
    nativePatchDisabled: false,
    lastNativeBestRows: null,
    playNextPatchInstalled: false,
    playNextPatchAttempts: 0,
    playNextAppsPromise: null,
    playNextAppIDs: [],
    playNextAppsKey: "",
    fallbackStarted: false,
  };

  const documentStates = new WeakMap();

  function stringify(value) {
    const seen = new WeakSet();
    try {
      return JSON.stringify(value, (key, val) => {
        if (typeof val === "function") return `[function ${val.name || "anonymous"}]`;
        if (val && typeof val === "object") {
          if (seen.has(val)) return "[circular]";
          seen.add(val);
        }
        return val;
      });
    } catch (err) {
      return `[unserializable: ${err && err.message ? err.message : String(err)}]`;
    }
  }

  function log(message, data) {
    try {
      if (data === undefined) console.log(TAG, message);
      else console.log(TAG, message, stringify(data));
    } catch (_) {}
  }

  function warn(message, data) {
    try {
      if (data === undefined) console.warn(TAG, message);
      else console.warn(TAG, message, stringify(data));
    } catch (_) {}
  }

  function isDebugFlagEnabled(key) {
    try {
      if (window[key] === true) return true;
    } catch (_) {}
    for (const storageName of ["localStorage", "sessionStorage"]) {
      try {
        const storage = window[storageName];
        const value = storage && storage.getItem(key);
        if (value === "1" || value === "true" || value === "yes") return true;
      } catch (_) {}
    }
    return false;
  }

  function isNativeBestEventsPatchDisabled() {
    return (
      isDebugFlagEnabled("tools-whats-new:disable-native-best-events-patch") ||
      isDebugFlagEnabled("twn:disable-native-best-events-patch") ||
      isDebugFlagEnabled("__ToolsWhatsNewDisableNativeBestEventsPatch")
    );
  }

  function parsePayload(raw) {
    if (!raw) return null;
    if (typeof raw === "string") return JSON.parse(raw);
    return raw;
  }

  function callBackend(method, args) {
    if (!window.Millennium || typeof window.Millennium.callServerMethod !== "function") {
      return Promise.reject(new Error("Millennium.callServerMethod unavailable"));
    }
    return window.Millennium.callServerMethod(PLUGIN_NAME, method, {
      ...(args || {}),
      contentScriptQuery: "",
    });
  }

  function isAllowedSteamURL(value) {
    try {
      const url = new URL(String(value || ""), document.location.href);
      const host = url.hostname.toLowerCase();
      if (!["http:", "https:"].includes(url.protocol)) return false;
      return (
        host === "steampowered.com" ||
        host === "steamcommunity.com" ||
        host === "steamstatic.com" ||
        host === "steamstore-a.akamaihd.net" ||
        host.endsWith(".steampowered.com") ||
        host.endsWith(".steamcommunity.com") ||
        host.endsWith(".steamstatic.com")
      );
    } catch (_) {
      return false;
    }
  }

  function captureWebpackRequire() {
    if (STATE.req) return STATE.req;
    if (window.__ToolsWhatsNewWebpackRequire) return (STATE.req = window.__ToolsWhatsNewWebpackRequire);
    if (window.__NativeFeedBridgeWebpackRequire) return (STATE.req = window.__NativeFeedBridgeWebpackRequire);
    if (window.__NativeFeedUnlockerWebpackRequire) return (STATE.req = window.__NativeFeedUnlockerWebpackRequire);

    for (const chunkName of ["webpackChunksteamui", "webpackChunkappmgmt_storeadmin", "webpackChunkcommunity"]) {
      const chunk = window[chunkName];
      if (!chunk || !Array.isArray(chunk) || typeof chunk.push !== "function") continue;
      try {
        chunk.push([[Math.floor(Math.random() * 1e9)], {}, (req) => {
          window.__ToolsWhatsNewWebpackRequire = req;
          STATE.req = req;
        }]);
        if (STATE.req) {
          log("webpack require captured", { chunkName });
          return STATE.req;
        }
      } catch (err) {
        warn("failed to capture webpack require", { chunkName, error: err && err.message ? err.message : String(err) });
      }
    }
    return null;
  }

  function getNativeModules() {
    if (STATE.modules) return STATE.modules;
    const req = captureWebpackRequire();
    if (!req) return null;

    try {
      const libraryModule = req(57016);
      const appModule = req(1776);
      let playNextModule = null;
      let libraryAppModule = null;
      try {
        playNextModule = req(92749);
      } catch (_) {}
      try {
        libraryAppModule = req(96e3);
      } catch (_) {}
      STATE.modules = {
        libraryStore: libraryModule && libraryModule.dm,
        partnerStore: (libraryModule && libraryModule.IB) || window.partnerEventStore || window.g_PartnerEventStore,
        playNextStore: (playNextModule && playNextModule.x3) || window.playNextStore,
        appOverviewStore: (appModule && appModule.tw) || null,
        libraryAppStore: (libraryAppModule && libraryAppModule.md) || null,
      };
      log("native modules loaded", {
        hasLibraryStore: !!STATE.modules.libraryStore,
        hasPartnerStore: !!STATE.modules.partnerStore,
        hasPlayNextStore: !!STATE.modules.playNextStore,
        hasAppOverviewStore: !!STATE.modules.appOverviewStore,
        hasLibraryAppStore: !!STATE.modules.libraryAppStore,
      });
      return STATE.modules;
    } catch (err) {
      warn("failed loading native modules", { error: err && err.message ? err.message : String(err) });
      return null;
    }
  }

  function withTimeout(promise, ms, fallback) {
    let timer = 0;
    return Promise.race([
      promise,
      new Promise((resolve) => {
        timer = window.setTimeout(() => resolve(fallback), ms);
      }),
    ]).finally(() => window.clearTimeout(timer));
  }

  function uniqueStrings(values) {
    const out = [];
    const seen = new Set();
    values.forEach((value) => {
      const text = String(value || "").trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      out.push(text);
    });
    return out;
  }

  function nativePayloadKey(payload) {
    if (!payload || !Array.isArray(payload.items)) return "";
    return [
      payload.generatedAt || 0,
      payload.itemCount || 0,
      payload.items.map((item) => `${item.eventGID || ""}:${item.announcementGID || ""}`).join(","),
    ].join("|");
  }

  function prefetchNativePayload(force) {
    if (STATE.nativePayloadPromise && !force) return STATE.nativePayloadPromise;
    STATE.nativePayloadPromise = callBackend("GetToolsNativeNews", {
      maxItems: MAX_ITEMS,
      maxApps: MAX_APPS,
      perApp: PER_APP,
      refresh: !!force,
    })
      .then(parsePayload)
      .then((payload) => {
        STATE.nativePayload = payload;
        if (payload && payload.success) {
          log("native news plan loaded", {
            items: payload.itemCount,
            apps: payload.appCount,
            errors: payload.errors || [],
          });
        } else {
          warn("native news plan unavailable", payload);
          STATE.nativePayloadPromise = null;
        }
        return payload;
      })
      .catch((err) => {
        warn("native news plan failed", { error: err && err.message ? err.message : String(err) });
        STATE.nativePayloadPromise = null;
        return null;
      });
    return STATE.nativePayloadPromise;
  }

  function eventKey(event) {
    if (!event) return "";
    const clan = eventOwnerKey(event);
    return `${event.GID || ""}:${event.AnnouncementGID || ""}:${clan}`;
  }

  function eventTime(event) {
    return Number(
      (event && (event.startTime || event.postTime || event.visibilityStartTime || event.rtime32_last_modified)) || 0,
    );
  }

  function eventOwnerKey(event) {
    if (!event) return "";
    const direct =
      event.steamid ||
      event.steamID ||
      event.ownerSteamID ||
      event.owner_steamid ||
      event.clanSteamID ||
      event.clan_steamid;
    try {
      if (direct && typeof direct.ConvertTo64BitString === "function") return direct.ConvertTo64BitString();
    } catch (_) {}
    try {
      if (direct && typeof direct.GetAccountID === "function") return String(direct.GetAccountID());
    } catch (_) {}
    if (direct) return String(direct);
    const account = event.clanAccountID || event.clan_account_id || event.clanid || event.clanID;
    return account ? String(account) : "";
  }

  function isUsableNativeEvent(event) {
    return !!(event && Number(event.appid) > 0 && eventTime(event) > 0 && eventKey(event) && eventOwnerKey(event));
  }

  function nativeRowTemplate(nativeRows) {
    return Array.isArray(nativeRows)
      ? nativeRows.find((row) => row && typeof row === "object" && row.event && typeof row.event === "object")
      : null;
  }

  function nativeRowFromTemplate(template, event) {
    if (!template || !isUsableNativeEvent(event)) return null;
    const row = Object.assign(Object.create(Object.getPrototypeOf(template) || Object.prototype), template);
    row.event = event;
    row.nAppPriority = 0;
    row.bPossibleTakeOver = false;
    row.__twn = true;
    if ("appid" in template) row.appid = Number(event.appid);
    if ("steamid" in template && !row.steamid) row.steamid = eventOwnerKey(event);
    if ("clanSteamID" in template && event.clanSteamID) row.clanSteamID = event.clanSteamID;
    return row.event && isUsableNativeEvent(row.event) ? row : null;
  }

  function getAppOverview(appid) {
    const modules = getNativeModules();
    try {
      return modules && modules.appOverviewStore && modules.appOverviewStore.GetAppOverviewByAppID(Number(appid));
    } catch (_) {
      return null;
    }
  }

  function nativeDisplayName(appid, fallback) {
    const overview = getAppOverview(appid);
    return (overview && (overview.display_name || overview.name)) || fallback || `App ${appid}`;
  }

  function getLastPlayedTime(overview) {
    try {
      if (overview && typeof overview.GetLastTimePlayed === "function") {
        return Number(overview.GetLastTimePlayed() || 0);
      }
    } catch (_) {}
    return Number(
      (overview && (overview.rt_last_time_played || overview.rt_last_time_locally_played || overview.last_played_time)) || 0,
    );
  }

  function isLibraryAppVisible(overview) {
    if (!overview) return false;
    const modules = getNativeModules();
    try {
      if (modules && modules.libraryAppStore && typeof modules.libraryAppStore.BIsVisible === "function") {
        return !!modules.libraryAppStore.BIsVisible(overview);
      }
    } catch (_) {}
    return true;
  }

  function isPlayNextEligible(appid, includeRecent) {
    const overview = getAppOverview(appid);
    if (!overview || !isLibraryAppVisible(overview)) return false;
    if (includeRecent) return true;
    return getLastPlayedTime(overview) < (Date.now() / 1000 - TWO_WEEKS_SECONDS);
  }

  function mergePlayNextAppIDs(nativeAppIDs, includeRecent) {
    const merged = [];
    const seen = new Set();
    (nativeAppIDs || []).forEach((appid) => {
      const parsed = Number(appid);
      if (!parsed || seen.has(parsed)) return;
      if (!isPlayNextEligible(parsed, includeRecent)) return;
      seen.add(parsed);
      merged.push(parsed);
    });
    (STATE.playNextAppIDs || []).forEach((appid) => {
      const parsed = Number(appid);
      if (!parsed || seen.has(parsed)) return;
      if (!isPlayNextEligible(parsed, true)) return;
      seen.add(parsed);
      merged.push(parsed);
    });
    return merged;
  }

  function playNextAppsKey(appids) {
    return (appids || []).map((appid) => String(appid)).join(",");
  }

  function applyPlayNextCache(playNextStore) {
    if (!playNextStore || !STATE.playNextAppIDs.length) return false;
    const current = playNextStore.m_cachedPlayNext || { appids: [] };
    const currentAppIDs = Array.isArray(current.appids) ? current.appids : [];
    const merged = mergePlayNextAppIDs(currentAppIDs, true);
    const currentKey = playNextAppsKey(currentAppIDs);
    const mergedKey = playNextAppsKey(merged);
    if (!merged.length || currentKey === mergedKey) return false;

    try {
      playNextStore.m_cachedPlayNext = { ...current, appids: merged };
      playNextStore.m_bFresh = true;
      log("merged jogos lua into Play Next cache", {
        original: currentAppIDs.length,
        tools: STATE.playNextAppIDs.length,
        merged: merged.length,
      });
      return true;
    } catch (err) {
      warn("failed to merge jogos lua into Play Next cache", { error: err && err.message ? err.message : String(err) });
      return false;
    }
  }

  function prefetchPlayNextApps(force) {
    if (STATE.playNextAppsPromise && !force) return STATE.playNextAppsPromise;
    STATE.playNextAppsPromise = callBackend("ReadToolsApps", {
      maxApps: PLAY_NEXT_MAX_APPS,
      strategy: PLAY_NEXT_STRATEGY,
    })
      .then(parsePayload)
      .then((payload) => {
        if (!payload || !payload.success || !Array.isArray(payload.apps)) {
          warn("jogos lua Play Next plan unavailable", payload);
          STATE.playNextAppsPromise = null;
          return [];
        }

        const appIDs = [];
        const seen = new Set();
        payload.apps.forEach((app) => {
          const appid = Number(app && app.appid);
          if (!appid || seen.has(appid)) return;
          seen.add(appid);
          appIDs.push(appid);
        });
        STATE.playNextAppIDs = appIDs;
        const key = playNextAppsKey(appIDs);
        STATE.playNextAppsKey = key;
        log("jogos lua Play Next plan loaded", {
          strategy: payload.strategy || "unknown",
          apps: appIDs.length,
          buckets: payload.buckets || {},
          visibleNow: appIDs.filter((appid) => isPlayNextEligible(appid, true)).length,
        });

        const modules = getNativeModules();
        if (modules && modules.playNextStore) applyPlayNextCache(modules.playNextStore);
        return appIDs;
      })
      .catch((err) => {
        warn("jogos lua Play Next plan failed", { error: err && err.message ? err.message : String(err) });
        STATE.playNextAppsPromise = null;
        return [];
      });
    return STATE.playNextAppsPromise;
  }

  async function loadNativeRows(options, nativeRowsForShape) {
    const timeout = options && options.timeout ? options.timeout : NATIVE_WAIT_MS;
    const modules = getNativeModules();
    const partnerStore = modules && modules.partnerStore;
    if (!partnerStore || typeof partnerStore.LoadBatchPartnerEventsByEventGIDsOrAnnouncementGIDs !== "function") {
      return [];
    }

    const template = nativeRowTemplate(nativeRowsForShape);
    if (!template) {
      warn("native row template unavailable; skipping jogos lua event merge");
      return [];
    }

    if (STATE.nativeRowsPromise) {
      return withTimeout(STATE.nativeRowsPromise, timeout, STATE.nativeRows || []);
    }

    STATE.nativeRowsPromise = (async () => {
      const payload = await withTimeout(prefetchNativePayload(false), timeout, STATE.nativePayload);
      if (!payload || !payload.success || !Array.isArray(payload.items) || payload.items.length === 0) {
        return STATE.nativeRows || [];
      }

      const key = nativePayloadKey(payload);
      if (key && key === STATE.nativeRowsKey) return STATE.nativeRows || [];

      const announcementGIDs = uniqueStrings(payload.items.map((item) => item.announcementGID));
      const eventGIDs = uniqueStrings(payload.items.map((item) => item.eventGID));
      if (!announcementGIDs.length && !eventGIDs.length) return [];

      let events = [];
      try {
        events = await withTimeout(
          partnerStore.LoadBatchPartnerEventsByEventGIDsOrAnnouncementGIDs(
            eventGIDs.length ? eventGIDs.slice() : undefined,
            announcementGIDs.length ? announcementGIDs.slice() : undefined,
          ),
          timeout,
          [],
        );
      } catch (err) {
        warn("native batch event load failed", { error: err && err.message ? err.message : String(err) });
        events = [];
      }

      const fetchedEvents = Array.from(events || []);
      const rows = fetchedEvents
        .map((event) => nativeRowFromTemplate(template, event))
        .filter(Boolean);
      rows.sort((a, b) => eventTime(b.event) - eventTime(a.event));
      STATE.nativeRowsKey = key;
      STATE.nativeRows = rows;
      log("native events prepared for library feed", {
        fetchedEvents: fetchedEvents.length,
        rows: rows.length,
        announcementGIDs: announcementGIDs.length,
        eventGIDs: eventGIDs.length,
      });
      return rows;
    })().finally(() => {
      STATE.nativeRowsPromise = null;
    });

    return withTimeout(STATE.nativeRowsPromise, timeout, STATE.nativeRows || []);
  }

  function mergeEventRows(nativeRows, toolsRows) {
    const merged = [];
    const seen = new Set();
    [...(toolsRows || []), ...(nativeRows || [])].forEach((row) => {
      const event = row && row.event;
      const key = eventKey(event);
      if (!event || !key || seen.has(key) || !isUsableNativeEvent(event)) return;
      seen.add(key);
      merged.push(row);
    });
    merged.sort((a, b) => eventTime(b.event) - eventTime(a.event));
    return merged;
  }

  function installNativeBestEventsPatch() {
    if (STATE.nativePatchInstalled) return true;
    if (isNativeBestEventsPatchDisabled()) {
      STATE.nativePatchDisabled = true;
      log("native PartnerEventStore.GetBestEventsForCurrentUser patch disabled by debug flag");
      return true;
    }
    const modules = getNativeModules();
    const partnerStore = modules && modules.partnerStore;
    if (!partnerStore || typeof partnerStore.GetBestEventsForCurrentUser !== "function") return false;
    if (partnerStore.__ToolsWhatsNewOriginalGetBestEventsForCurrentUser) {
      STATE.nativePatchInstalled = true;
      return true;
    }

    const original = partnerStore.GetBestEventsForCurrentUser;
    Object.defineProperty(partnerStore, "__ToolsWhatsNewOriginalGetBestEventsForCurrentUser", {
      value: original,
      enumerable: false,
      configurable: true,
      writable: false,
    });

    partnerStore.GetBestEventsForCurrentUser = async function patchedGetBestEventsForCurrentUser(...args) {
      let nativeRows = null;
      try {
        nativeRows = await Promise.resolve(original.apply(this, args));
      } catch (err) {
        warn("native GetBestEventsForCurrentUser failed; returning cached native rows without merge", {
          error: err && err.message ? err.message : String(err),
          cachedRows: Array.isArray(STATE.lastNativeBestRows) ? STATE.lastNativeBestRows.length : 0,
        });
        return Array.isArray(STATE.lastNativeBestRows) ? STATE.lastNativeBestRows : [];
      }

      if (!Array.isArray(nativeRows)) return nativeRows;
      STATE.lastNativeBestRows = nativeRows;

      if (Date.now() - STATE.nativePatchInstalledAt < NATIVE_MERGE_START_DELAY_MS) {
        return nativeRows;
      }

      if (!nativeRows.length || !nativeRowTemplate(nativeRows)) {
        return nativeRows;
      }

      const toolsRows = await loadNativeRows({ timeout: NATIVE_WAIT_MS }, nativeRows).catch((err) => {
        warn("native rows unavailable during feed merge", { error: err && err.message ? err.message : String(err) });
        return [];
      });
      if (!toolsRows.length) return nativeRows;
      const merged = mergeEventRows(nativeRows, toolsRows);
      if (toolsRows.length) {
        log("merged jogos lua events into native Whats New response", {
          original: nativeRows.length,
          tools: toolsRows.length,
          merged: merged.length,
        });
      }
      return merged;
    };

    STATE.nativePatchInstalled = true;
    STATE.nativePatchInstalledAt = Date.now();
    log("patched native PartnerEventStore.GetBestEventsForCurrentUser");
    prefetchNativePayload(false);
    return true;
  }

  function installPlayNextPatch() {
    if (STATE.playNextPatchInstalled) return true;
    const modules = getNativeModules();
    const playNextStore = modules && modules.playNextStore;
    if (!playNextStore || typeof playNextStore.GetSuggestionsToShow !== "function") return false;
    if (playNextStore.__ToolsWhatsNewOriginalGetSuggestionsToShow) {
      STATE.playNextPatchInstalled = true;
      return true;
    }

    const originalGetSuggestionsToShow = playNextStore.GetSuggestionsToShow;
    const originalMaybeUpdate = playNextStore.MaybeUpdatePlayNextAsync;
    const originalLoadCache = playNextStore.LoadCacheFromLocalStorage;

    Object.defineProperty(playNextStore, "__ToolsWhatsNewOriginalGetSuggestionsToShow", {
      value: originalGetSuggestionsToShow,
      enumerable: false,
      configurable: true,
      writable: false,
    });

    playNextStore.GetSuggestionsToShow = function patchedGetSuggestionsToShow(includeRecent) {
      try {
        const result = originalGetSuggestionsToShow.call(this, includeRecent) || {};
        const apps = mergePlayNextAppIDs(result.apps || [], !!includeRecent);
        return { ...result, apps };
      } catch (err) {
        warn("native PlayNextStore.GetSuggestionsToShow failed", {
          error: err && err.message ? err.message : String(err),
        });
        return { apps: [] };
      }
    };

    if (typeof originalMaybeUpdate === "function" && !playNextStore.__ToolsWhatsNewOriginalMaybeUpdatePlayNextAsync) {
      Object.defineProperty(playNextStore, "__ToolsWhatsNewOriginalMaybeUpdatePlayNextAsync", {
        value: originalMaybeUpdate,
        enumerable: false,
        configurable: true,
        writable: false,
      });
      playNextStore.MaybeUpdatePlayNextAsync = async function patchedMaybeUpdatePlayNextAsync(...args) {
        const result = await Promise.resolve(originalMaybeUpdate.apply(this, args)).catch((err) => {
          warn("native PlayNextStore.MaybeUpdatePlayNextAsync failed", {
            error: err && err.message ? err.message : String(err),
          });
          return null;
        });
        applyPlayNextCache(this);
        return result;
      };
    }

    if (typeof originalLoadCache === "function" && !playNextStore.__ToolsWhatsNewOriginalLoadCacheFromLocalStorage) {
      Object.defineProperty(playNextStore, "__ToolsWhatsNewOriginalLoadCacheFromLocalStorage", {
        value: originalLoadCache,
        enumerable: false,
        configurable: true,
        writable: false,
      });
      playNextStore.LoadCacheFromLocalStorage = async function patchedLoadCacheFromLocalStorage(...args) {
        const result = await Promise.resolve(originalLoadCache.apply(this, args)).catch((err) => {
          warn("native PlayNextStore.LoadCacheFromLocalStorage failed", {
            error: err && err.message ? err.message : String(err),
          });
          return null;
        });
        applyPlayNextCache(this);
        return result;
      };
    }

    STATE.playNextPatchInstalled = true;
    log("patched native PlayNextStore suggestions");
    prefetchPlayNextApps(false).then(() => applyPlayNextCache(playNextStore));
    return true;
  }

  function startNativeBridge() {
    prefetchNativePayload(false);
    prefetchPlayNextApps(false);
    if (installNativeBestEventsPatch()) return;

    const timer = window.setInterval(() => {
      STATE.nativePatchAttempts += 1;
      if (installNativeBestEventsPatch() || STATE.nativePatchAttempts > 120) {
        window.clearInterval(timer);
        if (!STATE.nativePatchInstalled) {
          STATE.nativePatchFailed = true;
          warn("native patch unavailable; starting DOM fallback", { attempts: STATE.nativePatchAttempts });
          startFallbackAll();
        }
      }
    }, 250);
  }

  function startPlayNextBridge() {
    prefetchPlayNextApps(false);
    if (installPlayNextPatch()) return;

    const timer = window.setInterval(() => {
      STATE.playNextPatchAttempts += 1;
      if (installPlayNextPatch() || STATE.playNextPatchAttempts > 120) {
        window.clearInterval(timer);
        if (!STATE.playNextPatchInstalled) {
          warn("Play Next patch unavailable", { attempts: STATE.playNextPatchAttempts });
        }
      }
    }, 250);
  }

  function documentState(doc) {
    if (!documentStates.has(doc)) {
      documentStates.set(doc, {
        active: false,
        loading: false,
        lastKey: "",
        lastRun: 0,
        observer: null,
        route: "",
        interval: 0,
      });
    }
    return documentStates.get(doc);
  }

  function docWindow(doc) {
    return (doc && doc.defaultView) || window;
  }

  function compactText(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toUpperCase();
  }

  function isLibraryDocument(doc) {
    try {
      if (!doc || !doc.body) return false;
      const host = String((doc.location && doc.location.hostname) || "");
      const text = compactText(doc.body.textContent).slice(0, 12000);
      const hasLibraryShell = text.includes("BIBLIOTECA") || text.includes("LIBRARY");
      const hasWhatsNew = text.includes("NOVIDADES") || text.includes("WHAT'S NEW") || text.includes("WHAT\u2019S NEW") || text.includes("WHATS NEW");
      if (host === "steamloopback.host") return hasLibraryShell && hasWhatsNew;
      if (String(doc.title || "") !== "Steam") return false;
      return hasLibraryShell && hasWhatsNew;
    } catch (_) {
      return false;
    }
  }

  function getPopupDocuments() {
    const manager = window.g_PopupManager || globalThis.g_PopupManager;
    if (!manager || typeof manager.GetPopups !== "function") return [];
    try {
      return Array.from(manager.GetPopups())
        .map((popup) => (popup && popup.m_popup && popup.m_popup.document) || (popup && popup.window && popup.window.document))
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function ensureStyles(doc) {
    if (!doc || doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${CARD_CLASS} {
        position: relative;
      }
      .${CARD_CLASS} .twn-source-pill,
      .${FALLBACK_CLASS} .twn-source-pill {
        display: inline-flex;
        align-items: center;
        width: fit-content;
        max-width: 100%;
        margin-top: 4px;
        padding: 2px 7px;
        border-radius: 2px;
        background: rgba(87, 203, 222, 0.16);
        color: #9ad7e5;
        font-size: 12px;
        line-height: 16px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .${FALLBACK_CLASS} {
        min-width: 348px;
        width: 348px;
        max-width: 348px;
        color: #dcdedf;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .${FALLBACK_CLASS}:hover .twn-fallback-title {
        color: #ffffff;
      }
      .twn-fallback-date {
        color: #8b929a;
        font-size: 14px;
        line-height: 18px;
      }
      .twn-fallback-image {
        width: 100%;
        height: 196px;
        object-fit: cover;
        background: #111820;
        border-radius: 4px;
        display: block;
      }
      .twn-fallback-title {
        color: #dcdedf;
        font-size: 18px;
        line-height: 22px;
        max-height: 44px;
        overflow: hidden;
        transition: color 120ms ease;
      }
    `;
    doc.head.appendChild(style);
  }

  function relativeDate(seconds) {
    const date = Number(seconds || 0);
    if (!date) return "Tools";
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - date);
    const minute = 60;
    const hour = 60 * minute;
    const day = 24 * hour;
    const week = 7 * day;
    const month = 30 * day;

    if (diff < hour) return "agora";
    if (diff < day) return "hoje";
    if (diff < 2 * day) return "ontem";
    if (diff < week) return `ha ${Math.floor(diff / day)} dias`;
    if (diff < 2 * week) return "ha 1 semana";
    if (diff < month) return `ha ${Math.floor(diff / week)} semanas`;
    const months = Math.floor(diff / month);
    return months <= 1 ? "ha 1 mes" : `ha ${months} meses`;
  }

  function openNews(item) {
    const url = item && item.url;
    if (!url || !isAllowedSteamURL(url)) return;
    try {
      if (window.SteamClient && SteamClient.System && SteamClient.System.OpenInSystemBrowser) {
        SteamClient.System.OpenInSystemBrowser(url);
        return;
      }
    } catch (_) {}
    window.open(url, "_blank");
  }

  function resetClone(card) {
    card.classList.add(CARD_CLASS);
    card.dataset.twn = "1";
    card.removeAttribute("id");
    card.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    card.querySelectorAll("source").forEach((node) => node.remove());
    card.querySelectorAll("video").forEach((node) => node.remove());
  }

  function applyTextByShape(card, item) {
    const dateText = relativeDate(item.date);
    const description = item.contents || item.title || "";
    const appName = nativeDisplayName(item.appid, item.appName);

    try {
      if (card.children[0]) card.children[0].textContent = dateText;
      if (card.children[1] && card.children[1].children[0]) {
        if (card.children[1].children[0].children[0]) {
          card.children[1].children[0].children[0].textContent = appName;
        }
        if (card.children[1].children[0].children[1]) {
          card.children[1].children[0].children[1].textContent = description;
        }
      }
      if (card.children[2]) card.children[2].textContent = item.title;
      if (card.children[3]) card.children[3].remove();
      return true;
    } catch (_) {
      return false;
    }
  }

  function setCloneImage(card, item) {
    const image = card.querySelector("img");
    if (!image) return false;
    image.src = isAllowedSteamURL(item.image) ? item.image : "";
    image.removeAttribute("srcset");
    image.alt = item.title || nativeDisplayName(item.appid, item.appName) || "Tools news";
    image.style.objectFit = "cover";
    return true;
  }

  function addSourcePill(doc, card, item) {
    let pill = card.querySelector(".twn-source-pill");
    if (!pill) {
      pill = doc.createElement("div");
      pill.className = "twn-source-pill";
      card.appendChild(pill);
    }
    pill.textContent = nativeDisplayName(item.appid, item.appName);
    pill.title = "Tools";
  }

  function createCardFromTemplate(doc, template, item) {
    if (!template) return null;
    const card = template.cloneNode(true);
    resetClone(card);
    const shaped = applyTextByShape(card, item);
    const hasImage = setCloneImage(card, item);
    addSourcePill(doc, card, item);
    card.title = item.title || "";
    card.style.cursor = "pointer";
    card.addEventListener("click", () => openNews(item));
    if (!shaped || !hasImage) return null;
    return card;
  }

  function createFallbackCard(doc, item) {
    const card = doc.createElement("div");
    card.className = FALLBACK_CLASS;
    card.dataset.twn = "1";
    card.title = item.title || "";

    const date = doc.createElement("div");
    date.className = "twn-fallback-date";
    date.textContent = relativeDate(item.date);

    const image = doc.createElement("img");
    image.className = "twn-fallback-image";
    image.src = isAllowedSteamURL(item.image) ? item.image : "";
    image.alt = item.title || nativeDisplayName(item.appid, item.appName) || "Tools news";

    const title = doc.createElement("div");
    title.className = "twn-fallback-title";
    title.textContent = item.title || "Tools news";

    const pill = doc.createElement("div");
    pill.className = "twn-source-pill";
    pill.textContent = nativeDisplayName(item.appid, item.appName);

    card.appendChild(date);
    card.appendChild(image);
    card.appendChild(title);
    card.appendChild(pill);
    card.addEventListener("click", () => openNews(item));
    return card;
  }

  function removeOldCards(list) {
    Array.from(list.querySelectorAll(`[data-twn="1"]`)).forEach((node) => node.remove());
  }

  function listScore(list) {
    const text = ((list.parentElement && list.parentElement.textContent) || "").toLowerCase();
    let score = 0;
    if (text.includes("novidades") || text.includes("what's new") || text.includes("whats new")) score += 20;
    if (list.querySelector("img")) score += 5;
    score += Math.min(6, list.children.length);
    return score;
  }

  function findWhatsNewList(doc) {
    const selectors = [
      "#popup_target [role='list']",
      "div.WideRightPanel [role='list']",
      "[role='list']",
    ];
    const seen = new Set();
    const candidates = [];
    selectors.forEach((selector) => {
      doc.querySelectorAll(selector).forEach((list) => {
        if (!seen.has(list)) {
          seen.add(list);
          candidates.push(list);
        }
      });
    });
    return candidates
      .filter((list) => list && list.children && list.children.length > 0 && list.querySelector("img"))
      .sort((a, b) => listScore(b) - listScore(a))[0] || null;
  }

  function firstNativeTemplate(list) {
    return Array.from(list.children).find((child) => {
      if (!child || child.dataset.twn === "1") return false;
      return child.querySelector && child.querySelector("img");
    }) || null;
  }

  function renderItems(doc, payload) {
    if (STATE.nativePatchInstalled) return false;
    if (!payload || !payload.success || !Array.isArray(payload.items)) return false;
    const list = findWhatsNewList(doc);
    if (!list) return false;

    ensureStyles(doc);
    removeOldCards(list);

    const template = firstNativeTemplate(list);
    const fragment = doc.createDocumentFragment();
    payload.items.slice(0, MAX_ITEMS).forEach((item) => {
      const card = createCardFromTemplate(doc, template, item) || createFallbackCard(doc, item);
      fragment.appendChild(card);
    });
    list.insertBefore(fragment, list.firstChild);
    log("rendered DOM fallback cards", { count: payload.items.length });
    return true;
  }

  async function refreshFallback(doc, force) {
    if (STATE.nativePatchInstalled) return;
    if (!isLibraryDocument(doc)) return;
    const state = documentState(doc);
    if (state.loading) return;
    const now = Date.now();
    if (!force && now - state.lastRun < 2500) return;
    state.lastRun = now;
    state.loading = true;
    try {
      const raw = await callBackend("GetToolsNews", {
        maxItems: MAX_ITEMS,
        maxApps: MAX_APPS,
        perApp: PER_APP,
        refresh: !!force,
      });
      const payload = parsePayload(raw);
      if (!payload || !payload.success) {
        log("backend returned no fallback news", payload);
        return;
      }
      const key = `${payload.generatedAt}:${payload.itemCount}:${payload.appCount}`;
      const list = findWhatsNewList(doc);
      if (!force && state.lastKey === key && list && list.querySelector(`[data-twn="1"]`)) {
        return;
      }
      const rendered = renderItems(doc, payload);
      if (rendered) state.lastKey = key;
    } catch (error) {
      warn("fallback refresh failed", { error: error && error.message ? error.message : String(error) });
    } finally {
      state.loading = false;
    }
  }

  function scheduleFallback(doc, force) {
    docWindow(doc).setTimeout(() => refreshFallback(doc, !!force), 250);
  }

  function startFallbackDocument(doc, source) {
    if (STATE.nativePatchInstalled) return;
    if (!isLibraryDocument(doc)) return;
    const state = documentState(doc);
    if (state.active) return;
    state.active = true;
    state.route = String(doc.location.href || "");
    ensureStyles(doc);
    scheduleFallback(doc, true);

    const win = docWindow(doc);
    const Observer = win.MutationObserver || window.MutationObserver;
    state.observer = new Observer(() => {
      if (STATE.nativePatchInstalled) return;
      const route = String(doc.location.href || "");
      const routeChanged = route !== state.route;
      if (routeChanged) state.route = route;
      scheduleFallback(doc, routeChanged);
    });

    if (doc.body) {
      state.observer.observe(doc.body, { childList: true, subtree: true });
    }

    state.interval = win.setInterval(() => {
      if (STATE.nativePatchInstalled) return;
      const list = findWhatsNewList(doc);
      if (list && !list.querySelector(`[data-twn="1"]`)) {
        scheduleFallback(doc, false);
      }
    }, 15000);

    log("attached DOM fallback to library document", { source: source || "document" });
  }

  function attachWindowHook() {
    const millennium = window.MILLENNIUM_API && window.MILLENNIUM_API.Millennium;
    if (!millennium || typeof millennium.AddWindowCreateHook !== "function") return;
    try {
      millennium.AddWindowCreateHook((steamWindow) => {
        const doc = steamWindow && steamWindow.m_popup && steamWindow.m_popup.document;
        if (doc && STATE.fallbackStarted) startFallbackDocument(doc, steamWindow.m_strName || "window-hook");
      });
      log("registered Millennium window hook");
    } catch (error) {
      warn("failed to register window hook", { error: error && error.message ? error.message : String(error) });
    }
  }

  function startFallbackAll() {
    if (STATE.fallbackStarted || STATE.nativePatchInstalled) return;
    STATE.fallbackStarted = true;
    startFallbackDocument(document, "current-document");
    getPopupDocuments().forEach((popupDoc) => startFallbackDocument(popupDoc, "popup-scan"));
    window.setInterval(() => {
      if (STATE.nativePatchInstalled) return;
      startFallbackDocument(document, "current-document");
      getPopupDocuments().forEach((popupDoc) => startFallbackDocument(popupDoc, "popup-scan"));
    }, POPUP_SCAN_MS);
  }

  log("bootstrap loaded");
  attachWindowHook();
  startNativeBridge();
  startPlayNextBridge();
})();
