const Tracker=require("torrent-stream/node_modules/bittorrent-tracker/client");
const ih=process.argv[2].toLowerCase();
const c=new Tracker("-TS0008-12345678901234567890",6881,{infoHash:ih,announce:["udp://tracker.opentrackr.org:1337/announce"],length:0},{});
c.on("peer",a=>console.log("PEER",a));
c.on("update",u=>console.log("UPDATE",u));
c.on("warning",e=>console.log("WARN",e.message));
c.on("error",e=>console.log("ERR",e.message));
c.start();
setTimeout(()=>process.exit(0),20000);
