(() => {
  if (window.__LuaToolsWhatsNewWebkitShimLoaded) return;
  window.__LuaToolsWhatsNewWebkitShimLoaded = true;

  const current = document.currentScript && document.currentScript.src;
  if (!current) {
    console.warn("[LuaTools What's New] Webkit shim missing current script URL");
    return;
  }
  const script = document.createElement("script");
  script.src = new URL("../../public/luatools-whats-new.js", current).href;
  script.onload = () => console.log("[LuaTools What's New] Webkit shim loaded");
  document.documentElement.appendChild(script);
})();
