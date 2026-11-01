const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const module={exports:{}};
 const obsidian=Object.fromEntries(['Plugin','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]));
 obsidian.Notice=class{constructor(){}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{window:{setTimeout,clearTimeout,setInterval,clearInterval,crypto:globalThis.crypto},module,console,AbortController,setTimeout,clearTimeout,TextEncoder,TextDecoder,require:()=>obsidian});
 const p=new module.exports();
 p.settings={apiConfigs:[{id:'a',name:'A',apiKey:'k1',enabled:true},{id:'b',name:'B',apiKey:'k2',enabled:true,allowFallback:true}]};
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

test('without the backup tick a failure stops and nothing is sent elsewhere',async()=>{
 const p=fixture();p.settings.apiConfigs[1].allowFallback=false;const tried=[];
 p._callSingleConfig=async(prompt,model,json,config)=>{tried.push(config.id);throw new Error('HTTP 503');};
 await assert.rejects(p.makeApiRequest('hi'),/配置「A」失败: HTTP 503[\s\S]*没有勾选“允许用作备用”/);
 assert.deepEqual(tried,['a']);
});
test('only ticked configs are used as backups, in priority order',async()=>{
 const p=fixture();p.settings.apiConfigs.push({id:'c',name:'C',apiKey:'k3',enabled:true});p.settings.apiConfigs[1].allowFallback=false;p.settings.apiConfigs[2].allowFallback=true;const tried=[];
 p._callSingleConfig=async(prompt,model,json,config)=>{tried.push(config.id);if(config.id==='a')throw new Error('down');return config.id;};
 assert.equal(await p.makeApiRequest('hi'),'c');assert.deepEqual(tried,['a','c']);
});
test('the batch note only promises "stays on this computer" when every destination is local',()=>{
 const p=fixture();const local={id:'l',name:'Laptop',apiProvider:'local'},cloud={id:'c',name:'Cloud',apiProvider:'openai',apiKey:'k'};
 const lines=configs=>{p.settings.apiConfigs=configs;p.lastWorkingConfigId=null;return p.batchSendLines(p.describeBatchSend([]).destinations).join(' ');};
 assert.match(lines([local]),/不离开这台电脑/);assert.match(lines([local]),/停下来/);
 assert.match(lines([local,{...cloud}]),/不离开这台电脑/);
 const mixed=lines([local,{...cloud,allowFallback:true}]);
 assert.doesNotMatch(mixed,/不离开这台电脑/);assert.match(mixed,/主服务失败时，笔记可能发给 「Cloud」/);
 assert.doesNotMatch(lines([cloud]),/不离开/);
});
test('data from before backup permission is asked once and keeps the chosen behaviour',async()=>{
 const p=fixture();p.saveSettings=async()=>{};
 p.settings.apiConfigs.forEach(c=>delete c.allowFallback);
 assert.equal(p.needsBackupReview(),true);
 assert.equal(p.fallbackChain().map(c=>c.id).join(),'a');
 await p.applyBackupChoice(true);
 assert.equal(p.needsBackupReview(),false);
 assert.equal(p.fallbackChain().map(c=>c.id).join(),'a,b');
});
test('no question when a backup was ever chosen, or for a single configuration',()=>{
 const p=fixture();
 assert.equal(p.needsBackupReview(),false);
 p.settings.apiConfigs=[{id:'a',name:'A',apiKey:'k1',enabled:true}];
 assert.equal(p.needsBackupReview(),false);
});
