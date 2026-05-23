import html
import hashlib
import json
import os
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from typing import Any, Dict, Iterable, List, Optional, Tuple

import Millennium  # type: ignore

PLUGIN_NAME = "luatools-whats-new"
WEBKIT_DIR_NAME = "LuaToolsWhatsNew"
WEB_UI_JS_FILE = "luatools-whats-new.js"

MAX_APPS_DEFAULT = 36
MAX_ITEMS_DEFAULT = 18
PER_APP_DEFAULT = 3
CACHE_SECONDS = 10 * 60
HTTP_TIMEOUT_SECONDS = 10
MAX_TEXT_FILE_BYTES = 20 * 1024 * 1024
SECONDS_PER_DAY = 24 * 60 * 60
PLAY_NEXT_STRATEGY = "balanced-play-next-v2"
ALLOWED_STEAM_HOST_SUFFIXES = (
    ".steampowered.com",
    ".steamcommunity.com",
    ".steamstatic.com",
)
ALLOWED_STEAM_HOSTS = {
    "steampowered.com",
    "steamcommunity.com",
    "steamstatic.com",
    "steamstore-a.akamaihd.net",
}

NEWS_CACHE: Dict[str, Any] = {"key": "", "time": 0, "payload": ""}
NATIVE_NEWS_CACHE: Dict[str, Any] = {"key": "", "time": 0, "payload": ""}
IMAGE_CACHE: Dict[str, str] = {}
REDIRECT_CACHE: Dict[str, str] = {}


class Plugin:
    def _front_end_loaded(self):
        _copy_webkit_files()

    def _load(self):
        _log("backend loading")
        _copy_webkit_files()
        _inject_webkit_files()
        Millennium.ready()

    def _unload(self):
        _log("backend unloaded")


plugin = Plugin()


def _log(message: str) -> None:
    try:
        print(f"[LuaTools What's New] {_redact_log_text(message)}")
    except Exception:
        pass


def _redact_log_text(value: Any) -> str:
    text = str(value)
    text = re.sub(r"[A-Za-z]:\\[^:\r\n]+", "[local path]", text)
    text = re.sub(r"(?i)(LOCAL_HOSTNAME=)[^&\s]+", r"\1[redacted]", text)
    text = re.sub(r"(?i)(CLIENT_SESSION=)[^&\s]+", r"\1[redacted]", text)
    return text


def _error_name(exc: BaseException) -> str:
    return exc.__class__.__name__


def _steam_path() -> str:
    try:
        return Millennium.steam_path() or ""
    except Exception:
        return ""


def _plugin_dir() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(os.path.realpath(__file__)), ".."))


def _public_path(filename: str) -> str:
    return os.path.join(_plugin_dir(), "public", filename)


def _source_public_path(filename: str) -> str:
    steam = _steam_path()
    candidates = [_public_path(filename)]
    if steam:
        candidates.extend(
            [
                os.path.join(steam, "plugins", PLUGIN_NAME, "public", filename),
                os.path.join(steam, "millennium", "plugins", PLUGIN_NAME, "public", filename),
            ]
        )
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return candidates[0]


def _steam_ui_path() -> str:
    steam = _steam_path()
    return os.path.join(steam, "steamui", WEBKIT_DIR_NAME) if steam else ""


def _copy_webkit_files() -> None:
    try:
        steam_ui_path = _steam_ui_path()
        if not steam_ui_path:
            _log("Steam path unavailable; skipped web UI copy")
            return
        os.makedirs(steam_ui_path, exist_ok=True)
        src = _source_public_path(WEB_UI_JS_FILE)
        dst = os.path.join(steam_ui_path, WEB_UI_JS_FILE)
        shutil.copy(src, dst)
        _log("copied web UI into Steam UI directory")
    except Exception as exc:
        _log(f"failed to copy web UI: {_error_name(exc)}")


def _inject_webkit_files() -> None:
    try:
        js_path = f"{WEBKIT_DIR_NAME}/{WEB_UI_JS_FILE}"
        Millennium.add_browser_js(js_path)
        _log(f"injected web UI: {js_path}")
    except Exception as exc:
        _log(f"failed to inject web UI: {_error_name(exc)}")


def _safe_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except Exception:
        return default
    return max(minimum, min(maximum, parsed))


def _file_signature(path: str) -> Tuple[int, int]:
    try:
        stat = os.stat(path)
        return int(stat.st_mtime_ns), int(stat.st_size)
    except Exception:
        return 0, -1


@lru_cache(maxsize=256)
def _read_text_file_cached(path: str, mtime_ns: int, size: int) -> str:
    if size < 0 or size > MAX_TEXT_FILE_BYTES:
        return ""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            return handle.read()
    except Exception:
        return ""


def _read_text_file(path: str) -> str:
    return _read_text_file_cached(path, *_file_signature(path))


def _parse_vdf_simple(content: str) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    stack: List[Dict[str, Any]] = [result]
    current_key: Optional[str] = None

    tokens: List[str] = []
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        tokens.extend(re.findall(r'"(?:\\.|[^"])*"|\{|\}', line))

    for raw_token in tokens:
        if raw_token == "{":
            if current_key:
                child: Dict[str, Any] = {}
                stack[-1][current_key] = child
                stack.append(child)
                current_key = None
            continue

        if raw_token == "}":
            if len(stack) > 1:
                stack.pop()
            current_key = None
            continue

        token = raw_token[1:-1].replace(r"\"", '"') if raw_token.startswith('"') else raw_token
        if current_key is None:
            current_key = token
        else:
            stack[-1][current_key] = token
            current_key = None

    return result


def _read_vdf(path: str) -> Dict[str, Any]:
    content = _read_text_file(path)
    return _parse_vdf_simple(content) if content else {}


def _current_account_ids() -> List[str]:
    steam = _steam_path()
    if not steam:
        return []
    data = _read_vdf(os.path.join(steam, "config", "loginusers.vdf"))
    users = data.get("users", {})
    if not isinstance(users, dict):
        return []

    ids: List[str] = []
    for steamid, user_data in users.items():
        if not isinstance(user_data, dict):
            continue
        if str(user_data.get("MostRecent", "0")) != "1":
            continue
        try:
            ids.append(str(int(steamid) & 0xFFFFFFFF))
        except Exception:
            continue
    return ids


def _current_user_ids() -> List[str]:
    account_ids = _current_account_ids()
    ordered: List[str] = []
    for account_id in account_ids:
        if account_id not in ordered:
            ordered.append(account_id)
    return ordered


def _localconfig_apps() -> Dict[str, Dict[str, Any]]:
    steam = _steam_path()
    if not steam:
        return {}
    for user_id in _current_user_ids():
        path = os.path.join(steam, "userdata", user_id, "config", "localconfig.vdf")
        data = _read_vdf(path)
        apps = (
            data.get("UserLocalConfigStore", {})
            .get("Software", {})
            .get("Valve", {})
            .get("Steam", {})
            .get("apps", {})
        )
        if isinstance(apps, dict) and apps:
            return apps
    return {}


def _stplug_dir() -> str:
    steam = _steam_path()
    return os.path.join(steam, "config", "stplug-in") if steam else ""


def _loaded_app_paths() -> List[str]:
    steam = _steam_path()
    if not steam:
        return []
    return [
        os.path.join(steam, "plugins", "luatools", "backend", "loadedappids.txt"),
        os.path.join(steam, "plugins", "ltsteamplugin", "backend", "loadedappids.txt"),
        os.path.join(steam, "millennium", "plugins", "luatools", "backend", "loadedappids.txt"),
        os.path.join(steam, "millennium", "plugins", "ltsteamplugin", "backend", "loadedappids.txt"),
    ]


def _parse_loaded_apps() -> Dict[int, str]:
    out: Dict[int, str] = {}
    for path in _loaded_app_paths():
        content = _read_text_file(path)
        if not content:
            continue
        for line in content.splitlines():
            if ":" not in line:
                continue
            appid_raw, name = line.split(":", 1)
            try:
                appid = int(appid_raw.strip())
            except Exception:
                continue
            if appid > 0 and name.strip():
                out[appid] = name.strip()
    return out


def _stplug_apps() -> Dict[int, Dict[str, Any]]:
    out: Dict[int, Dict[str, Any]] = {}
    stplug_dir = _stplug_dir()
    if not os.path.isdir(stplug_dir):
        return out

    try:
        names = os.listdir(stplug_dir)
    except Exception:
        return out

    for filename in names:
        match = re.match(r"^(\d+)\.lua(?:\.disabled)?$", filename)
        if not match:
            continue
        appid = int(match.group(1))
        path = os.path.join(stplug_dir, filename)
        mtime = 0
        try:
            mtime = int(os.path.getmtime(path))
        except Exception:
            pass
        out[appid] = {
            "appid": appid,
            "name": "",
            "enabled": not filename.endswith(".disabled"),
            "mtime": mtime,
        }
    return out


def _app_name_files() -> List[str]:
    steam = _steam_path()
    if not steam:
        return []
    return [
        os.path.join(steam, "plugins", "luatools", "backend", "temp_dl", "games.json"),
        os.path.join(steam, "millennium", "plugins", "ltsteamplugin", "backend", "temp_dl", "games.json"),
        os.path.join(steam, "plugins", "luatools", "backend", "temp_dl", "all-appids.json"),
        os.path.join(steam, "millennium", "plugins", "ltsteamplugin", "backend", "temp_dl", "all-appids.json"),
    ]


def _names_from_json_file(path: str, wanted: Iterable[int]) -> Dict[int, str]:
    wanted_set = set(wanted)
    if not wanted_set or not os.path.exists(path):
        return {}
    try:
        if os.path.getsize(path) > MAX_TEXT_FILE_BYTES:
            return {}
    except Exception:
        return {}

    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            data = json.load(handle)
    except Exception:
        return {}

    out: Dict[int, str] = {}
    if isinstance(data, dict):
        for appid, value in data.items():
            try:
                appid_int = int(appid)
            except Exception:
                continue
            if appid_int not in wanted_set:
                continue
            name = value.get("name") if isinstance(value, dict) else ""
            if isinstance(name, str) and name.strip():
                out[appid_int] = name.strip()
    elif isinstance(data, list):
        for row in data:
            if not isinstance(row, dict):
                continue
            try:
                appid_int = int(row.get("appid"))
            except Exception:
                continue
            if appid_int not in wanted_set:
                continue
            name = row.get("name")
            if isinstance(name, str) and name.strip():
                out[appid_int] = name.strip()

    return out


def _resolve_app_names(apps: Dict[int, Dict[str, Any]]) -> None:
    wanted = set(apps.keys())
    loaded_names = _parse_loaded_apps()
    for appid, name in loaded_names.items():
        if appid in apps and name:
            apps[appid]["name"] = name

    missing = {appid for appid, app in apps.items() if not app.get("name")}
    for path in _app_name_files():
        if not missing:
            break
        names = _names_from_json_file(path, missing)
        for appid, name in names.items():
            apps[appid]["name"] = name
            missing.discard(appid)

    for appid in missing:
        apps[appid]["name"] = f"App {appid}"


def _safe_local_int(local: Dict[str, Any], key: str) -> int:
    try:
        return int(local.get(key, 0) or 0)
    except Exception:
        return 0


def _lua_apps_with_activity() -> List[Dict[str, Any]]:
    apps = _stplug_apps()
    for appid, name in _parse_loaded_apps().items():
        apps.setdefault(appid, {"appid": appid, "name": name, "enabled": True, "mtime": int(time.time())})

    if not apps:
        return []

    local_apps = _localconfig_apps()
    for appid, app in apps.items():
        local = local_apps.get(str(appid), {})
        if isinstance(local, dict):
            app["lastPlayed"] = _safe_local_int(local, "LastPlayed")
            app["playtime"] = _safe_local_int(local, "Playtime")
            app["playtime2wks"] = _safe_local_int(local, "Playtime2wks")
        else:
            app["lastPlayed"] = 0
            app["playtime"] = 0
            app["playtime2wks"] = 0

    _resolve_app_names(apps)
    return list(apps.values())


def _lua_apps_ranked(max_apps: int) -> List[Dict[str, Any]]:
    ranked = _lua_apps_with_activity()
    ranked.sort(
        key=lambda app: (
            int(app.get("lastPlayed", 0) or 0),
            int(app.get("mtime", 0) or 0),
            int(app.get("playtime", 0) or 0),
        ),
        reverse=True,
    )
    return ranked[:max_apps]


def _stable_unit(value: str) -> float:
    digest = hashlib.sha1(value.encode("utf-8", errors="ignore")).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF


def _age_days(timestamp: int, now: int) -> Optional[float]:
    if timestamp <= 0:
        return None
    return max(0.0, (now - timestamp) / SECONDS_PER_DAY)


def _series_key(name: str) -> str:
    base = re.split(r"\s[-:|]\s", name.lower(), maxsplit=1)[0]
    base = re.sub(r"\b(definitive|deluxe|ultimate|complete|edition|remaster|remastered|directors?|cut)\b", " ", base)
    base = re.sub(r"\b[ivxlcdm]+\b|\b\d+\b", " ", base)
    words = [word for word in re.findall(r"[a-z0-9]+", base) if word not in {"the", "a", "an", "of"}]
    if not words:
        return str(name).lower().strip() or "unknown"
    return " ".join(words[:2])


def _play_next_score(app: Dict[str, Any], now: int) -> Tuple[float, str]:
    appid = int(app.get("appid", 0) or 0)
    last_played = int(app.get("lastPlayed", 0) or 0)
    playtime = int(app.get("playtime", 0) or 0)
    playtime_2wks = int(app.get("playtime2wks", 0) or 0)
    mtime = int(app.get("mtime", 0) or 0)
    score = 0.0
    bucket = "balanced"

    if last_played <= 0 and playtime <= 0:
        score += 72.0
        bucket = "unplayed"
    elif last_played <= 0:
        score += 52.0
        bucket = "untracked"
    else:
        days_since_played = _age_days(last_played, now) or 0.0
        if days_since_played >= 90:
            score += 48.0
            bucket = "neglected"
        elif days_since_played >= 30:
            score += 40.0
            bucket = "neglected"
        elif days_since_played >= 14:
            score += 30.0
            bucket = "cooldown"
        elif days_since_played >= 7:
            score += 8.0
            bucket = "recent"
        else:
            score -= 22.0 - min(days_since_played, 6.0)
            bucket = "too-recent"

    if playtime <= 0:
        score += 30.0
    elif playtime <= 120:
        score += 24.0
    elif playtime <= 600:
        score += 14.0
    elif playtime <= 2400:
        score += 4.0
    else:
        score -= 8.0

    if playtime_2wks > 0:
        score -= min(34.0, 12.0 + playtime_2wks / 60.0)

    days_since_file = _age_days(mtime, now)
    if days_since_file is not None:
        if days_since_file <= 7:
            score += 14.0
        elif days_since_file <= 30:
            score += 8.0
        elif days_since_file <= 90:
            score += 3.0

    if not app.get("enabled", True):
        score -= 45.0

    today = now // SECONDS_PER_DAY
    score += _stable_unit(f"{appid}:daily:{today}") * 7.0
    score += _stable_unit(f"{appid}:stable") * 2.0
    return score, bucket


def _diversify_play_next(apps: List[Dict[str, Any]], max_apps: int) -> List[Dict[str, Any]]:
    selected: List[Dict[str, Any]] = []
    seen_appids = set()
    series_counts: Dict[str, int] = {}

    for series_limit in (1, 2, 999):
        for app in apps:
            appid = int(app.get("appid", 0) or 0)
            if appid in seen_appids:
                continue
            series = str(app.get("seriesKey", "") or "unknown")
            if series_counts.get(series, 0) >= series_limit:
                continue
            selected.append(app)
            seen_appids.add(appid)
            series_counts[series] = series_counts.get(series, 0) + 1
            if len(selected) >= max_apps:
                return selected
    return selected


def _lua_apps_for_play_next(max_apps: int) -> List[Dict[str, Any]]:
    now = int(time.time())
    ranked = []
    for app in _lua_apps_with_activity():
        if not app.get("enabled", True):
            continue
        score, bucket = _play_next_score(app, now)
        app["playNextScore"] = round(score, 3)
        app["playNextBucket"] = bucket
        app["seriesKey"] = _series_key(str(app.get("name", "") or ""))
        ranked.append(app)

    ranked.sort(
        key=lambda app: (
            float(app.get("playNextScore", 0.0) or 0.0),
            int(app.get("mtime", 0) or 0),
            int(app.get("appid", 0) or 0),
        ),
        reverse=True,
    )
    return _diversify_play_next(ranked, max_apps)


def _url_host(url: str) -> str:
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return ""
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        return ""
    return (parsed.hostname or "").lower()


def _is_allowed_steam_url(url: str) -> bool:
    host = _url_host(url)
    if not host:
        return False
    return host in ALLOWED_STEAM_HOSTS or any(host.endswith(suffix) for suffix in ALLOWED_STEAM_HOST_SUFFIXES)


def _normalize_allowed_url(base_url: str, maybe_url: str) -> str:
    candidate = urllib.parse.urljoin(base_url, (maybe_url or "").strip())
    return candidate if _is_allowed_steam_url(candidate) else ""


def _request_json(url: str, timeout: int = HTTP_TIMEOUT_SECONDS) -> Dict[str, Any]:
    if not _is_allowed_steam_url(url):
        raise ValueError("Blocked non-Steam URL")
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json,text/plain,*/*",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Steam LuaTools Whats New",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read(3 * 1024 * 1024)
    return json.loads(raw.decode("utf-8", errors="replace"))


def _request_text(url: str, timeout: int = HTTP_TIMEOUT_SECONDS) -> str:
    if not _is_allowed_steam_url(url):
        raise ValueError("Blocked non-Steam URL")
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "text/html,text/plain,*/*",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Steam LuaTools Whats New",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read(2 * 1024 * 1024)
        charset = response.headers.get_content_charset() or "utf-8"
    return raw.decode(charset, errors="replace")


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


def _redirect_location(url: str, timeout: int = 7) -> str:
    if not url or not _is_allowed_steam_url(url):
        return ""
    if url in REDIRECT_CACHE:
        return REDIRECT_CACHE[url]

    location = ""
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "text/html,text/plain,*/*",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Steam LuaTools Whats New",
        },
    )
    opener = urllib.request.build_opener(_NoRedirectHandler)
    try:
        with opener.open(req, timeout=timeout) as response:
            location = response.geturl()
    except urllib.error.HTTPError as exc:
        if 300 <= exc.code < 400:
            location = exc.headers.get("Location", "") or exc.geturl()
        else:
            location = ""
    except Exception:
        location = ""

    if location:
        location = _normalize_allowed_url(url, location)
    REDIRECT_CACHE[url] = location
    return location


def _partner_ids_from_url(url: str) -> Tuple[str, str]:
    if not url:
        return "", ""

    announcement_gid = ""
    event_gid = ""
    for candidate in (_redirect_location(url), url):
        if not candidate:
            continue
        match = re.search(r"/announcements/detail/(\d+)", candidate)
        if match and not announcement_gid:
            announcement_gid = match.group(1)
        match = re.search(r"/news/app/\d+/view/(\d+)", candidate)
        if match and not event_gid:
            event_gid = match.group(1)
    return announcement_gid, event_gid


def _strip_html(value: str) -> str:
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", value or "", flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _extract_og_image(url: str) -> str:
    if not url:
        return ""
    if url in IMAGE_CACHE:
        return IMAGE_CACHE[url]

    image = ""
    try:
        page = _request_text(url, timeout=7)
        patterns = [
            r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
            r'<link[^>]+rel=["\']image_src["\'][^>]+href=["\']([^"\']+)["\']',
        ]
        for pattern in patterns:
            match = re.search(pattern, page, re.I)
            if match:
                image = _normalize_allowed_url(url, html.unescape(match.group(1).strip()))
                break
    except Exception:
        image = ""

    IMAGE_CACHE[url] = image
    return image


def _fallback_image(appid: int) -> str:
    return f"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appid}/capsule_616x353.jpg"


def _fetch_app_news(app: Dict[str, Any], per_app: int) -> List[Dict[str, Any]]:
    appid = int(app["appid"])
    query = urllib.parse.urlencode(
        {
            "appid": appid,
            "count": per_app,
            "feeds": "steam_community_announcements",
            "maxlength": 700,
            "format": "json",
        }
    )
    url = f"https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?{query}"
    data = _request_json(url)
    rows = data.get("appnews", {}).get("newsitems", [])
    if not isinstance(rows, list):
        return []

    out: List[Dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = str(row.get("title", "") or "").strip()
        news_url = str(row.get("url", "") or "").strip()
        if not title or not news_url or not _is_allowed_steam_url(news_url):
            continue
        try:
            date = int(row.get("date", 0) or 0)
        except Exception:
            date = 0
        contents = _strip_html(str(row.get("contents", "") or ""))
        out.append(
            {
                "appid": appid,
                "appName": str(app.get("name") or f"App {appid}"),
                "externalGID": str(row.get("gid", "") or ""),
                "title": html.unescape(title),
                "url": news_url,
                "contents": contents[:260],
                "date": date,
                "author": str(row.get("author", "") or row.get("feedlabel", "") or ""),
                "feedLabel": str(row.get("feedlabel", "") or ""),
                "image": "",
            }
        )
    return out


def _fetch_news_for_apps(apps: List[Dict[str, Any]], per_app: int) -> Tuple[List[Dict[str, Any]], List[str]]:
    items: List[Dict[str, Any]] = []
    errors: List[str] = []
    if not apps:
        return items, errors

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_fetch_app_news, app, per_app): app for app in apps}
        for future in as_completed(futures):
            app = futures[future]
            try:
                items.extend(future.result())
            except Exception as exc:
                errors.append(f"{app.get('appid')}: {_error_name(exc)}")

    return items, errors


def _attach_images(items: List[Dict[str, Any]]) -> None:
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_extract_og_image, item.get("url", "")): item for item in items}
        for future in as_completed(futures):
            item = futures[future]
            appid = int(item.get("appid", 0) or 0)
            try:
                image = future.result()
            except Exception:
                image = ""
            item["image"] = image or _fallback_image(appid)


def _attach_partner_ids(items: List[Dict[str, Any]]) -> None:
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_partner_ids_from_url, item.get("url", "")): item for item in items}
        for future in as_completed(futures):
            item = futures[future]
            try:
                announcement_gid, event_gid = future.result()
            except Exception:
                announcement_gid, event_gid = "", ""
            item["announcementGID"] = announcement_gid
            item["eventGID"] = event_gid


def _client_app_summary(app: Dict[str, Any]) -> Dict[str, Any]:
    appid = int(app.get("appid", 0) or 0)
    summary: Dict[str, Any] = {
        "appid": appid,
        "name": str(app.get("name") or f"App {appid}"),
    }
    if app.get("playNextBucket"):
        summary["playNextBucket"] = str(app.get("playNextBucket"))
    return summary


def ReadLuaToolsApps(
    maxApps: Any = MAX_APPS_DEFAULT,
    strategy: Any = PLAY_NEXT_STRATEGY,
    contentScriptQuery: str = "",
    **kwargs: Any,
) -> str:
    if "maxApps" in kwargs:
        maxApps = kwargs.get("maxApps")
    if "strategy" in kwargs:
        strategy = kwargs.get("strategy")
    max_apps = _safe_int(maxApps, MAX_APPS_DEFAULT, 1, 200)
    strategy_name = str(strategy or PLAY_NEXT_STRATEGY)
    apps = _lua_apps_for_play_next(max_apps) if strategy_name == PLAY_NEXT_STRATEGY else _lua_apps_ranked(max_apps)
    buckets: Dict[str, int] = {}
    for app in apps:
        bucket = str(app.get("playNextBucket", "") or "ranked")
        buckets[bucket] = buckets.get(bucket, 0) + 1
    client_apps = [_client_app_summary(app) for app in apps]
    return json.dumps(
        {
            "success": True,
            "strategy": strategy_name,
            "count": len(client_apps),
            "buckets": buckets,
            "apps": client_apps,
        },
        ensure_ascii=False,
    )


def GetLuaToolsNews(
    maxItems: Any = MAX_ITEMS_DEFAULT,
    perApp: Any = PER_APP_DEFAULT,
    maxApps: Any = MAX_APPS_DEFAULT,
    refresh: Any = False,
    contentScriptQuery: str = "",
    **kwargs: Any,
) -> str:
    if "maxItems" in kwargs:
        maxItems = kwargs.get("maxItems")
    if "perApp" in kwargs:
        perApp = kwargs.get("perApp")
    if "maxApps" in kwargs:
        maxApps = kwargs.get("maxApps")
    if "refresh" in kwargs:
        refresh = kwargs.get("refresh")

    max_items = _safe_int(maxItems, MAX_ITEMS_DEFAULT, 1, 40)
    per_app = _safe_int(perApp, PER_APP_DEFAULT, 1, 6)
    max_apps = _safe_int(maxApps, MAX_APPS_DEFAULT, 1, 200)
    force_refresh = str(refresh).lower() in ("1", "true", "yes")

    apps = _lua_apps_ranked(max_apps)
    app_key = ",".join(str(app["appid"]) for app in apps)
    cache_key = f"{max_items}|{per_app}|{max_apps}|{app_key}"
    now = int(time.time())
    if not force_refresh and NEWS_CACHE.get("key") == cache_key and now - int(NEWS_CACHE.get("time", 0)) < CACHE_SECONDS:
        return str(NEWS_CACHE.get("payload", ""))

    items, errors = _fetch_news_for_apps(apps, per_app)
    items.sort(key=lambda item: int(item.get("date", 0) or 0), reverse=True)
    items = items[:max_items]
    _attach_images(items)

    payload = json.dumps(
        {
            "success": True,
            "generatedAt": now,
            "source": "stplug-in",
            "appCount": len(apps),
            "itemCount": len(items),
            "errors": errors[:8],
            "items": items,
        },
        ensure_ascii=False,
    )
    NEWS_CACHE.update({"key": cache_key, "time": now, "payload": payload})
    _log(f"served {len(items)} news items from {len(apps)} LuaTools apps")
    return payload


def GetLuaToolsNativeNews(
    maxItems: Any = MAX_ITEMS_DEFAULT,
    perApp: Any = PER_APP_DEFAULT,
    maxApps: Any = MAX_APPS_DEFAULT,
    refresh: Any = False,
    contentScriptQuery: str = "",
    **kwargs: Any,
) -> str:
    if "maxItems" in kwargs:
        maxItems = kwargs.get("maxItems")
    if "perApp" in kwargs:
        perApp = kwargs.get("perApp")
    if "maxApps" in kwargs:
        maxApps = kwargs.get("maxApps")
    if "refresh" in kwargs:
        refresh = kwargs.get("refresh")

    max_items = _safe_int(maxItems, MAX_ITEMS_DEFAULT, 1, 40)
    per_app = _safe_int(perApp, PER_APP_DEFAULT, 1, 6)
    max_apps = _safe_int(maxApps, MAX_APPS_DEFAULT, 1, 200)
    force_refresh = str(refresh).lower() in ("1", "true", "yes")

    apps = _lua_apps_ranked(max_apps)
    app_key = ",".join(str(app["appid"]) for app in apps)
    cache_key = f"native|{max_items}|{per_app}|{max_apps}|{app_key}"
    now = int(time.time())
    if not force_refresh and NATIVE_NEWS_CACHE.get("key") == cache_key and now - int(NATIVE_NEWS_CACHE.get("time", 0)) < CACHE_SECONDS:
        return str(NATIVE_NEWS_CACHE.get("payload", ""))

    items, errors = _fetch_news_for_apps(apps, per_app)
    items.sort(key=lambda item: int(item.get("date", 0) or 0), reverse=True)
    items = items[:max_items]
    _attach_partner_ids(items)
    native_items = [
        item
        for item in items
        if str(item.get("announcementGID", "") or "") or str(item.get("eventGID", "") or "")
    ]

    payload = json.dumps(
        {
            "success": True,
            "generatedAt": now,
            "source": "stplug-in-native",
            "appCount": len(apps),
            "itemCount": len(native_items),
            "errors": errors[:8],
            "items": native_items,
        },
        ensure_ascii=False,
    )
    NATIVE_NEWS_CACHE.update({"key": cache_key, "time": now, "payload": payload})
    _log(f"served {len(native_items)} native news ids from {len(apps)} LuaTools apps")
    return payload
