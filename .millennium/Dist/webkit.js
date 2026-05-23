(() => {
  if (window.__ToolsWhatsNewWebkitShimLoaded) return;
  window.__ToolsWhatsNewWebkitShimLoaded = true;

  const current = document.currentScript && document.currentScript.src;
  if (!current) {
    console.warn("[Tools What's New] Webkit shim missing current script URL");
    return;
  }
  const script = document.createElement("script");
  script.src = new URL("../../public/tools-whats-new.js", current).href;
  script.onload = () => console.log("[Tools What's New] Webkit shim loaded");
  document.documentElement.appendChild(script);
})();
