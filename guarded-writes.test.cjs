const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture(initial) {
    const state = { text: initial, race: false, writes: 0 };
    const module = { exports: {} };
    const context = { module, console, TextEncoder, TextDecoder, Notice: class {}, require(name) {
        if (name !== 'obsidian') throw Error('No shared runtime');
        return Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]));
    }};
    vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'), context);
    const plugin = new module.exports();
    const file = {path:'note.md',basename:'note'};
    plugin.settings = {rollbackHistory:[],rollbackRedoHistory:[]};
    plugin.saveSettings = async () => {};
    plugin.app = {vault:{ read: async()=>state.text, getAbstractFileByPath:()=>file, process:async(_,fn)=>{
        if(state.race) {state.text+=' user';state.race=false;}
        state.text=fn(state.text);state.writes++;
    }}};
    return {plugin,file,state};
}
test('undo and redo round-trip; later edits prevent both destructive operations',async()=>{
    const {plugin,file,state}=fixture('before');
    await plugin.applyContentChange(file,'test','before','after');
    await plugin.rollbackLastChange();assert.equal(state.text,'before');
    state.text+=' later';await plugin.redoLastRollback();assert.equal(state.text,'before later');
    state.text='before';await plugin.redoLastRollback();assert.equal(state.text,'after');
    state.text+=' later';await plugin.rollbackLastChange();assert.equal(state.text,'after later');
    assert.equal(plugin.settings.rollbackHistory.length,1);
});
test('race inside Vault.process preserves user edit and removes unapplied snapshot',async()=>{
    const {plugin,file,state}=fixture('before');state.race=true;
    await assert.rejects(plugin.applyContentChange(file,'test','before','after'));
    assert.equal(state.text,'before user');assert.equal(plugin.settings.rollbackHistory.length,0);
});
test('concurrent appends use the latest text and retain independent undo steps',async()=>{
    const {plugin,file,state}=fixture('before user');
    await Promise.all([plugin.applyContentChange(file,'a',null,text=>text+' A'),plugin.applyContentChange(file,'b',null,text=>text+' B')]);
    assert.equal(state.text,'before user A B');
    await plugin.rollbackLastChange();assert.equal(state.text,'before user A');
});
test('stale generated preview never overwrites the current note',async()=>{
    const {plugin,file,state}=fixture('new text');
    await assert.rejects(plugin.applyContentChange(file,'test','old text','AI text'));
    assert.equal(state.writes,0);assert.equal(state.text,'new text');
});
