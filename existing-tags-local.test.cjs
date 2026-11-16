const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(requestUrl){
 const module={exports:{}};
 const obsidian={...Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}])),requestUrl};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{URL,window:{setTimeout,clearTimeout,setInterval,clearInterval},module,console,AbortController,TextEncoder,TextDecoder,require:()=>obsidian});
 const p=new module.exports();p.app={secretStorage:{getSecret:id=>'value-of-'+id}};return p;
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
test('the batch summary counts notes and size and lists destinations in fallback order',()=>{
 const p=fixture();
 p.settings={apiConfigs:[{id:'a',name:'Cloud',ai:{provider:'openai',model:'m'}},{id:'b',name:'Laptop',ai:{provider:'ollama',model:'m'},allowFallback:true},{id:'c',name:'Off',ai:{provider:'openai',model:'m'},enabled:false},{id:'d',name:'',ai:{provider:'claude-code',model:'haiku'},allowFallback:true}]};
 p.lastWorkingConfigId='b';
 const out=p.describeBatchSend([{stat:{size:2048}},{stat:{size:1024}}]);
 assert.equal(out.notes,2);assert.equal(out.size,'3 KB');
 assert.deepEqual(JSON.parse(JSON.stringify(out.destinations)),[{name:'Laptop',local:true},{name:'Cloud',local:false},{name:'Claude Code（本机）',local:false}]);
});
