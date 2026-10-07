interface Work<T> { priority: number; signal: AbortSignal; run: () => Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void; unlisten: () => void }
export class Scheduler {
  private queue: Work<unknown>[] = [];
  private running = 0;
  constructor(private concurrency = 2) {}
  enqueue<T>(priority: number, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    return new Promise((resolve,reject) => {
      if (signal.aborted) { reject(new DOMException('已取消','AbortError')); return; }
      const job: Work<T> = {priority,signal,run,resolve,reject,unlisten:()=>{}};
      const abort = () => { const i=this.queue.indexOf(job as Work<unknown>); if(i>=0) {this.queue.splice(i,1);job.unlisten();reject(new DOMException('已取消','AbortError'));} };
      signal.addEventListener('abort',abort,{once:true});
      job.unlisten=()=>signal.removeEventListener('abort',abort);
      this.queue.push(job as Work<unknown>); this.queue.sort((a,b)=>b.priority-a.priority); this.pump();
    });
  }
  private pump() {
    while(this.running<this.concurrency && this.queue.length) {
      const job=this.queue.shift()!;job.unlisten();this.running++;
      Promise.resolve().then(()=> {if(job.signal.aborted) throw new DOMException('已取消','AbortError'); return job.run();})
        .then(job.resolve,job.reject).finally(()=>{this.running--;this.pump();});
    }
  }
}
