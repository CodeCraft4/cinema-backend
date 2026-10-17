const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getApiKeys: () => ipcRenderer.invoke("get-api-keys"),
  getNetworkStatus: () => ipcRenderer.invoke("get-network-status"),
  searchMovies: (query, meta) => ipcRenderer.invoke("search-movies", query, meta || {}),
  searchTmdb: (payload) => ipcRenderer.invoke("search-tmdb", payload),
  getMediaLanguages: (items) => ipcRenderer.invoke("get-media-languages", items),
  getTmdbCountries: () => ipcRenderer.invoke("get-tmdb-countries"),
  discoverTmdb: (payload) => ipcRenderer.invoke("discover-tmdb", payload),
  getTvShows: (payload) => ipcRenderer.invoke("get-tv-shows", payload),
  getTvCategories: () => ipcRenderer.invoke("get-tv-categories"),
  getTvShowsByGenre: (payload) => ipcRenderer.invoke("get-tv-shows-by-genre", payload),
  getTvDetails: (payload) => ipcRenderer.invoke("get-tv-details", payload),
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  getConfig: () => ipcRenderer.invoke("get-config"),
  getActiveDownloads: () => ipcRenderer.invoke("get-active-downloads"),
  getMoviesByYear: (payload) => ipcRenderer.invoke("get-movies-by-year", payload),
  getPopularMovies: (payload) => ipcRenderer.invoke("get-popular-movies", payload),
  clearCaches: () => ipcRenderer.invoke("clear-caches"),
  resolvePoster: (payload) => ipcRenderer.invoke("resolve-poster", payload),
  getWatchmodePoster: (title) => ipcRenderer.invoke("get-watchmode-poster", title),
  hideDownload: (id) => ipcRenderer.send("hide-download", id),

  startDownload: (torrent) => ipcRenderer.send("start-download", torrent),
  pauseDownload: (magnet) => ipcRenderer.send("pause-download", magnet),
  resumeDownload: (torrent) => ipcRenderer.send("resume-download", torrent),
  cancelDownload: (magnet) => ipcRenderer.send("cancel-download", magnet),

  showItemInFolder: (path) => ipcRenderer.send("show-in-folder", path),
  previewFile: (id) => ipcRenderer.send("preview-file", id),
  openPreview: (id) => ipcRenderer.invoke("open-preview", id),
  openLocalPreview: (filePath, title) => ipcRenderer.invoke("open-local-preview", { filePath, title }),
  openExternalVideo: (filePath) => ipcRenderer.invoke("open-external-video", filePath),
  closePreview: (id) => ipcRenderer.send("close-preview", id),

  onStarted: (callback) =>
    ipcRenderer.on("download-started", (event, data) => callback(data)),
  onProgress: (callback) =>
    ipcRenderer.on("download-progress", (event, data) => callback(data)),
  onComplete: (callback) =>
    ipcRenderer.on("download-complete", (event, data) => callback(data)),
  onError: (callback) =>
    ipcRenderer.on("download-error", (event, data) => callback(data)),
  onUpdateMessage: (callback) =>
    ipcRenderer.on("update-message", (event, msg) => callback(msg)),
  onUpdateStatus: (callback) =>
    ipcRenderer.on("update-status", (event, text) => callback(text)),
  onRestore: (callback) =>
    ipcRenderer.on("restore-downloads", (event, data) => callback(data)),
  onPreviewRequest: (callback) =>
    ipcRenderer.on("preview-request", (event, data) => callback(data)),
});
