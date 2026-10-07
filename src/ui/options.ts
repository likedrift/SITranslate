import {type Settings,type Profile,type TranslationResult} from '../core/types';
import {endpointFor,validateSettings} from '../core/validation';
import {rpc,el,value,check,languageOptions,sitePattern} from './client';
let settings:Settings,editing='',origins:string[]=[];
const fields=['profile-name','base-url','api-key','model','input-price','output-price'];
function feedback(text:string,state=''){el('feedback').textContent=text;el('feedback').className=state;}
function capture(){
  const p=settings.profiles.find(p=>p.id===editing);if(!p)return;
  Object.assign(p,{name:value('profile-name').trim(),type:value('profile-type'),baseUrl:value('base-url').trim(),apiKey:value('api-key').trim(),model:value('model').trim(),
    stream:check('stream'),jsonMode:check('json-mode'),disableThinking:check('disable-thinking'),inputPrice:Number(value('input-price'))||0,outputPrice:Number(value('output-price'))||0});
  if(check('is-active'))settings.activeProfileId=p.id;
}
function profileList(){el('profile-list').replaceChildren();for(const p of settings.profiles){const option=document.createElement('option');option.value=p.id;option.textContent=`${p.name||'未命名'}${p.id===settings.activeProfileId?' · 默认':''}`;el('profile-list').append(option);}el<HTMLSelectElement>('profile-list').value=editing;el<HTMLButtonElement>('delete-profile').disabled=settings.profiles.length===1;}
function fillProfile(){const p=settings.profiles.find(p=>p.id===editing)!;
  el<HTMLInputElement>('profile-name').value=p.name;el<HTMLSelectElement>('profile-type').value=p.type;el<HTMLInputElement>('base-url').value=p.baseUrl;el<HTMLInputElement>('api-key').value=p.apiKey;el<HTMLInputElement>('api-key').type='password';el('toggle-key').textContent='显示';el<HTMLInputElement>('model').value=p.model;
  el<HTMLInputElement>('input-price').value=String(p.inputPrice);el<HTMLInputElement>('output-price').value=String(p.outputPrice);
  el<HTMLInputElement>('stream').checked=p.stream;el<HTMLInputElement>('json-mode').checked=p.jsonMode;el<HTMLInputElement>('disable-thinking').checked=p.disableThinking;el<HTMLInputElement>('is-active').checked=p.id===settings.activeProfileId;
  el('thinking-row').hidden=p.type!=='deepseek';profileList();
}
function gather(){capture();settings.target=value('target');settings.display=value('display')as Settings['display'];settings.maxPageChars=Number(value('max-chars'));settings.dynamic=check('dynamic');settings.includeContext=check('include-context');settings.cacheEnabled=check('cache-enabled');validateSettings(settings);return structuredClone(settings);}
async function persist(candidate:Settings,grant:Promise<boolean>){
  if(!await grant)throw new Error('API 服务访问权限未授予，设置尚未保存。');
  await rpc('settings:save',{settings:candidate});feedback('设置已保存。','success');profileList();
}
// Permission requests are invoked synchronously from the submit/click handlers.
function save(){const candidate=gather();const required=[...new Set(candidate.profiles.map(p=>endpointFor(p.baseUrl).permission))];const grant=chrome.permissions.request({origins:required});return persist(candidate,grant);}
el('settings-form').addEventListener('submit',event=>{event.preventDefault();let saved:Promise<void>;try{saved=save();}catch(err){feedback((err as Error).message,'error');return;}
  el<HTMLButtonElement>('save').disabled=true;saved.catch(err=>feedback(err.message,'error')).finally(()=>{el<HTMLButtonElement>('save').disabled=false;});
});
el('profile-list').addEventListener('change',()=>{capture();editing=value('profile-list');fillProfile();});
el('profile-type').addEventListener('change',()=>{el('thinking-row').hidden=value('profile-type')!=='deepseek';});
el('is-active').addEventListener('change',()=>{if(!check('is-active')){el<HTMLInputElement>('is-active').checked=editing===settings.activeProfileId;return;}capture();profileList();});
el('add-profile').addEventListener('click',()=>{capture();if(settings.profiles.length>=12){feedback('最多保存 12 个服务配置。','error');return;}
  const p:Profile={id:crypto.randomUUID(),name:'自定义服务',type:'compatible',baseUrl:'https://api.example.com/v1',apiKey:'',model:'',stream:true,jsonMode:false,disableThinking:false,inputPrice:0,outputPrice:0};settings.profiles.push(p);editing=p.id;fillProfile();feedback('填写新服务地址和模型后保存。');
});
el('delete-profile').addEventListener('click',()=>{if(settings.profiles.length===1)return;settings.profiles=settings.profiles.filter(p=>p.id!==editing);if(settings.activeProfileId===editing)settings.activeProfileId=settings.profiles[0].id;editing=settings.profiles[0].id;fillProfile();feedback('配置已移除，保存后生效。');});
el('toggle-key').addEventListener('click',()=>{const key=el<HTMLInputElement>('api-key');key.type=key.type==='password'?'text':'password';el('toggle-key').textContent=key.type==='password'?'显示':'隐藏';});
el('test').addEventListener('click',()=>{let saved:Promise<void>;try{saved=save();}catch(err){feedback((err as Error).message,'error');return;}
  const testProfile=editing;el<HTMLButtonElement>('test').disabled=true;el('test-result').textContent='正在连接…';
  const heartbeat=setInterval(()=>rpc('task:heartbeat').catch(()=>{}),15000);
  saved.then(()=>rpc<TranslationResult>('translate',{input:{kind:'test',taskId:crypto.randomUUID(),requestId:crypto.randomUUID(),profileId:testProfile,target:settings.target,blocks:[{id:'test',context:'',segments:[{id:'test',text:'Hello, world! こんにちは。'}]}]}}))
    .then(result=>{el('test-result').textContent=`连接成功：${result.segments[0].text}`;void refreshUsage();})
    .catch(err=>{el('test-result').textContent=err.message;feedback(err.message,'error');}).finally(()=>{clearInterval(heartbeat);el<HTMLButtonElement>('test').disabled=false;});
});
async function saveOrigins(next:string[]){origins=await rpc<string[]>('selection:save',{origins:next});renderOrigins();feedback('划词授权已更新；已打开的网页请刷新。','success');}
function renderOrigins(){el('site-list').replaceChildren();for(const origin of origins){const li=document.createElement('li'),label=document.createElement('span'),remove=document.createElement('button');label.textContent=origin;remove.type='button';remove.className='text-button danger';remove.textContent='移除';remove.addEventListener('click',()=>saveOrigins(origins.filter(o=>o!==origin)).catch(err=>feedback(err.message,'error')));li.append(label,remove);el('site-list').append(li);}}
el('add-site').addEventListener('click',()=>{let pattern:string;try{pattern=sitePattern(value('site-url'));}catch(err){feedback((err as Error).message,'error');return;}
  const grant=chrome.permissions.request({origins:[pattern]});grant.then(ok=>{if(!ok)throw new Error('网站访问权限未授予。');return saveOrigins([...new Set([...origins,pattern])]);}).then(()=>{el<HTMLInputElement>('site-url').value='';}).catch(err=>feedback(err.message,'error'));
});
el('all-sites').addEventListener('click',()=>{const patterns=['https://*/*','http://*/*'];const grant=chrome.permissions.request({origins:patterns});grant.then(ok=>{if(!ok)throw new Error('网站访问权限未授予。');return saveOrigins(patterns);}).catch(err=>feedback(err.message,'error'));});
async function refreshUsage(){const data=await rpc<{usage:{requests:number;input:number;output:number;estimatedCost:number};cache:{entries:number;bytes:number}}>('usage:get');
  el('usage-requests').textContent=data.usage.requests.toLocaleString();el('usage-tokens').textContent=(data.usage.input+data.usage.output).toLocaleString();el('usage-cost').textContent=data.usage.estimatedCost?data.usage.estimatedCost.toFixed(4):'—';el('cache-summary').textContent=`会话缓存：${data.cache.entries} 个批次 · ${(data.cache.bytes/1024).toFixed(1)} KB / 4 MB`;
}
el('clear-cache').addEventListener('click',()=>rpc('cache:clear').then(refreshUsage).then(()=>feedback('译文缓存已清除。','success')).catch(err=>feedback(err.message,'error')));
el('clear-usage').addEventListener('click',()=>rpc('usage:clear').then(refreshUsage).then(()=>feedback('用量统计已重置。','success')).catch(err=>feedback(err.message,'error')));
for(const id of fields)el(id).addEventListener('input',()=>feedback('有未保存的修改。'));
async function init(){settings=await rpc<Settings>('settings:get');editing=settings.activeProfileId;
  languageOptions(el<HTMLSelectElement>('target'));el<HTMLSelectElement>('target').value=settings.target;el<HTMLSelectElement>('display').value=settings.display;el<HTMLSelectElement>('max-chars').value=String(settings.maxPageChars);
  el<HTMLInputElement>('dynamic').checked=settings.dynamic;el<HTMLInputElement>('include-context').checked=settings.includeContext;el<HTMLInputElement>('cache-enabled').checked=settings.cacheEnabled;
  fillProfile();origins=await rpc<string[]>('selection:origins');renderOrigins();await refreshUsage();
}
void init().catch(err=>feedback(err.message,'error'));
