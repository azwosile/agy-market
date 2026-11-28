export function makeUiSandbox(window, fetch, selectors = {}) {
  const document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: null,
    documentElement: { setAttribute: () => {}, classList: { toggle: () => {} } },
    body: { classList: { toggle: () => {} } },
    addEventListener: () => {},
    ...selectors,
  };
  const sandbox = {
    window, self: window, document, fetch, URL, URLSearchParams, Headers, Response, console,
    setTimeout: () => 1,
    clearTimeout: () => {},
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}
