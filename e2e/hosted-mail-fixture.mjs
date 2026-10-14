// Local SMTP sink: no relay and no external connections. Only the known synthetic
// recovery recipient is accepted; the test reads mail actually sent by nodemailer.
import net from "node:net";
import http from "node:http";
import assert from "node:assert/strict";
const messages=[];
function decodeSubject(raw){
 const unfolded=raw.replace(/\r\n[ \t]+/g," ");
 const subject=/^Subject:\s*(.*)$/mi.exec(unfolded)?.[1]??"";
 return subject.replace(/=\?utf-8\?([bq])\?([^?]+)\?=/gi,(_,kind,text)=>kind.toLowerCase()==="b"?Buffer.from(text,"base64").toString("utf8"):Buffer.from(text.replace(/_/g," ").replace(/=([0-9a-f]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16))),"latin1").toString("utf8"));
}
const smtp=net.createServer(socket=>{
 socket.setTimeout(30000,()=>socket.destroy());socket.on("error",()=>{});
 let buffer="",authenticated=false,recipient="",data=false,lines=[];
 socket.write("220 localhost CRM QA SMTP\r\n");
 socket.on("data",chunk=>{
  buffer+=chunk.toString("utf8");let end;
  while((end=buffer.indexOf("\r\n"))>=0){
   const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
   if(data){
    if(line!=="."){lines.push(line);continue;}
    messages.push({recipient,subject:decodeSubject(lines.join("\r\n"))});data=false;lines=[];socket.write("250 accepted into isolated QA mailbox\r\n");continue;
   }
   if(/^(EHLO|HELO) /i.test(line))socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
   else if(/^AUTH PLAIN /i.test(line)){
    authenticated=Buffer.from(line.slice(11),"base64").toString()==="\0hosted-e2e\0local-mail-fixture-only";
    socket.write(authenticated?"235 authenticated\r\n":"535 invalid fixture credentials\r\n");
   }else if(/^MAIL FROM:/i.test(line))socket.write(authenticated?"250 sender accepted\r\n":"530 authentication required\r\n");
   else if(/^RCPT TO:/i.test(line)){
    recipient=/<([^>]+)>/.exec(line)?.[1]??"";
    socket.write(authenticated&&recipient==="trial@e2e.local"?"250 recipient accepted\r\n":"550 only synthetic fixture recipient allowed\r\n");
   }else if(/^DATA$/i.test(line)&&authenticated&&recipient==="trial@e2e.local"){data=true;socket.write("354 end with dot\r\n");}
   else if(/^QUIT$/i.test(line)){socket.end("221 closing\r\n");}
   else if(/^(RSET|NOOP)$/i.test(line))socket.write("250 ok\r\n");
   else socket.write("500 unsupported fixture command\r\n");
  }
 });
});
const mailbox=http.createServer((req,res)=>{
 res.setHeader("Content-Type","application/json");
 if(req.url==="/health")res.end(JSON.stringify({ok:true}));
 else if(req.url==="/messages")res.end(JSON.stringify(messages));
 else {res.statusCode=404;res.end("{}");}
});
const smtpPort=Number(process.env.HOSTED_SMTP_PORT),mailboxPort=Number(process.env.HOSTED_MAILBOX_PORT);
assert(smtpPort>1024&&mailboxPort>1024&&smtpPort!==mailboxPort);
smtp.listen(smtpPort,"127.0.0.1");mailbox.listen(mailboxPort,"127.0.0.1");
function stop(){smtp.close();mailbox.close();}
process.on("SIGTERM",stop);process.on("SIGINT",stop);
