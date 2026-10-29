const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Shapes copied from real 1.3.x data files with every value replaced; no real content or keys.
function load(stored){
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{window:{setTimeout,clearTimeout,setInterval,clearInterval,crypto:globalThis.crypto},module,console,TextEncoder,TextDecoder,btoa,atob,escape,unescape,require:()=>Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]))});
 const p=new module.exports();let saved=null;
 p.loadData=async()=>JSON.parse(JSON.stringify(stored));p.saveData=async d=>{saved=JSON.parse(JSON.stringify(d));};
 return {p,get saved(){return saved;}};
}
const history=[{action:'标签',fileId:'id-1',fileName:'Note A',filePath:'Folder/Note A.md',timestamp:1}];
test('a 1.3 flat file becomes one configuration and keeps its key, model and history',async()=>{
 const f=load({apiProvider:'gemini',apiKey:'test-key-123',apiUrl:'https://example.test/v1',modelName:'model-a',auxiliaryModelName:'model-b',processingHistory:history,totalProcessedCount:7,oneClickProcessActions:{furigana:true,meta:false}});
 await f.p.loadSettings();
 const configs=f.p.settings.apiConfigs;assert.equal(configs.length,1);
 assert.equal(configs[0].apiProvider,'gemini');assert.equal(configs[0].modelName,'model-a');assert.equal(configs[0].auxiliaryModelName,'model-b');assert.equal(configs[0].apiUrl,'https://example.test/v1');
 assert.equal(await f.p.getApiKey(configs[0]),'test-key-123');assert.ok(configs[0].apiKey.startsWith('__ENC__:'));
 assert.equal(f.p.settings.activeConfigId,configs[0].id);
 for(const k of ['apiProvider','apiKey','apiUrl','modelName','auxiliaryModelName'])assert.equal(f.saved[k],undefined);
 assert.equal(f.saved.processingHistory.length,1);assert.equal(f.saved.totalProcessedCount,7);assert.equal(f.saved.oneClickProcessActions.furigana,true);
});
test('a 1.3.6 multi-configuration file keeps every configuration, the active one and the counters',async()=>{
 const configs=[{id:'default',name:'A',apiProvider:'gemini',apiKey:'k-a',apiUrl:'u',modelName:'m',auxiliaryModelName:'m2',enabled:true},{id:'config_2',name:'B',apiProvider:'openai',apiKey:'k-b',apiUrl:'u',modelName:'m',auxiliaryModelName:'m2',enabled:true}];
 const f=load({activeConfigId:'config_2',apiConfigs:configs,processingHistory:history,dailyProcessedCounts:{'2026-01-01':3},actionUsageCounts:{标签:2},ignoredFolders:'Archive',taggerPrompt:'custom prompt'});
 await f.p.loadSettings();
 assert.deepEqual(f.p.settings.apiConfigs.map(c=>c.id),['default','config_2']);assert.equal(f.p.settings.activeConfigId,'config_2');
 assert.equal(await f.p.getApiKey(f.p.settings.apiConfigs[1]),'k-b');
 assert.equal(f.p.settings.ignoredFolders,'Archive');assert.equal(f.p.settings.taggerPrompt,'custom prompt');
 assert.equal(f.p.settings.dailyProcessedCounts['2026-01-01'],3);assert.equal(f.p.settings.actionUsageCounts.标签,2);
 assert.equal(f.p.settings.apiConfigs[1].allowFallback,undefined);
});
test('a fresh install starts with a DeepSeek configuration and no key',async()=>{
 const f=load({});await f.p.loadSettings();
 assert.equal(f.p.settings.apiConfigs.length,1);assert.equal(f.p.settings.apiConfigs[0].apiProvider,'deepseek');assert.equal(f.p.settings.apiConfigs[0].modelName,'deepseek-flash');assert.equal(f.p.settings.ignoredFolders,'');
});
