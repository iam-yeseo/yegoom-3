// Only an installed app (home screen) shows the splash; a browser tab drops it at once.
// Loaded synchronously right after #splash so a tab never paints it.
if (!(window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true)) {
  var splash = document.getElementById("splash");
  if (splash) splash.remove();
}
