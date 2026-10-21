const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
// A server that never answers: the request only ends when its signal aborts.
const hangingFetch=(url,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{const e=new Error('The operation was aborted');e.name='AbortError';reject(e);}));
function fixture(fetch){
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{module,console,fetch,AbortController,setTimeout,clearTimeout,TextEncoder,TextDecoder,require:()=>Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]))});
 return new module.exports();
}
test('a silent server times out instead of hanging',async()=>{
 const p=fixture(hangingFetch);
 await assert.rejects(p.executeJsonRequest('https://example.invalid',{method:'POST'},{timeout:30}),/秒未响应/);
});
test('pressing cancel is still reported as a cancel, not a timeout',async()=>{
 const p=fixture(hangingFetch);const user=new AbortController();
 const pending=p.executeJsonRequest('https://example.invalid',{method:'POST'},{timeout:5000,signal:user.signal});
 user.abort();
 await assert.rejects(pending,error=>!/秒未响应/.test(error.message)&&p.isCancellationError(error));
});
test('streaming waits only a limited time for the first answer',async()=>{
 const p=fixture(hangingFetch);
 await assert.rejects(p.callOpenAiStreaming('https://example.invalid',{method:'POST'},{timeout:30}),/秒未响应/);
});
test('a normal reply still comes back',async()=>{
 const p=fixture(async()=>({ok:true,status:200,text:async()=>'{"choices":[]}'}));
 assert.deepEqual(JSON.parse(JSON.stringify(await p.executeJsonRequest('https://example.invalid',{method:'POST'},{timeout:1000}))),{choices:[]});
});
