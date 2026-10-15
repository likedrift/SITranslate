import {createHash} from 'node:crypto';
export function mockASR(server){
  const clients=new Set(),sessions=new Map(),stats={authorized:0,unauthorized:0,frames:0,audioBytes:0,audioMs:0,nonzero:false,config:null,binaryFrames:0,legacyFrames:0,streamingStarts:0,streamingFinishes:0,prematureFrames:0,protocolErrors:0,lastRun:null,urls:[]};let readyDelay=0;
  function send(socket,data){const payload=Buffer.from(JSON.stringify(data));const head=Buffer.alloc(payload.length<126?2:4);head[0]=0x81;if(payload.length<126)head[1]=payload.length;else{head[1]=126;head.writeUInt16BE(payload.length,2);}socket.write(Buffer.concat([head,payload]));}
  server.on('upgrade',(req,socket)=>{
    if(req.headers.authorization!=='Bearer test-speech-key'){stats.unauthorized++;socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    stats.authorized++;const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);clients.add(socket);const session={streaming:req.url==='/api-ws/v1/inference',ready:false,taskId:'',sent:false};sessions.set(socket,session);stats.urls.push(req.url);socket.on('error',()=>{});socket.on('close',()=>{clients.delete(socket);sessions.delete(socket);});let pending=Buffer.alloc(0),sent=false;
    const result=(sentence,usage)=>send(socket,{header:{event:'result-generated',task_id:session.taskId},payload:{output:{sentence},...(usage?{usage}:{})}});
    let audioMs=0;const frame=pcm=>{if(!session.ready){stats.prematureFrames++;return;}audioMs+=pcm.length/32;stats.audioMs=audioMs;stats.frames++;stats.audioBytes+=pcm.length;stats.nonzero ||= pcm.some(x=>x!==0);
      if(!sent&&stats.frames>3){sent=true;if(session.streaming){result({sentence_id:1,begin_time:0,end_time:null,sentence_end:false,text:'皆さん、こんにちは。',words:[{text:'皆さん、',fixed:true},{text:'こんにちは。',fixed:false}]});result({sentence_id:1,begin_time:0,end_time:1800,sentence_end:true,text:'皆さん、こんにちは。'},{input_tokens:85,output_tokens:6});}
        else{send(socket,{type:'conversation.item.input_audio_transcription.text',item_id:'one',text:'皆さん、',stash:'こんにちは。'});send(socket,{type:'conversation.item.input_audio_transcription.completed',item_id:'one',transcript:'皆さん、こんにちは。'});}}
    };
    socket.on('data',chunk=>{pending=Buffer.concat([pending,chunk]);if(pending.length>1000000){socket.destroy();return;}
      while(pending.length>=2){const opcode=pending[0]&15,masked=!!(pending[1]&128);let length=pending[1]&127,offset=2;if(length===126){if(pending.length<4)return;length=pending.readUInt16BE(2);offset=4;}if(length===127){socket.destroy();return;}if(masked)offset+=4;if(pending.length<offset+length)return;
        const payload=Buffer.from(pending.subarray(offset,offset+length));if(masked)for(let i=0;i<length;i++)payload[i]^=pending[offset-4+i%4];pending=pending.subarray(offset+length);
        if(opcode===8){socket.end(Buffer.from([0x88,0]));return;}if(opcode===2){stats.binaryFrames++;if(!session.streaming)stats.protocolErrors++;frame(payload);continue;}if(opcode!==1)continue;
        let message;try{message=JSON.parse(payload);}catch{continue;}
        if(message.header?.action==='run-task'){stats.lastRun=message;session.taskId=message.header.task_id;stats.streamingStarts++;stats.config=message.payload.parameters;if(!session.streaming||message.payload.model!=='qwen-audio-3.1-asr-flash-streaming')stats.protocolErrors++;setTimeout(()=>{if(!socket.destroyed){session.ready=true;send(socket,{header:{event:'task-started',task_id:session.taskId},payload:{}});}},readyDelay);}
        if(message.header?.action==='finish-task'){stats.streamingFinishes++;if(message.header.task_id!==session.taskId)stats.protocolErrors++;send(socket,{header:{event:'task-finished',task_id:session.taskId},payload:{}});socket.end();}
        if(message.type==='session.update'){if(session.streaming)stats.protocolErrors++;stats.config=message.session;session.ready=true;send(socket,{type:'session.updated'});}
        if(message.type==='session.finish'){send(socket,{type:'session.finished'});socket.end();}
        if(message.type==='input_audio_buffer.append'){stats.legacyFrames++;if(session.streaming)stats.protocolErrors++;frame(Buffer.from(message.audio,'base64'));}
      }
    });
  });
  return {stats,clients,setReadyDelay:ms=>readyDelay=ms,emit:data=>{for(const c of clients)send(c,data);},emitStreaming:(sentence,usage)=>{for(const [c,s] of sessions)if(s.streaming)send(c,{header:{event:'result-generated',task_id:s.taskId},payload:{output:{sentence},...(usage?{usage}:{})}});},disconnect:()=>{for(const c of clients)c.destroy();},close:()=>{for(const c of clients)c.destroy();clients.clear();}};
}
