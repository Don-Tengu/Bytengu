#!/bin/bash
node -e 'const net=require("net"); const s=net.connect({host:"1.1.1.1",port:443,family:4}); s.on("connect",()=>{console.log("connected");process.exit(0)}); s.on("error",(e)=>{console.log(e.code||e.message);process.exit(2)})'
