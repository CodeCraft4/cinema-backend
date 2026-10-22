const fs = require("fs");
const path = require("path");
const torrentStream = require("torrent-stream");

const file = process.argv[2];
const buf = fs.readFileSync(file);
const storagePath = path.join(process.cwd(), ".torrent_cache", "probe_video");
fs.mkdirSync(storagePath, { recursive: true });

const t0 = Date.now();
const engine = torrentStream(buf, {
  connections: 35,
  uploads: 2,
  path: storagePath,
  trackers: [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://open.stealth.si:80/announce",
  ],
  verify: false,
  dht: true,
});

console.log("swarm.peerId length:", engine.swarm.peerId.length);

let peerEvents = 0;
const wireAddrs = new Set();
engine.on("peer", (addr) => { peerEvents++; });
engine.on("wire", (wire) => { wireAddrs.add(wire.peerAddress); });
engine.on("error", (e) => console.log(`[${Date.now() - t0}ms] ERROR`, e.message));
engine.on("ready", () => console.log(`[${Date.now() - t0}ms] READY files=`, (engine.files || []).map((f) => f.name).join(",")));

let pieceCount = 0;
engine.on("download", () => { pieceCount++; });

const iv = setInterval(() => {
  const wires = (engine.swarm && engine.swarm.wires) || [];
  console.log(`[${Date.now() - t0}ms] STAT peerEvents=${peerEvents} wires=${wires.length} downloaded=${engine.swarm.downloaded} pieces=${pieceCount}`);
}, 4000);

// Once ready, try streaming the mp4 via createReadStream (range read)
engine.on("ready", () => {
  setTimeout(() => {
    const f = (engine.files || []).find((x) => /\.mp4$/i.test(x.name));
    if (!f) { console.log("NO MP4"); process.exit(1); }
    console.log("target file:", f.name, f.length);
    const rs = f.createReadStream({ start: 0, end: 1023 * 1024 - 1 });
    let got = 0;
    rs.on("data", (c) => { got += c.length; });
    rs.on("end", () => {
      console.log(`[${Date.now() - t0}ms] RANGE-READ OK bytes=${got} (expect 1048576)`);
      clearInterval(iv);
      console.log("=== FINAL === peerEvents:", peerEvents, "wires:", (engine.swarm.wires || []).length, "downloaded:", engine.swarm.downloaded, "pieces:", pieceCount);
      try { engine.destroy(); } catch (e) {}
      process.exit(0);
    });
    rs.on("error", (e) => {
      console.log(`[${Date.now() - t0}ms] RANGE-READ ERROR`, e.message);
      clearInterval(iv);
      console.log("=== FINAL === peerEvents:", peerEvents, "wires:", (engine.swarm.wires || []).length, "downloaded:", engine.swarm.downloaded);
      try { engine.destroy(); } catch (e) {}
      process.exit(2);
    });
  }, 8000);
});

setTimeout(() => {
  clearInterval(iv);
  console.log("=== TIMEOUT FINAL === peerEvents:", peerEvents, "wires:", (engine.swarm.wires || []).length, "downloaded:", engine.swarm.downloaded);
  try { engine.destroy(); } catch (e) {}
  process.exit(3);
}, 60000);
