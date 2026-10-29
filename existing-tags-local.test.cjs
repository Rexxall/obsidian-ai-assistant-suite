const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(requestUrl){
 const module={exports:{}};
 const obsidian={...Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}])),requestUrl};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{window:{setTimeout,clearTimeout,setInterval,clearInterval},module,console,AbortController,TextEncoder,TextDecoder,require:()=>obsidian});
 return new module.exports();
}
test('only-existing mode keeps tags that exist, in the vault spelling, once each',()=>{
 const p=fixture();
 const out=p.keepExistingTags(['#Research/Robotics','research/robotics','new/tag',' 日本語 ','machine learning'],['research/robotics','日本語','machine-learning']);
 assert.deepEqual(JSON.parse(JSON.stringify(out)),['research/robotics','日本語','machine-learning']);
});
test('the tagger prompt adds the only-existing rule only when the setting is on',()=>{
 const p=fixture();
 p.settings={taggerPrompt:'tags: {{existing_tags}} / {{content}} / {{count}}',taggerSuggestionsCount:5,taggerExistingOnly:false};
 assert.equal(p.getTaggerPrompt(['a','b'],'body'),'tags: a， b / body / 5');
 p.settings.taggerExistingOnly=true;
 assert.match(p.getTaggerPrompt(['a'],'body'),/只能从“现有标签列表”里挑选/);
});
test('a local model needs no key, uses the Ollama address by default and sends no Authorization header',async()=>{
 let seen;
 const p=fixture(async(request)=>{seen=request;return {status:200,text:'{"choices":[{"message":{"content":"ok"}}]}'};});
 p.getApiKey=async()=>'';
 const config={apiProvider:'local',modelName:'qwen3:8b'};
 assert.equal(p.isConfigUsable(config),true);
 assert.equal(await p._callSingleConfig('hi',null,true,config),'ok');
 assert.equal(seen.url,'http://localhost:11434/v1/chat/completions');
 assert.equal(seen.headers.Authorization,undefined);
 const body=JSON.parse(seen.body);assert.equal(body.model,'qwen3:8b');assert.equal(body.response_format,undefined);
});
test('cloud providers still refuse to run without a key',async()=>{
 const p=fixture(async()=>{throw new Error('should not be called');});
 p.getApiKey=async()=>'';
 assert.equal(p.isConfigUsable({apiProvider:'openai',apiUrl:'https://x.test'}),false);
 await assert.rejects(p._callSingleConfig('hi',null,false,{apiProvider:'openai',apiUrl:'https://x.test'}),/还没有填写 API 密钥/);
});
test('the batch summary counts notes and size and lists destinations in fallback order',()=>{
 const p=fixture();
 p.settings={apiConfigs:[{id:'a',name:'Cloud',apiProvider:'openai',apiKey:'k'},{id:'b',name:'Laptop',apiProvider:'local',allowFallback:true},{id:'c',name:'Off',apiProvider:'openai',apiKey:'k',enabled:false}]};
 p.lastWorkingConfigId='b';
 const out=p.describeBatchSend([{stat:{size:2048}},{stat:{size:1024}}]);
 assert.equal(out.notes,2);assert.equal(out.size,'3 KB');
 assert.deepEqual(JSON.parse(JSON.stringify(out.destinations)),[{name:'Laptop',local:true},{name:'Cloud',local:false}]);
});
