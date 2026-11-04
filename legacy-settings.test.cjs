const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Shapes copied from real 1.3.x data files with every value replaced; no real content or keys.
// A stand-in for Obsidian's secret storage; `taken` holds keys other plugins saved before.
function secrets(taken={}){const m=new Map(Object.entries(taken));return {map:m,getSecret:id=>m.get(id)??null,setSecret:(id,v)=>{if(!/^[a-z0-9-]+$/.test(id))throw new Error('bad id '+id);m.set(id,v);},listSecrets:()=>[...m.keys()]};}
// '__ENC__:…' is the 1.7.1 format of the fake key 'test-key-123'.
const ENCRYPTED='__ENC__:ai-assistant-suite:AAAAAAAAAAAAAAAABBevcsolL3bPJ8lFSzNVpBBEvbWksbIuna9K9Q==';
function load(stored,storage=secrets()){
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{window:{setTimeout,clearTimeout,setInterval,clearInterval,crypto:globalThis.crypto},module,console,TextEncoder,TextDecoder,btoa,atob,escape,unescape,require:()=>Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]))});
 const p=new module.exports();p.app={secretStorage:storage};let saved=null;
 p.loadData=async()=>JSON.parse(JSON.stringify(stored));p.saveData=async d=>{saved=JSON.parse(JSON.stringify(d));};
 return {p,storage,get saved(){return saved;}};
}
const history=[{action:'标签',fileId:'id-1',fileName:'Note A',filePath:'Folder/Note A.md',timestamp:1}];
test('a 1.3 flat file becomes one configuration and keeps its key, model and history',async()=>{
 const f=load({apiProvider:'gemini',apiKey:'test-key-123',apiUrl:'https://example.test/v1',modelName:'model-a',auxiliaryModelName:'model-b',processingHistory:history,totalProcessedCount:7,oneClickProcessActions:{furigana:true,meta:false}});
 await f.p.loadSettings();
 const configs=f.p.settings.apiConfigs;assert.equal(configs.length,1);
 assert.equal(configs[0].apiProvider,'gemini');assert.equal(configs[0].modelName,'model-a');assert.equal(configs[0].auxiliaryModelName,'model-b');assert.equal(configs[0].apiUrl,'https://example.test/v1');
 assert.equal(f.p.getApiKey(configs[0]),'test-key-123');assert.equal(configs[0].apiKeySecret,'gemini-api-key');
 assert.ok(!JSON.stringify(f.saved).includes('test-key-123'),'no key in data.json');assert.equal(f.saved.apiConfigs[0].apiKey,undefined);
 assert.equal(f.p.settings.activeConfigId,configs[0].id);
 for(const k of ['apiProvider','apiKey','apiUrl','modelName','auxiliaryModelName'])assert.equal(f.saved[k],undefined);
 assert.equal(f.saved.processingHistory.length,1);assert.equal(f.saved.totalProcessedCount,7);assert.equal(f.saved.oneClickProcessActions.furigana,true);
});
test('a 1.3.6 multi-configuration file keeps every configuration, the active one and the counters',async()=>{
 const configs=[{id:'default',name:'A',apiProvider:'gemini',apiKey:'k-a',apiUrl:'u',modelName:'m',auxiliaryModelName:'m2',enabled:true},{id:'config_2',name:'B',apiProvider:'openai',apiKey:'k-b',apiUrl:'u',modelName:'m',auxiliaryModelName:'m2',enabled:true}];
 const f=load({activeConfigId:'config_2',apiConfigs:configs,processingHistory:history,dailyProcessedCounts:{'2026-01-01':3},actionUsageCounts:{标签:2},ignoredFolders:'Archive',taggerPrompt:'custom prompt'});
 await f.p.loadSettings();
 assert.deepEqual(f.p.settings.apiConfigs.map(c=>c.id),['default','config_2']);assert.equal(f.p.settings.activeConfigId,'config_2');
 assert.equal(f.p.getApiKey(f.p.settings.apiConfigs[1]),'k-b');assert.equal(f.p.settings.apiConfigs[1].apiKeySecret,'ai-assistant-suite-config-2-api-key');
 assert.ok(!/"k-[ab]"/.test(JSON.stringify(f.saved)));
 assert.equal(f.p.settings.ignoredFolders,'Archive');assert.equal(f.p.settings.taggerPrompt,'custom prompt');
 assert.equal(f.p.settings.dailyProcessedCounts['2026-01-01'],3);assert.equal(f.p.settings.actionUsageCounts.标签,2);
 assert.equal(f.p.settings.apiConfigs[1].allowFallback,undefined);
});
test('a fresh install starts with a DeepSeek configuration and no key',async()=>{
 const f=load({});await f.p.loadSettings();
 assert.equal(f.p.settings.apiConfigs.length,1);assert.equal(f.p.settings.apiConfigs[0].apiProvider,'deepseek');assert.equal(f.p.settings.apiConfigs[0].modelName,'deepseek-flash');assert.equal(f.p.settings.ignoredFolders,'');
});
test('1.7 encrypted keys move to shared names, without overwriting another plugin\'s key',async()=>{
 const storage=secrets({'deepseek-api-key':'someone-elses-key'});
 const configs=[{id:'default',name:'G',apiProvider:'gemini',apiKey:ENCRYPTED,enabled:true},{id:'config_1',name:'D',apiProvider:'deepseek',apiKey:ENCRYPTED,enabled:true},{id:'config_2',name:'Q',apiProvider:'qwen',apiKey:'[REDACTED]',enabled:true}];
 const f=load({activeConfigId:'default',apiConfigs:configs},storage);
 await f.p.loadSettings();
 const [g,d,q]=f.p.settings.apiConfigs;
 assert.equal(g.apiKeySecret,'gemini-api-key');assert.equal(storage.map.get('gemini-api-key'),'test-key-123');
 assert.equal(d.apiKeySecret,'ai-assistant-suite-config-1-api-key');assert.equal(storage.map.get('deepseek-api-key'),'someone-elses-key');
 assert.equal(q.apiKeySecret,undefined);assert.ok(f.p.isConfigUsable(g));assert.ok(!f.p.isConfigUsable(q));
 assert.ok(!JSON.stringify(f.saved).includes('apiKey"'),'no apiKey field left');assert.ok(!JSON.stringify(f.saved).includes('__ENC__'));
});
test('an already shared key with the same value is reused, and a second load changes nothing',async()=>{
 const storage=secrets({'gemini-api-key':'test-key-123'});
 const f=load({apiConfigs:[{id:'default',name:'G',apiProvider:'gemini',apiKey:ENCRYPTED,enabled:true}]},storage);
 await f.p.loadSettings();assert.equal(f.p.settings.apiConfigs[0].apiKeySecret,'gemini-api-key');assert.equal(storage.map.size,1);
 const again=load(f.saved,storage);await again.p.loadSettings();assert.equal(again.saved,null);
});
test('a key that cannot be read stays in the settings instead of being dropped',async()=>{
 const f=load({apiConfigs:[{id:'default',name:'G',apiProvider:'gemini',apiKey:'__ENC__:ai-assistant-suite:broken',enabled:true}]});
 const errors=console.error;console.error=()=>{};
 try{await f.p.loadSettings();}finally{console.error=errors;}
 assert.equal(f.p.settings.apiConfigs[0].apiKey,'__ENC__:ai-assistant-suite:broken');assert.equal(f.storage.map.size,0);
});
