import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AudioPreroll,PREROLL_FRAME_SAMPLES,PREROLL_SAMPLES} from '../src/core/audio-preroll.ts';

const frame=(mark:number)=>{const samples=new Float32Array(PREROLL_FRAME_SAMPLES);samples[0]=mark;return samples;};

test('audio captured before ready is returned in order and then forgotten',()=>{
  const ring=new AudioPreroll();
  ring.push(frame(1),0);ring.push(frame(2),100);ring.push(frame(3),200);
  assert.deepEqual(ring.drain(200).map(item=>item.samples[0]),[1,2,3]);
  assert.equal(ring.length,0);assert.equal(ring.samples,0);
  assert.deepEqual(ring.drain(200),[]);
});

test('the opening buffer keeps only about two seconds and the newest frames',()=>{
  const ring=new AudioPreroll();
  for(let i=0;i<1000;i++)ring.push(frame(i),i*100);
  assert.equal(ring.samples,PREROLL_SAMPLES);
  assert.equal(ring.length,PREROLL_SAMPLES/PREROLL_FRAME_SAMPLES);
  const kept=ring.drain(999*100);
  assert.equal(kept.length,20);
  assert.equal(kept[0].samples[0],980);
  assert.equal(kept.at(-1)?.samples[0],999);
  assert.equal(ring.samples,0);
});

test('frames older than the opening window are dropped even when capture pauses',()=>{
  const ring=new AudioPreroll();
  ring.push(frame(1),0);ring.push(frame(2),1000);
  assert.deepEqual(ring.drain(1000+2001).map(item=>item.samples[0]),[]);
  ring.push(frame(3),5000);ring.push(frame(4),6000);
  assert.deepEqual(ring.drain(7600).map(item=>item.samples[0]),[4]);
});

test('stop and reconnect clear the buffer so stale audio is not flushed later',()=>{
  const ring=new AudioPreroll();
  ring.push(frame(1),0);ring.push(frame(2),100);
  ring.clear();
  assert.equal(ring.drain(100).length,0);
  ring.push(frame(3),200);
  assert.deepEqual(ring.drain(200).map(item=>item.samples[0]),[3]);
});

test('a single oversized frame cannot grow the buffer past the cap',()=>{
  const ring=new AudioPreroll(),big=new Float32Array(PREROLL_SAMPLES+80);
  big[0]=9;big[big.length-1]=7;
  ring.push(big,0);
  const kept=ring.drain(0);
  assert.equal(kept.length,1);
  assert.equal(kept[0].samples.length,PREROLL_SAMPLES);
  assert.equal(kept[0].samples.at(-1),7);
  assert.notEqual(kept[0].samples[0],9);
});
