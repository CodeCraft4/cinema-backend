"use strict";

/**
 * Audio remux for streams whose audio the phone cannot decode.
 *
 * Many releases are H.264 video + Dolby (AC3 / E-AC3 / DTS) audio. Android phones decode the
 * video but not the audio, so ExoPlayer errors out. ffmpeg copies the video untouched (almost no
 * CPU) and converts only the chosen audio track to AAC stereo, streamed straight to the app.
 * Needs ffmpeg on the server (apt-get install -y ffmpeg); without it nothing here is used.
 */

const { spawn, spawnSync } = require("child_process");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const MAX_CONCURRENT = Number(process.env.REMUX_MAX_CONCURRENT || 3);
const ALLOWED_HOST_RE = /(^|\.)tb-cdn\.pw$/i; // only TorBox CDN links can be remuxed (no open proxy)

let available = null;
let running = 0;

function isAvailable() {
  if (available !== null) return available;
  try {
    available = spawnSync(FFMPEG, ["-version"], { timeout: 4000 }).status === 0;
  } catch {
    available = false;
  }
  return available;
}

function isAllowedSource(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

/** Pipe `url` to `res` with the audio track `audioIndex` converted to AAC. Video is copied. */
function streamRemuxed(url, audioIndex, res, { startSeconds = 0 } = {}) {
  if (running >= MAX_CONCURRENT) {
    res.status(503).json({ ok: false, error: "Remux is busy. Try again in a moment." });
    return;
  }
  const args = ["-hide_banner", "-loglevel", "error", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "4", "-user_agent", "Mozilla/5.0"];
  if (startSeconds > 0) args.push("-ss", String(startSeconds));
  args.push("-i", url, "-map", "0:v:0", "-map", `0:a:${Math.max(0, Number(audioIndex) || 0)}`, "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-f", "matroska", "pipe:1");

  const ff = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
  running += 1;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    running = Math.max(0, running - 1);
    try {
      ff.kill("SIGKILL");
    } catch {
      // already gone
    }
  };

  res.status(200);
  res.setHeader("Content-Type", "video/x-matroska");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Accept-Ranges", "none");
  ff.stdout.pipe(res);
  ff.stderr.on("data", (d) => console.warn("[remux]", String(d).trim().slice(0, 200)));
  ff.on("error", (err) => {
    console.warn("[remux] ffmpeg failed to start:", err.message);
    available = false;
    if (!res.headersSent) res.status(500).end();
    done();
  });
  ff.on("close", done);
  res.on("close", done);
}

module.exports = { isAvailable, isAllowedSource, streamRemuxed };
