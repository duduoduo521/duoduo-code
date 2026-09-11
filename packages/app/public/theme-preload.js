;(function () {
  var THEME_ID_KEY = "duoduo-theme-id"
  var COLOR_SCHEME_KEY = "duoduo-color-scheme"
  var THEME_CSS_PREFIX = "duoduo-theme-css-"

  var DEFAULT_THEME_ID = "dawn"
  // Earlier builds shipped 37 themes (oc-2, tokyonight, …) whose ids can still
  // sit in localStorage. Those files are gone, so anything unknown is migrated
  // to the default — otherwise returning users would get an unstyled first paint.
  var KNOWN_THEMES = ["dawn", "cinnabar", "celadon", "violet"]

  var storedId = localStorage.getItem(THEME_ID_KEY)
  var themeId = storedId && KNOWN_THEMES.indexOf(storedId) !== -1 ? storedId : DEFAULT_THEME_ID

  if (storedId !== themeId) {
    localStorage.setItem(THEME_ID_KEY, themeId)
    localStorage.removeItem(THEME_CSS_PREFIX + "light")
    localStorage.removeItem(THEME_CSS_PREFIX + "dark")
  }

  var scheme = localStorage.getItem(COLOR_SCHEME_KEY) || "system"

  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode

  // Set background-color on <html> to match the splash screen background
  // so the Overlay title bar (macOS) and the initial viewport never flash
  // a wrong color before theme CSS loads.
  // These mirror the `dawn` tokens baked into styles/theme.css — keep in sync
  // (regenerate via `bun run gen-theme-fallback.ts`).
  document.documentElement.style.backgroundColor = isDark ? "#0a0d12" : "#f6f8fb"

  // The zero theme is already baked into styles/theme.css.
  if (themeId === DEFAULT_THEME_ID) return

  var css = localStorage.getItem(THEME_CSS_PREFIX + mode)

  if (css) {
    var style = document.createElement("style")
    style.id = "duoduo-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
