const fs=require("fs");
const parse=require("parse-torrent-file");
const t=parse(fs.readFileSync(".torrent_cache/fail.torrent"));
console.log(t.announce.length);
fs.writeFileSync(".torrent_cache/announce_fail.json", JSON.stringify(t.announce,null,1));
