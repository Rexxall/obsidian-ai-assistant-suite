const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function fixture(requestUrl=async()=>({status:200,text:'{"choices":[{"message":{"content":"OK"}}]}'})){
 const module={exports:{}};
 const obsidian=Object.fromEntries(['Plugin','Notice','PluginSettingTab','SettingPage','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]));
 obsidian.requestUrl=requestUrl;obsidian.getLanguage=()=>'en';obsidian.apiVersion='1.14.5';obsidian.Platform={isMobile:false,isMacOS:true};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{window:{setTimeout,clearTimeout,setInterval,clearInterval,crypto:globalThis.crypto},navigator:{platform:'test'},AbortController,module,console,require:()=>obsidian});
 const p=new module.exports();p.manifest={version:'x'};p.settings={apiConfigs:[]};p.getApiKey=async c=>c.apiKey?'sk-secretvalue123456':'';p.hasStoredApiKey=c=>!!c.apiKey;return p;
}
test('preset providers use the official address when empty and accept a base URL',()=>{
 const p=fixture();
 assert.equal(p.resolveProviderUrl({apiProvider:'qwen'}),'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
 assert.equal(p.resolveProviderUrl({apiProvider:'kimi',apiUrl:'https://api.moonshot.cn/v1/'}),'https://api.moonshot.cn/v1/chat/completions');
 assert.equal(p.resolveProviderUrl({apiProvider:'openai',apiUrl:'https://custom.test/generate'}),'https://custom.test/generate');
 assert.equal(p.resolveProviderUrl({apiProvider:'local'}),'http://localhost:11434/v1/chat/completions');
});
test('old OpenAI-compatible configs pointing at a preset host become that preset and keep their values',()=>{
 const p=fixture();const c={id:'a',name:'SF',apiProvider:'openai',apiUrl:'https://api.siliconflow.cn/v1/chat/completions',modelName:'x/y',apiKey:'enc'};
 p.settings={apiConfigs:[c,{id:'b',apiProvider:'openai',apiUrl:'https://proxy.test/v1'}]};p.normalizeSettings();
 assert.equal(c.apiProvider,'siliconflow');assert.equal(c.apiUrl,'https://api.siliconflow.cn/v1/chat/completions');assert.equal(c.modelName,'x/y');assert.equal(p.settings.apiConfigs[1].apiProvider,'openai');
});
test('test connection tells missing key, missing URL and each server answer apart',async()=>{
 const cases=[[401,'{"error":{"message":"Incorrect API key provided: sk-secretvalue123456"}}','auth'],[402,'Insufficient Balance','quota'],[429,'You exceeded your current quota','quota'],[429,'TPM limit','rate'],[400,'{"error":{"message":"Model Not Exist"}}','model'],[400,'{"error":{"message":"The supported API model names are a, b, but you passed c."}}','model'],[404,'404 page not found','url'],[503,'busy','server']];
 for(const [status,text,kind] of cases){
  const p=fixture(async()=>({status,text}));const r=await p.validateApiConfig({apiProvider:'deepseek',apiKey:'enc',modelName:'deepseek-flash'});
  assert.equal(r.valid,false);assert.equal(r.kind,kind,`${status} ${text}`);assert.ok(r.next.length>0);
  assert.ok(!JSON.stringify(r).includes('secretvalue'),'key never appears in the result');
 }
 const p=fixture();
 assert.equal((await p.validateApiConfig({apiProvider:'deepseek'})).kind,'no-key');
 assert.equal((await p.validateApiConfig({apiProvider:'openai',apiKey:'enc',modelName:'m'})).kind,'no-url');
 const net=fixture(async()=>{throw new Error('net::ERR_CONNECTION_REFUSED');});
 assert.equal((await net.validateApiConfig({apiProvider:'local'})).kind,'network');
});
test('a successful test sends a tiny capped request and reads no notes',async()=>{
 let body;const p=fixture(async(req)=>{body=JSON.parse(req.body);return {status:200,text:'{"choices":[{"message":{"content":""}}]}'};});
 const r=await p.validateApiConfig({apiProvider:'zhipu',apiKey:'enc'});
 assert.equal(r.valid,true);assert.equal(body.max_tokens,16);assert.equal(body.model,'glm-5.3');assert.equal(body.messages.length,1);assert.ok(body.messages[0].content.length<20);
});
test('diagnostics list provider, host and model but never the key or the full address',()=>{
 const p=fixture();p.settings={apiConfigs:[{apiProvider:'openai',apiUrl:'https://proxy.test/secret-path?token=abc',apiKey:'enc',modelName:'m'}]};p.lastApiProblem={kind:'auth',status:401,at:0};
 const d=p.buildDiagnostics();
 assert.match(d,/provider=openai host=proxy\.test model=m/);assert.match(d,/key=set/);assert.match(d,/Last test: auth \(HTTP 401\)/);
 assert.ok(!d.includes('secret-path')&&!d.includes('token=abc')&&!d.includes('enc'));
});
test('a suggestion much shorter than the note carries a warning before it is applied',()=>{
 const p=fixture();const long='段落内容。'.repeat(100);
 assert.match(p.shrinkWarning({content:{originalContent:long,proposedContent:long.slice(0,100)}}),/short|短了/);
 assert.equal(p.shrinkWarning({content:{originalContent:long,proposedContent:long.slice(0,400)}}),'');
 assert.equal(p.shrinkWarning({content:{originalContent:'短',proposedContent:''}}),'');
});
test('test connection reports address, key, model and parameters separately',async()=>{
 const states=async(status,text)=>{const p=fixture(async()=>({status,text}));const r=await p.validateApiConfig({apiProvider:'deepseek',apiKey:'enc',modelName:'deepseek-flash'});return [r.kind,r.checks.map(c=>c.state).join(' ')].join(': ');};
 assert.equal(await states(200,'{"choices":[{"message":{"content":"OK"}}]}'),'ok: ok ok ok ok');
 assert.equal(await states(404,'404 page not found'),'url: fail skip skip skip');
 assert.equal(await states(401,'bad key'),'auth: ok fail skip skip');
 assert.equal(await states(400,'{"error":{"message":"Model Not Exist"}}'),'model: ok ok fail skip');
 assert.equal(await states(400,'{"error":{"message":"Unrecognized request argument: thinking"}}'),'params: ok ok ok fail');
 assert.equal(await states(503,'busy'),'server: ok skip skip skip');
 const p=fixture();assert.equal((await p.validateApiConfig({apiProvider:'deepseek'})).checks.map(c=>c.state).join(' '),'skip fail skip skip');
});
test('a key in the address is masked in error details',async()=>{
 const p=fixture(async()=>({status:418,text:'GET https://x.test/v1?key=AQ.secretvalue123&alt=json failed'}));
 const r=await p.validateApiConfig({apiProvider:'deepseek',apiKey:'enc',modelName:'deepseek-flash'});
 assert.doesNotMatch(r.message,/secretvalue123/);assert.match(r.message,/key=\[key\]/);
});
