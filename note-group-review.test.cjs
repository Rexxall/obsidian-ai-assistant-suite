const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const module={exports:{}};const classes=Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]));
 vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'),{module,console,TextEncoder,TextDecoder,require:()=>({...classes,parseYaml:JSON.parse,stringifyYaml:JSON.stringify})});
 const p=new module.exports(),file={path:'Inbox/note.md',name:'note.md',basename:'note',parent:{path:'Inbox'}};let text='---\n{"owner":"reader","tags":["existing"]}\n---\nBody',failRename=false,race=false;const folders=new Set(['Inbox','Library']),conflicts=new Set();
 p.settings={rollbackHistory:[],rollbackRedoHistory:[]};p.saveSettings=async()=>{};p.addToHistory=()=>{};p.generateFileId=()=>'';
 p.app={vault:{read:async()=>text,process:async(_,fn)=>{if(race){text+=' user';race=false;}text=fn(text);},getAbstractFileByPath:path=>path===file.path?file:folders.has(path)?{children:[]}:conflicts.has(path)?{}:null,createFolder:async path=>folders.add(path)},fileManager:{renameFile:async(_,path)=>{if(failRename)throw Error('rename failed');file.path=path;file.name=path.split('/').at(-1);file.basename=file.name.slice(0,-3);file.parent.path=path.split('/').slice(0,-1).join('/');}}};
 const task={id:'suggestion',type:'one-click',content:{file,originalContent:text}},group={file,tasks:[task]};
 const draft={originalTaskId:'suggestion',meta:{title:'Updated',summary:'Summary',tldr:'Short'},tags:['added'],useMeta:true,useTags:true,useFolder:true,folder:'Library',rename:true};
 return {p,file,task,group,draft,conflicts,get text(){return text},set text(v){text=v},set failRename(v){failRename=v},set race(v){race=v}};
}
test('one note acceptance preserves other properties and combines tags, metadata and rename; undo restores exact text/path',async()=>{
 const f=fixture(),before=f.text;await f.p.applyNoteGroup(f.group,f.draft);assert.equal(f.file.path,'Library/Updated.md');assert.match(f.text,/"owner":"reader"/);assert.match(f.text,/"tags":\["existing","added"\]/);assert.equal(f.p.settings.rollbackHistory.length,1);assert.equal(f.task.content.noteApplied,true);await f.p.undoNoteGroup(f.group);assert.equal(f.file.path,'Inbox/note.md');assert.equal(f.text,before);assert.equal(f.task.content.noteApplied,false);
});
test('stale suggestions, destination collisions and user edits at write time are guarded',async()=>{
 for(const mode of ['stale','collision','race']){const f=fixture(),before=f.text;if(mode==='stale')f.text+=' user';if(mode==='collision')f.conflicts.add('Library/Updated.md');if(mode==='race')f.race=true;await assert.rejects(f.p.applyNoteGroup(f.group,f.draft));assert.equal(f.file.path,'Inbox/note.md');assert.equal(f.text,mode==='collision'?before:before+' user');assert.equal(f.p.settings.rollbackHistory.length,0);}
});
test('rename failure restores the original content; duplicate confirmation does not write twice',async()=>{
 const f=fixture(),before=f.text;f.failRename=true;await assert.rejects(f.p.applyNoteGroup(f.group,f.draft));assert.equal(f.text,before);assert.equal(f.p.settings.rollbackHistory.length,0);f.failRename=false;await f.p.applyNoteGroup(f.group,f.draft);await f.p.applyNoteGroup(f.group,f.draft);assert.equal(f.p.settings.rollbackHistory.length,1);
});
test('undo refuses to overwrite subsequent edits or an occupied original path',async()=>{
 const f=fixture();await f.p.applyNoteGroup(f.group,f.draft);const applied=f.text;f.text+=' personal';await assert.rejects(f.p.undoNoteGroup(f.group));assert.equal(f.text,applied+' personal');f.text=applied;f.conflicts.add('Inbox/note.md');await assert.rejects(f.p.undoNoteGroup(f.group));assert.equal(f.text,applied);assert.equal(f.file.path,'Library/Updated.md');
});
test('disabled sections remain untouched and empty confirmation produces no snapshot',async()=>{
 const f=fixture(),before=f.text;Object.assign(f.draft,{useMeta:false,useTags:false,useFolder:false});await assert.rejects(f.p.applyNoteGroup(f.group,f.draft),/没有选中/);assert.equal(f.text,before);assert.equal(f.p.settings.rollbackHistory.length,0);
});
test('global rollback routes a grouped snapshot through content and path restoration',async()=>{
 const f=fixture(),before=f.text;await f.p.applyNoteGroup(f.group,f.draft);await f.p.rollbackLastChange();assert.equal(f.text,before);assert.equal(f.file.path,'Inbox/note.md');
});
