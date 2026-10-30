// Register only built deployments; Vite's live development source must not be cached.
if ('serviceWorker' in navigator && !document.querySelector('script[src="/src/main.tsx"]')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Installation is optional. Online play remains available if storage is full.
    });
  });
}
