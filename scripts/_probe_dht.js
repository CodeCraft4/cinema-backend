const DHT=require("bittorrent-dht/client");
const net=require("net");
const ih=process.argv[2].toLowerCase();
const dht=new DHT();
dht.on("peer",(peer,hash)=>{
  if(hash.toString("hex")!==ih) return;
  console.log("DHT peer",peer.host+":"+peer.port);
});
dht.on("error",e=>console.log("dht err",e.message));
dht.on("warning",e=>console.log("dht warn",e.message));
dht.listen(0,()=>{
  console.log("dht listening", dht._port);
  dht.announce(ih,6881,(err)=>{
    console.log("announce done", err&&err.message);
  });
});
setTimeout(()=>{console.log("done");process.exit(0)},30000);
