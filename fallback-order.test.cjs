const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const module={exports:{}};
 const obsidian=Object.fromEntries(['Plugin','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]));
 obsidian.Notice=class{constructor(){}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{module,console,AbortController,setTimeout,clearTimeout,TextEncoder,TextDecoder,require:()=>obsidian});
 const p=new module.exports();
 p.settings={apiConfigs:[{id:'a',name:'A',apiKey:'k1',enabled:true},{id:'b',name:'B',apiKey:'k2',enabled:true}]};
 p.beginAiOperation=()=>new AbortController();p.finishAiOperation=()=>{};
 return p;
}
test('falls back to B when A fails, then tries B first next time',async()=>{
 const p=fixture();const tried=[];
 p._callSingleConfig=async(prompt,model,json,config)=>{tried.push(config.id);if(config.id==='a')throw new Error('HTTP 503');return 'ok from '+config.id;};
 assert.equal(await p.makeApiRequest('hi'),'ok from b');
 assert.deepEqual(tried,['a','b']);
 tried.length=0;
 assert.equal(await p.makeApiRequest('hi again'),'ok from b');
 assert.deepEqual(tried,['b']);
});
test('keeps the user order when nothing has answered yet',()=>{
 const p=fixture();
 assert.deepEqual(p.orderConfigsForFallback(p.settings.apiConfigs).map(c=>c.id),['a','b']);
});
