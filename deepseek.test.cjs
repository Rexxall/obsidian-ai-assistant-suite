const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{module,console,require:()=>Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]))});
 const p=new module.exports();p.getApiKey=async()=> 'test-key';return p;
}
test('DeepSeek accepts official base, versioned base, full endpoint and custom proxy',()=>{
 const p=fixture();for(const [input,expected] of [[undefined,'https://api.deepseek.com/chat/completions'],['https://api.deepseek.com/','https://api.deepseek.com/chat/completions'],['https://api.deepseek.com/v1','https://api.deepseek.com/v1/chat/completions'],['https://proxy.test/chat/completions/','https://proxy.test/chat/completions']])assert.equal(p.resolveDeepSeekUrl(input),expected);
});
test('DeepSeek structured request preserves selected model, authorization and thinking preference',async()=>{
 const p=fixture();let request;
 p.executeJsonRequest=async(url,options)=>{request={url,...options};return {choices:[{message:{content:'{"tags":["test"]}',reasoning_content:'not the result'}}]};};
 const out=await p._callSingleConfig('Return JSON',null,true,{apiProvider:'deepseek',modelName:'deepseek-v4-pro',deepseekThinking:true});
 assert.equal(out,'{"tags":["test"]}');const body=JSON.parse(request.body);
 assert.equal(request.url,'https://api.deepseek.com/chat/completions');assert.equal(request.headers.Authorization,'Bearer test-key');assert.equal(body.model,'deepseek-v4-pro');assert.equal(body.thinking.type,'enabled');assert.equal(body.response_format.type,'json_object');
});
test('DeepSeek streaming uses shared stream reader and forwards cancellation signal',async()=>{
 const p=fixture(),signal={aborted:false};p.callOpenAiStreaming=async(url,request,options)=>{assert.equal(options.signal,signal);const body=JSON.parse(request.body);assert.equal(body.stream,true);assert.equal(body.model,'deepseek-flash');assert.equal(body.thinking.type,'disabled');return 'stream result';};
 assert.equal(await p._callSingleConfig('hello',null,false,{apiProvider:'deepseek'},{stream:true,signal}),'stream result');
});
test('OpenAI-compatible requests keep their custom endpoint and omit DeepSeek parameters',async()=>{
 const p=fixture();p.executeJsonRequest=async(url,request)=>{assert.equal(url,'https://custom.test/generate');assert.equal(JSON.parse(request.body).thinking,undefined);return {choices:[{message:{content:'ok'}}]};};assert.equal(await p._callSingleConfig('hello',null,false,{apiProvider:'openai',apiUrl:'https://custom.test/generate',modelName:'custom'}),'ok');
});
test('legacy official DeepSeek configs are recognized without changing key, model or priority',()=>{
 const p=fixture(),config={id:'old',name:'DeepSeek',apiProvider:'openai',apiUrl:'https://api.deepseek.com/',apiKey:'encrypted-marker',modelName:'deepseek-v4-flash'};
 p.settings={apiConfigs:[config,{id:'proxy',name:'proxy',apiProvider:'openai',apiUrl:'https://proxy.test/',enabled:false}],oneClickProcessActions:{},customActions:[]};p.normalizeSettings();assert.equal(config.apiProvider,'deepseek');assert.equal(config.apiKey,'encrypted-marker');assert.equal(config.modelName,'deepseek-v4-flash');assert.equal(p.settings.apiConfigs[0],config);assert.equal(p.settings.apiConfigs[1].apiProvider,'openai');
});
