// Decode only the expected first segment's text, never JSON scaffolding or reasoning.
export function streamSegment(raw:string,id:string,max=6000):string|undefined{
  const match=raw.match(/^\s*(?:```(?:json)?\s*)?\{\s*"segments"\s*:\s*\[\s*\{/);if(!match)return;
  let offset=match[0].length,foundId:string|undefined,foundText:string|undefined;const seen=new Set<string>();
  const space=()=>{while(/\s/.test(raw[offset]??'')&&offset<raw.length)offset++;};
  function string(){if(raw[offset++]!=='"')return;let value='';
    while(offset<raw.length){let c=raw[offset++];if(c==='"')return {value,complete:true};if(c<' ')return;
      if(c==='\\'){const escape=raw[offset++];if(!escape)break;if(escape==='u'){const hex=raw.slice(offset,offset+4);if(hex.length<4)break;if(!/^[0-9a-f]{4}$/i.test(hex))return;c=String.fromCharCode(parseInt(hex,16));offset+=4;}else{const escapes:Record<string,string>={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};if(!(escape in escapes))return;c=escapes[escape];}}
      value+=c;if(value.length>max)return;
    }return {value:value.replace(/[\uD800-\uDBFF]$/,''),complete:false};
  }
  while(offset<raw.length){space();const key=string();if(!key?.complete||!['id','text'].includes(key.value)||seen.has(key.value))return;seen.add(key.value);space();if(raw[offset++]!==':')return;space();const v=string();if(!v)return;
    if(key.value==='id'){if(!v.complete)return;foundId=v.value;}else foundText=v.value;
    if(foundId===id&&foundText!==undefined)return foundText;if(foundId!==undefined&&foundId!==id)return;if(!v.complete)return;
    space();if(raw[offset++]!==',')return;
  }
}
