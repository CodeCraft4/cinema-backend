const https = require("https");
const http = require("http");
const { URL } = require("url");
const fs = require("fs");

const HASH = (process.argv[2] || "57F2CB6581A272565E9BD5C406F2A3DA718E5F1A").toUpperCase();
const OUT = process.argv[3] || ".torrent_cache/fail.torrent";

function get(url, n = 0) {
  return new Promise((res, rej) => {
    const lib = url.startsWith("http://") ? http : https;
    lib.get(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && n < 8) {
        r.resume();
        return res(get(new URL(r.headers.location, url).toString(), n + 1));
      }
      const c = [];
      r.on("data", (d) => c.push(d));
      r.on("end", () => res({ status: r.statusCode, body: Buffer.concat(c) }));
    }).on("error", rej);
  });
}

(async () => {
  const url = `https://itorrents.org/torrent/${HASH}.torrent`;
  try {
    const r = await get(url);
    console.log("status", r.status, "len", r.body.length, "first", JSON.stringify(r.body.slice(0, 16).toString("latin1")));
    if (r.body[0] === 0x64) {
      fs.writeFileSync(OUT, r.body);
      const b = require("bencode");
      const t = b.decode(r.body);
      const crypto = require("crypto");
      const ih = crypto.createHash("sha1").update(b.encode(t.info)).digest("hex");
      console.log("name:", t.info.name, "| len:", t.info.length, "| pieces:", (t.info.pieces || "").length / 20);
      console.log("computed infoHash:", ih, "| expected:", HASH.toLowerCase());
      console.log("announce:", JSON.stringify(t.announce));
      console.log("announce-list:", JSON.stringify(t["announce-list"]));
    }
  } catch (e) {
    console.log("ERR", e.message);
  }
})();

