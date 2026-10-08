export interface SubtitleCue {id:string;start:number;end:number;text:string;context:string}
export function cueIndex(cues:ArrayLike<{startTime:number}>,time:number) {
  let low=0,high=cues.length;while(low<high){const mid=(low+high)>>>1;if(cues[mid].startTime<time)low=mid+1;else high=mid;}return low;
}
export function activeSubtitle(cues:SubtitleCue[],time:number) {
  return cues.filter(c=>c.start<=time&&time<c.end);
}
export function subtitleText(text:string){return text.replace(/\s+/g,' ').trim().slice(0,2000);}
