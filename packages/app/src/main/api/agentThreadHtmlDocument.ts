import { cloneBoundedMcpJson } from '@shared/api/agentThreadMcp'
import type { HtmlAppDocument } from './agentThreadHtmlHost'

export const HTML_BRIDGE_PROTOCOL = 'magicpot-html-bridge/v3'
export const HTML_INTERACTION_MS = 5000
export const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
export const htmlTheme = (dark: boolean) => ({ scheme: dark ? 'dark' : 'light', vars: {
  '--kt-bg': dark ? '#151923' : '#ffffff', '--kt-fg': dark ? '#e4e9f3' : '#1f2937',
  '--kt-muted': dark ? '#a5aec0' : '#64748b', '--kt-card': dark ? '#222938' : '#f1f5f9',
  '--kt-border': dark ? '#485065' : '#cbd5e1', '--kt-accent': dark ? '#82b1ff' : '#2563eb',
  '--kt-font': 'system-ui, sans-serif', '--kt-mono': 'ui-monospace, monospace'
} })
export function validateHtmlHostDocument(document: HtmlAppDocument): void {
  if (!document || typeof document.title !== 'string' || !document.title.trim() || document.title.length > 120 || typeof document.html !== 'string' || !document.html.trim() || Buffer.byteLength(document.html) > 256 * 1024 || !Number.isSafeInteger(document.revision) || document.revision < 1 || (document.data !== undefined && (!document.data || typeof document.data !== 'object' || Array.isArray(document.data) || Buffer.byteLength(JSON.stringify(document.data)) > 64 * 1024))) throw new Error('Invalid bounded HTML app document.')
  if (document.state !== undefined) cloneBoundedMcpJson(document.state, 65536)
  if (document.state !== undefined && (!document.state || typeof document.state !== 'object' || Array.isArray(document.state))) throw new Error('Invalid HTML app JSON state.')
}
/** No preload. The random main-only bridge key never enters the opaque child. */
export function buildIsolatedHtmlShell(document: HtmlAppDocument, bridgeId: string, dark = false): string {
  validateHtmlHostDocument(document)
  if (!/^[a-f0-9-]{36}$/.test(bridgeId)) throw new Error('Invalid HTML host bridge identity.')
  const theme = htmlTheme(dark)
  const childPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none';"
  const childScript = `(()=>{'use strict';
const protocol=${scriptJson(HTML_BRIDGE_PROTOCOL)},data=${scriptJson(document.data ?? {})};
let state=${scriptJson(document.state ?? {})};
let theme=${scriptJson(theme)},viewport=Object.freeze({width:innerWidth,height:innerHeight,mode:'window'}),seq=0;
const pending=new Map(),listeners=new Map();let listenerCount=0;
const emit=(name,value)=>{for(const fn of [...(listeners.get(name)||[])])try{fn(value)}catch{}};
const applyTheme=t=>{theme=Object.freeze({scheme:t.scheme,vars:Object.freeze({...t.vars})});for(const [key,value] of Object.entries(theme.vars))document.documentElement.style.setProperty(key,value);document.documentElement.style.colorScheme=theme.scheme};
const request=(method,fields={})=>new Promise((resolve,reject)=>{
 if(pending.size>=32){reject(new Error('App bridge outstanding-call limit'));return}
 const id=++seq;let raw;try{raw=JSON.stringify({protocol,id,method,...fields});if(new TextEncoder().encode(raw).length>(method==='state'?73728:8192))throw Error('App message exceeds byte limit')}catch(error){reject(error);return}
 const timer=setTimeout(()=>{pending.delete(id);reject(new Error('App bridge acknowledgement timed out'))},12000);
 pending.set(id,{resolve,reject,timer});parent.postMessage(raw,'*');
});
addEventListener('message',event=>{
 if(event.source!==parent||!event.data||event.data.protocol!==protocol)return;
 const msg=event.data;
 if(msg.type==='reply'){const call=pending.get(msg.id);if(!call)return;pending.delete(msg.id);clearTimeout(call.timer);if(msg.error)call.reject(new Error(msg.error));else call.resolve(msg.result);return}
 if(msg.type==='viewport'){viewport=Object.freeze({...msg.value});emit('viewport',viewport)}
 if(msg.type==='state'){state=JSON.parse(JSON.stringify(msg.value));emit('state',JSON.parse(JSON.stringify(state)))}
 if(msg.type==='theme'){applyTheme(msg.value);emit('theme',theme)}
});
applyTheme(theme);
const ready=request('initialize').then(init=>{viewport=Object.freeze({...init.viewport});applyTheme(init.theme);emit('viewport',viewport);emit('theme',theme);state=JSON.parse(JSON.stringify(init.state||{}));emit('state',JSON.parse(JSON.stringify(state)));return Object.freeze(init)});
ready.catch(()=>{});
Object.defineProperty(window,'kt',{value:Object.freeze({data,title:${scriptJson(document.title)},ready,
 state:Object.freeze({get(){return JSON.parse(JSON.stringify(state))},set(patch){return request('state',{patch}).then(next=>{state=JSON.parse(JSON.stringify(next.state));emit('state',JSON.parse(JSON.stringify(state)));return JSON.parse(JSON.stringify(state))})}}),
 get viewport(){return viewport},get theme(){return theme},
 on(name,fn){if(!['viewport','theme','data','state'].includes(name)||typeof fn!=='function')throw Error('Invalid app listener');if(listenerCount>=64)throw Error('App listener limit');let set=listeners.get(name);if(!set){set=new Set();listeners.set(name,set)}if(!set.has(fn)){set.add(fn);listenerCount++}return()=>{if(set.delete(fn))listenerCount--}},
 send(name,value){if(typeof name!=='string'||!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name)||name.startsWith('__'))return Promise.reject(new Error('Invalid or reserved app event name'));return request('send',{name,data:value===undefined?null:value})}
}),writable:false,configurable:false});
for(const key of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel'])try{Object.defineProperty(window,key,{value:undefined,writable:false,configurable:false})}catch{}
let lastError=-Infinity;const reportError=()=>{if(performance.now()-lastError<1000)return;lastError=performance.now();request('error').catch(()=>{})};
addEventListener('error',reportError);addEventListener('unhandledrejection',reportError);
})()`
  const child = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${childPolicy}"><meta name="referrer" content="no-referrer"><style>html,body{background:var(--kt-bg);color:var(--kt-fg);font-family:var(--kt-font);margin:0}body{padding:8px;box-sizing:border-box}</style><script>${childScript}</script></head><body>${document.html}</body></html>`
  const payload = scriptJson({ child, title: document.title, revision: document.revision, theme, state: document.state ?? {} })
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src about:; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none';"><style>html,body{margin:0;height:100%;font:14px sans-serif;background:#151923;color:#e4e9f3}header{height:42px;box-sizing:border-box;padding:10px 14px;overflow:hidden;border-bottom:1px solid #485065}iframe{display:block;border:0;width:100%;height:calc(100% - 42px)}</style></head><body><header id="title"></header><iframe id="app" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><script>(()=>{'use strict';
const payload=${payload},protocol=${scriptJson(HTML_BRIDGE_PROTOCOL)},frame=document.getElementById('app'),queue=[],inflight=new Map();
let tokens=24,last=performance.now(),dropped=0,highId=0,inputToken='',inputUntil=0,theme=payload.theme,state=payload.state,stateRevision=0,stateDirty=false,stateFrozen=false,resizePending=false;
document.getElementById('title').textContent='MagicPot · isolated untrusted HTML · '+payload.title;
const post=message=>frame.contentWindow?.postMessage({protocol,...message},'*');
const reply=(id,error)=>post({type:'reply',id,...(error?{error}:{result:{accepted:true,stage:'auxiliary-host',untrustedData:true,grantsPermission:false}})});
const viewport=()=>({width:frame.clientWidth,height:frame.clientHeight,mode:'window'});
const passive=value=>{let nodes=0;const visit=(x,depth)=>{if(++nodes>2048||depth>16)throw Error('State structure limit');if(x===null||typeof x==='boolean'||typeof x==='string'||typeof x==='number'&&Number.isFinite(x))return x;if(!x||typeof x!=='object')throw Error('Invalid state');if(Array.isArray(x)){if(x.length>256)throw Error('State array limit');return x.map(item=>visit(item,depth+1))}const entries=Object.entries(x);if(entries.length>256)throw Error('State keys limit');const out={};for(const [key,val]of entries){if(['__proto__','prototype','constructor'].includes(key))throw Error('Unsafe state key');out[key]=visit(val,depth+1)}return out};const result=visit(value,0);if(new TextEncoder().encode(JSON.stringify(result)).length>65536)throw Error('State byte limit');return result};
const notifyViewport=()=>{resizePending=false;post({type:'viewport',value:viewport()})};
new ResizeObserver(()=>{if(!resizePending){resizePending=true;requestAnimationFrame(notifyViewport)}}).observe(frame);
addEventListener('message',event=>{
 if(event.source!==frame.contentWindow||typeof event.data!=='string'||new TextEncoder().encode(event.data).length>73728)return;
 let msg;try{msg=JSON.parse(event.data)}catch{return}
 if(!msg||msg.protocol!==protocol||!Number.isSafeInteger(msg.id)||msg.id<=highId)return;
 highId=msg.id;const id=msg.id,now=performance.now();tokens=Math.min(24,tokens+(now-last)*.004);last=now;
 if(tokens<1){dropped++;reply(id,'App bridge rate limit');return}tokens--;
 if(msg.method==='initialize'){post({type:'reply',id,result:{protocolVersion:'magicpot-html/3',title:payload.title,revision:payload.revision,theme,viewport:viewport(),state}});return}
 if(msg.method==='state'){
  if(stateFrozen){reply(id,'App state frozen for shutdown');return}
  try{const patch=passive(msg.patch);if(!patch||Array.isArray(patch)||typeof patch!=='object')throw Error('State patch must be an object');const next=passive({...state,...patch});state=next;stateRevision++;stateDirty=true;post({type:'reply',id,result:{state:next,untrustedData:true,grantsPermission:false}})}catch{reply(id,'Invalid or oversized JSON state')}return
 }
 if(new TextEncoder().encode(event.data).length>8192){reply(id,'App message exceeds byte limit');return}
 if(!['send','error'].includes(msg.method)){reply(id,'Unsupported app bridge method');return}
 const diagnostic=msg.method==='error';
 if(!diagnostic&&(typeof msg.name!=='string'||!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(msg.name)||msg.name.startsWith('__'))){reply(id,'Invalid or reserved app event');return}
 if(!diagnostic&&(!inputToken||now>inputUntil)){reply(id,'kt.send needs recent input in the app');return}
 if(queue.length+inflight.size>=16){dropped++;reply(id,'App bridge queue limit');return}
 queue.push({id,inputToken:diagnostic?'':inputToken,event:{name:diagnostic?'__error__':msg.name,data:diagnostic?{message:'App script error'}:msg.data??null,revision:payload.revision,origin:'app',untrustedData:true,grantsPermission:false}});
});
Object.defineProperty(window,${scriptJson(bridgeId)},{value:Object.freeze({
 markInput(token,_keyboard){if(document.activeElement!==frame)return false;inputToken=token;inputUntil=performance.now()+5000;return true},
 revokeInput(){inputToken='';inputUntil=0;for(const req of queue.splice(0))reply(req.id,'App input revoked');for(const req of inflight.values())reply(req.id,'App input revoked');inflight.clear()},
 freezeState(){stateFrozen=true;this.revokeInput();return JSON.stringify({revision:payload.revision,stateRevision,value:state})},
 setTheme(next){theme=next;post({type:'theme',value:theme})},
 drain(){const requests=queue.splice(0,2);for(const req of requests)inflight.set(req.id,req);const result=JSON.stringify({requests,dropped,...(stateDirty?{state:{revision:payload.revision,stateRevision,value:state}}:{})});stateDirty=false;return result},
 settle(receipts){for(const receipt of receipts){if(!inflight.delete(receipt.id))continue;reply(receipt.id,receipt.error)}}
}),writable:false,configurable:false});
frame.srcdoc=payload.child;
})()</script></body></html>`
}
