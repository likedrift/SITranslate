// The AudioContext resamples tab audio to 16 kHz; only 100 ms mono buffers cross the port.
class SiPCM extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Float32Array(1600);this.offset=0;}
  process(inputs){const channels=inputs[0];if(!channels?.length)return true;
    for(let i=0;i<channels[0].length;i++){let value=0;for(const channel of channels)value+=channel[i]||0;this.buffer[this.offset++]=value/channels.length;
      if(this.offset===1600){this.port.postMessage(this.buffer,[this.buffer.buffer]);this.buffer=new Float32Array(1600);this.offset=0;}}
    return true;
  }
}
registerProcessor('si-pcm',SiPCM);
