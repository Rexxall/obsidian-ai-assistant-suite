const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
// A server that never answers: the request only ends when its signal aborts.
const hangingFetch=(url,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{const e=new Error('The operation was aborted');e.name='AbortError';reject(e);}));
const hangingRequestUrl=()=>new Promise(()=>{});
function fixture({fetch=hangingFetch,requestUrl=hangingRequestUrl}={}){
 const module={exports:{}};
 const obsidian={...Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}])),requestUrl};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{window:{setTimeout,clearTimeout,setInterval,clearInterval},module,console,fetch,AbortController,TextEncoder,TextDecoder,require:()=>obsidian});
 return new module.exports();
}
test('a silent server times out instead of hanging',async()=>{
 const p=fixture();
 await assert.rejects(p.executeJsonRequest('https://example.invalid',{method:'POST'},{timeout:30}),/秒未响应/);
});
test('pressing cancel is still reported as a cancel, not a timeout',async()=>{
 const p=fixture();const user=new AbortController();
 const pending=p.executeJsonRequest('https://example.invalid',{method:'POST'},{timeout:5000,signal:user.signal});
 user.abort();
 await assert.rejects(pending,error=>!/秒未响应/.test(error.message)&&p.isCancellationError(error));
});
test('streaming waits only a limited time for the first answer',async()=>{
 const p=fixture();
 await assert.rejects(p.callOpenAiStreaming('https://example.invalid',{method:'POST'},{timeout:30}),/秒未响应/);
});
test('a normal reply still comes back through requestUrl',async()=>{
 let seen;
 const p=fixture({requestUrl:async(request)=>{seen=request;return {status:200,text:'{"choices":[]}'};}});
 assert.deepEqual(JSON.parse(JSON.stringify(await p.executeJsonRequest('https://example.invalid',{method:'POST',headers:{a:'b'},body:'{}'},{timeout:1000}))),{choices:[]});
 assert.equal(seen.url,'https://example.invalid');assert.equal(seen.throw,false);assert.equal(seen.headers.a,'b');
});
test('an HTTP error keeps its status and the start of the body',async()=>{
 const p=fixture({requestUrl:async()=>({status:401,text:'{"error":"bad key"}'})});
 await assert.rejects(p.executeJsonRequest('https://example.invalid',{method:'POST'},{timeout:1000}),/HTTP 401\. \{"error":"bad key"\}/);
});
test('when the browser blocks a streaming request, one plain request is made instead',async()=>{
 let plainBody;
 const p=fixture({
  fetch:async()=>{throw new TypeError('Failed to fetch');},
  requestUrl:async(request)=>{plainBody=JSON.parse(request.body);return {status:200,text:'{"choices":[{"message":{"content":"whole answer"}}]}'};}
 });
 p.getApiKey=async()=>'key';
 const streamed=[];
 const out=await p._callSingleConfig('hello',null,false,{apiProvider:'openai',apiUrl:'https://x.test/v1/chat/completions',modelName:'m'},{stream:true,onStream:(d)=>streamed.push(d)});
 assert.equal(out,'whole answer');assert.equal(plainBody.stream,undefined);assert.deepEqual(streamed,['whole answer']);
});
