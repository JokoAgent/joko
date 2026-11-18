(() => {
  const theme = window.jokoDesktop?.window?.startupTheme;
  if (theme !== "dark" && theme !== "light" && theme !== "system") return;
  document.documentElement.dataset.theme = theme;
  const dark = theme === "dark" || theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0d0d0d" : "#f2f2f2");
})();
