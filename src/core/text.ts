/** Conservative batching heuristic, not a billing tokenizer. Reserve room for IDs and expanded translations. */
export function estimateOutputTokens(text:string){
  const nonAscii=text.replace(/[\x00-\x7f]/g,'').length;
  return Math.ceil((text.length-nonAscii)/3+nonAscii*1.5)+16;
}
