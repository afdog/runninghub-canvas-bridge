// Modified 2026-09-27: international site validation.
// Modified 2026-10-30: load after in-app navigation from a RunningHub home page.
(() => {
  const policy = globalThis.RHCanvasSitePolicy;
  if (!policy) return;
  window.__RUNNINGHUB_CANVAS_BRIDGE_BROWSER_SOURCE__ = "browser-extension";
  const BRIDGE = "http://127.0.0.1:18765";
  const LOADER_KEY = "__RUNNINGHUB_CANVAS_BRIDGE_LOADER__";
  const LOADER_VERSION = "0.10.9";
  const PROTOCOL_VERSION = "1";

  // RunningHub changes routes without loading a new document. Keep one watcher
  // on its already-permitted origins; fetch the bridge only on a canvas route.
  if (window[LOADER_KEY]?.watching) {
    window[LOADER_KEY].check();
    return;
  }
  const state = { watching: true, loading: false, loadedAt: 0, canvasKey: null, error: null, retryAt: 0, failures: 0 };
  window[LOADER_KEY] = state;
  window.__RUNNINGHUB_CANVAS_BRIDGE_LOADER_VERSION__ = LOADER_VERSION;
  window.__RUNNINGHUB_CANVAS_BRIDGE_PROTOCOL_VERSION__ = PROTOCOL_VERSION;

  const domReady = () => document.body ? Promise.resolve() : new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  const check = async () => {
    const key = policy.parseCanvas(location.href)?.key;
    if (!key || state.loading || state.canvasKey === key || state.retryCanvas === key && Date.now() < state.retryAt) return;
    state.loading = true;
    try {
      const response = await fetch(`${BRIDGE}/bridge-runtime.js?ts=${Date.now()}`, { mode: "cors", cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Failed to load bridge runtime: ${response.status}`);
      const code = await response.text();
      await domReady();
      // An old response must not attach to a different canvas or the home page.
      if (policy.parseCanvas(location.href)?.key !== key) return;
      new Function(`${code}\n//# sourceURL=runninghub-canvas-bridge-runtime.js`)();
      Object.assign(state, { loadedAt: Date.now(), canvasKey: key, error: null, failures: 0, retryAt: 0 });
    } catch (error) {
      state.error = error && error.stack ? error.stack : String(error);
      state.retryCanvas = key;
      state.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(state.failures++, 5));
      console.warn("[RunningHub Canvas Bridge] runtime load failed; will retry", error);
    } finally {
      state.loading = false;
      if (policy.parseCanvas(location.href)?.key && policy.parseCanvas(location.href)?.key !== key) void check();
    }
  };
  state.check = check;
  window.addEventListener("popstate", check);
  window.addEventListener("pageshow", check);
  document.addEventListener("visibilitychange", check);
  setInterval(check, 1000);
  void check();
})();
