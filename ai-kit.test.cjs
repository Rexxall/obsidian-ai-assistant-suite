// Requests, errors and the connection test, now that every provider goes through rex-ai-kit.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const OK='{"choices":[{"message":{"content":"OK"}}]}';
function fixture(requestUrl=async()=>({status:200,text:OK}),keys={'deepseek-api-key':'sk-secretvalue123456','zhipu-api-key':'zk-secretvalue123456','gemini-api-key':'AIzaSecretValue1234567','ai-assistant-suite-proxy-api-key':'sk-proxyvalue123456'}){
 const module={exports:{}};
 const obsidian=Object.fromEntries(['Plugin','Notice','PluginSettingTab','SettingPage','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]));
 const calls=[];
 obsidian.requestUrl=async(req)=>{calls.push(req);return requestUrl(req);};obsidian.getLanguage=()=>'en';obsidian.apiVersion='1.14.5';obsidian.Platform={isMobile:false,isMacOS:true,isDesktopApp:false};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{window:{setTimeout,clearTimeout,setInterval,clearInterval,crypto:globalThis.crypto},navigator:{platform:'test'},AbortController,URL,module,console,require:()=>obsidian});
 const p=new module.exports();p.manifest={version:'x'};p.settings={apiConfigs:[]};
 p.app={secretStorage:{getSecret:id=>keys[id]??null}};
 return Object.assign(p,{calls});
}
const deepseek=(extra={})=>({id:'d',ai:{provider:'deepseek',model:'deepseek-flash'},...extra});

test('a DeepSeek request goes through requestUrl to the official address with the chosen model and thinking off',async()=>{
 const p=fixture();
 assert.equal(await p._callSingleConfig('hi',null,true,deepseek()),'OK');
 const [req]=p.calls;const body=JSON.parse(req.body);
 assert.equal(req.url,'https://api.deepseek.com/chat/completions');assert.equal(req.headers.Authorization,'Bearer sk-secretvalue123456');
 assert.equal(body.model,'deepseek-flash');assert.deepEqual(body.thinking,{type:'disabled'});assert.deepEqual(body.response_format,{type:'json_object'});
 await p._callSingleConfig('hi','deepseek-v4-pro',false,deepseek({deepseekThinking:true}));
 const second=JSON.parse(p.calls[1].body);assert.equal(second.model,'deepseek-v4-pro');assert.deepEqual(second.thinking,{type:'enabled'});assert.equal(second.response_format,undefined);
});
test('other providers get no DeepSeek parameters; a proxy address is kept',async()=>{
 const p=fixture();
 await p._callSingleConfig('hi',null,false,{id:'x',ai:{provider:'custom',model:'m',baseUrl:'https://proxy.test/v1',secretName:'ai-assistant-suite-proxy-api-key'}});
 const [req]=p.calls;assert.equal(req.url,'https://proxy.test/v1/chat/completions');assert.equal(JSON.parse(req.body).thinking,undefined);assert.equal(req.headers.Authorization,'Bearer sk-proxyvalue123456');
});
test('Gemini uses its own API with the key in a header, never in the address',async()=>{
 const p=fixture(async()=>({status:200,text:'{"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}'}));
 assert.equal(await p._callSingleConfig('hi',null,true,{id:'g',ai:{provider:'gemini',model:'gemini-2.5-flash'}}),'hello');
 const [req]=p.calls;assert.match(req.url,/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);assert.equal(req.headers['x-goog-api-key'],'AIzaSecretValue1234567');
});
test('a local model needs no key and sends no Authorization header; JSON is asked for in the prompt only',async()=>{
 const p=fixture(async()=>({status:200,text:'{"message":{"content":"local ok"}}'}),{});
 const config={id:'l',ai:{provider:'ollama',model:'qwen3:8b'}};
 assert.ok(p.isConfigUsable(config));
 assert.equal(await p._callSingleConfig('hi',null,true,config),'local ok');
 const [req]=p.calls;assert.equal(req.url,'http://localhost:11434/api/chat');assert.equal(req.headers.Authorization,undefined);assert.equal(JSON.parse(req.body).format,undefined);
});
test('cloud providers refuse to run without a key, and a custom server without an address',async()=>{
 const p=fixture(undefined,{});
 await assert.rejects(p._callSingleConfig('hi',null,false,deepseek()),e=>e.kind==='no-key');
 assert.equal(p.calls.length,0);
 assert.ok(!p.isConfigUsable({id:'c',ai:{provider:'custom',model:'m'}}));
});
test('a reply asked to stream is handed over once, in full',async()=>{
 const p=fixture();const seen=[];
 await p._callSingleConfig('hi',null,false,deepseek(),{onStream:(delta,full)=>seen.push([delta,full])});
 assert.deepEqual(seen,[['OK','OK']]);
});
test('a silent server times out instead of hanging, and cancel stays a cancel',async()=>{
 const p=fixture(()=>new Promise(()=>{}));
 await assert.rejects(p._callSingleConfig('hi',null,false,deepseek(),{timeout:30}),e=>p.isCancellationError(e)===false&&/no reply|timed out|30/.test(e.message)&&e.kind==='timeout');
 const controller=new AbortController();const run=p._callSingleConfig('hi',null,false,deepseek(),{signal:controller.signal,timeout:5000});
 controller.abort();await assert.rejects(run,e=>p.isCancellationError(e));
});
test('test connection tells missing key, missing address and each server answer apart',async()=>{
 const cases=[[401,'{"error":{"message":"Incorrect API key provided: sk-secretvalue123456"}}','auth'],[402,'Insufficient Balance','quota'],[429,'You exceeded your current quota','quota'],[429,'TPM limit','rate'],[400,'{"error":{"message":"Model Not Exist"}}','model'],[404,'404 page not found','url'],[503,'busy','server']];
 for(const [status,text,kind] of cases){
  const p=fixture(async()=>({status,text}));const r=await p.validateApiConfig(deepseek());
  assert.equal(r.valid,false);assert.equal(r.kind,kind,`${status} ${text}`);assert.ok(r.next.length>0);
  assert.ok(!JSON.stringify(r).includes('secretvalue'),'key never appears in the result');
 }
 const none=fixture(undefined,{});assert.equal((await none.validateApiConfig(deepseek())).kind,'no-key');
 const p=fixture();assert.equal((await p.validateApiConfig({id:'c',ai:{provider:'custom',model:'m'}})).kind,'no-url');
 const net=fixture(async()=>{throw new Error('net::ERR_CONNECTION_REFUSED');});
 assert.equal((await net.validateApiConfig({id:'l',ai:{provider:'ollama',model:'m'}})).kind,'network');
});
test('a key problem links straight to the provider console',async()=>{
 const p=fixture(async()=>({status:401,text:'bad key'}));const r=await p.validateApiConfig(deepseek());
 assert.equal(r.keyPage,'https://platform.deepseek.com/api_keys');assert.match(r.message,/DeepSeek/);
});
test('a successful test sends a tiny capped request and reads no notes',async()=>{
 let body;const p=fixture(async(req)=>{body=JSON.parse(req.body);return {status:200,text:'{"choices":[{"message":{"content":""}}]}'};});
 const r=await p.validateApiConfig({id:'z',ai:{provider:'zhipu',model:''}});
 assert.equal(r.valid,true);assert.equal(body.max_tokens,16);assert.equal(body.model,'glm-5.3-flash');assert.equal(body.messages.length,1);assert.ok(body.messages[0].content.length<20);
});
test('test connection reports address, key, model and parameters separately',async()=>{
 const states=async(status,text)=>{const p=fixture(async()=>({status,text}));const r=await p.validateApiConfig(deepseek());return [r.kind,r.checks.map(c=>c.state).join(' ')].join(': ');};
 assert.equal(await states(200,OK),'ok: ok ok ok ok');
 assert.equal(await states(404,'404 page not found'),'url: fail skip skip skip');
 assert.equal(await states(401,'bad key'),'auth: ok fail skip skip');
 assert.equal(await states(400,'{"error":{"message":"Model Not Exist"}}'),'model: ok ok fail skip');
 assert.equal(await states(400,'{"error":{"message":"Unrecognized request argument: thinking"}}'),'params: ok ok ok fail');
 assert.equal(await states(503,'busy'),'server: ok skip skip skip');
 const p=fixture(undefined,{});assert.equal((await p.validateApiConfig(deepseek())).checks.map(c=>c.state).join(' '),'skip fail skip skip');
});
test('a key in the address is masked in error details',async()=>{
 const p=fixture(async()=>({status:418,text:'GET https://x.test/v1?key=AQ.secretvalue123&alt=json failed'}));
 const r=await p.validateApiConfig(deepseek());
 assert.doesNotMatch(JSON.stringify(r),/secretvalue123/);
});
test('diagnostics list provider, host and model but never the key or the full address',()=>{
 const p=fixture();p.settings={apiConfigs:[{id:'x',ai:{provider:'custom',baseUrl:'https://proxy.test/secret-path?token=abc',model:'m',secretName:'ai-assistant-suite-proxy-api-key'}}]};p.lastApiProblem={kind:'auth',status:401,at:0};
 const d=p.buildDiagnostics();
 assert.match(d,/provider=custom host=proxy\.test \(custom address\) model=m/);assert.match(d,/key=set/);assert.match(d,/Last test: auth \(HTTP 401\)/);
 assert.ok(!d.includes('secret-path')&&!d.includes('token=abc')&&!d.includes('proxyvalue'));
});
test('a suggestion much shorter than the note carries a warning before it is applied',()=>{
 const p=fixture();const long='段落内容。'.repeat(100);
 assert.match(p.shrinkWarning({content:{originalContent:long,proposedContent:long.slice(0,100)}}),/short|短了/);
 assert.equal(p.shrinkWarning({content:{originalContent:long,proposedContent:long.slice(0,400)}}),'');
 assert.equal(p.shrinkWarning({content:{originalContent:'短',proposedContent:''}}),'');
});
test('a failed note run keeps the reason, so the panel can say what to do next',async()=>{
 const p=fixture(async()=>({status:401,text:'bad key'}));
 p.settings={apiConfigs:[deepseek()],activeConfigId:'d'};p.beginAiOperation=()=>new AbortController();p.finishAiOperation=()=>{};
 const error=await p.makeApiRequest('hi').catch(e=>e);
 assert.equal(error.kind,'auth');assert.equal(error.configId,'d');assert.equal(error.status,401);
 const problem=p.failureProblem(p.errorContent(null,error));
 assert.equal(problem.settings,true);assert.equal(problem.keyPage,'https://platform.deepseek.com/api_keys');assert.match(p.failureText(error),/DeepSeek/);
 const busy=fixture(async()=>({status:503,text:'busy'}));busy.settings={apiConfigs:[deepseek()]};busy.beginAiOperation=()=>new AbortController();busy.finishAiOperation=()=>{};
 const e2=await busy.makeApiRequest('hi').catch(e=>e);assert.equal(busy.failureProblem(e2).settings,false);
});
