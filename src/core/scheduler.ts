interface Work<T> { priority: number; signal: AbortSignal; run: () => Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void; unlisten: () => void }
export type SchedulerLane = 'shared' | 'live';
/**
 * `shared` is the page / selection / video-subtitle pool.
 * `live` is a separate FIFO lane for `subtitle-live-` requests: it does not wait
 * for a shared slot, and it never runs more than `liveConcurrency` requests at once.
 * Queued live work stays in arrival order so a later fragment cannot pass an earlier one.
 */
export class Scheduler {
  private shared: Work<unknown>[] = [];
  private live: Work<unknown>[] = [];
  private sharedRunning = 0;
  private liveRunning = 0;
  constructor(private concurrency = 2, private liveConcurrency = 1) {}
  enqueue<T>(priority: number, signal: AbortSignal, run: () => Promise<T>, lane: SchedulerLane = 'shared'): Promise<T> {
    return new Promise((resolve,reject) => {
      if (signal.aborted) { reject(new DOMException('已取消','AbortError')); return; }
      const queue = lane === 'live' ? this.live : this.shared;
      const job: Work<T> = {priority,signal,run,resolve,reject,unlisten:()=>{}};
      const abort = () => { const i=queue.indexOf(job as Work<unknown>); if(i>=0) {queue.splice(i,1);job.unlisten();reject(new DOMException('已取消','AbortError'));} };
      signal.addEventListener('abort',abort,{once:true});
      job.unlisten=()=>signal.removeEventListener('abort',abort);
      queue.push(job as Work<unknown>);
      if (lane !== 'live') queue.sort((a,b)=>b.priority-a.priority);
      this.pump();
    });
  }
  private start(job: Work<unknown>, lane: SchedulerLane) {
    job.unlisten();
    if (lane === 'live') this.liveRunning++; else this.sharedRunning++;
    Promise.resolve().then(()=> {if(job.signal.aborted) throw new DOMException('已取消','AbortError'); return job.run();})
      .then(job.resolve,job.reject).finally(()=>{if(lane==='live')this.liveRunning--;else this.sharedRunning--;this.pump();});
  }
  private pump() {
    while(this.sharedRunning<this.concurrency && this.shared.length) this.start(this.shared.shift()!,'shared');
    while(this.liveRunning<this.liveConcurrency && this.live.length) this.start(this.live.shift()!,'live');
  }
}
