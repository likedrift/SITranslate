interface Entry<T>{controller:AbortController;promise:Promise<T>;subscribers:number;settled:boolean}
/** A cancelled consumer must not cancel a request still needed by another page. */
export class SharedWork<T>{
  private entries=new Map<string,Entry<T>>();
  run(key:string,signal:AbortSignal,start:(signal:AbortSignal)=>Promise<T>):Promise<{value:T;shared:boolean}>{
    if(signal.aborted)return Promise.reject(new DOMException('已取消','AbortError'));
    let entry=this.entries.get(key);const shared=!!entry;
    if(!entry){
      const controller=new AbortController();entry={controller,promise:undefined as unknown as Promise<T>,subscribers:0,settled:false};const created=entry;
      created.promise=Promise.resolve().then(()=>start(controller.signal)).finally(()=>{created.settled=true;if(this.entries.get(key)===created)this.entries.delete(key);});
      this.entries.set(key,created);
    }
    const current=entry;current.subscribers++;
    return new Promise((resolve,reject)=>{
      let finished=false;
      const finish=()=>{if(finished)return false;finished=true;signal.removeEventListener('abort',abort);current.subscribers--;
        if(!current.subscribers&&!current.settled){current.controller.abort();if(this.entries.get(key)===current)this.entries.delete(key);}return true;};
      const abort=()=>{if(finish())reject(new DOMException('已取消','AbortError'));};signal.addEventListener('abort',abort,{once:true});
      current.promise.then(value=>{if(finish())resolve({value,shared});},error=>{if(finish())reject(error);});
      if(signal.aborted)abort();
    });
  }
}

/** Reclaims per-tab tracking maps and aborts orphaned requests when a tab closes. */
export function pruneTabState(
  tabId: number,
  state: {
    videoTabs: Set<number>;
    taskBudget: Map<string, unknown>;
    cancelledTasks: Set<string>;
    jobs: Map<string, { tabId: number; controller: AbortController }>;
  }
): { budgetsChanged: boolean } {
  state.videoTabs.delete(tabId);
  const prefix = `${tabId}:`;
  for (const [key, job] of state.jobs) {
    if (job.tabId === tabId) {
      job.controller.abort();
      state.jobs.delete(key);
    }
  }
  for (const token of state.cancelledTasks) {
    if (token.startsWith(prefix)) state.cancelledTasks.delete(token);
  }
  let budgetsChanged = false;
  for (const key of state.taskBudget.keys()) {
    if (key.startsWith(prefix)) {
      state.taskBudget.delete(key);
      budgetsChanged = true;
    }
  }
  return { budgetsChanged };
}
