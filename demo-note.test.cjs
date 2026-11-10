const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture(files) {
    const module = { exports: {} };
    const context = { module, console, TextEncoder, TextDecoder, Notice: class {}, navigator: {language: 'en'}, window: {}, document: {}, require(name) {
        if (name !== 'obsidian') throw Error('No shared runtime');
        return Object.fromEntries(['Plugin','Notice','PluginSettingTab','Setting','FuzzySuggestModal','Modal','ItemView','TFile'].map(k=>[k,class{}]));
    }};
    vm.runInNewContext(fs.readFileSync(__dirname+'/main.js','utf8'), context);
    const plugin = new module.exports();
    const store = new Map(Object.entries(files));
    const trashed = [];
    const entry = path => ({ path, extension: 'md', basename: path.replace(/\.md$/, '') });
    plugin.app = {
        vault: {
            getAbstractFileByPath: path => store.has(path) ? entry(path) : null,
            cachedRead: async file => store.get(file.path),
            create: async (path, text) => { store.set(path, text); return entry(path); },
            process: async (file, fn) => { store.set(file.path, fn(store.get(file.path))); },
            getRoot: () => ({ children: [...store.keys()].map(entry) }),
            getMarkdownFiles: () => [],
        },
        metadataCache: { getFileCache: () => null },
        workspace: { getLeaf: () => ({ openFile: async () => {} }) },
        fileManager: { trashFile: async file => { trashed.push(file.path); store.delete(file.path); } },
    };
    plugin.activateView = async () => {};
    plugin.createDiffPreviewTask = async () => {};
    plugin.view = { tasks: [], getTask: () => ({content: {}}), addTask() {}, render() {} };
    return { plugin, store, trashed };
}
test('loading the example leaves a same-named note of the user alone', async () => {
    const { plugin, store } = fixture({});
    const name = plugin.demoNotePath();
    store.set(name, 'my own note');
    await plugin.loadDemo();
    assert.equal(store.get(name), 'my own note');
    const second = name.replace(/\.md$/, ' 2.md');
    assert.match(store.get(second), /^---\nai-assistant-demo: true\n---/);
    store.set(second, store.get(second) + '\nedited');
    await plugin.loadDemo();
    assert.doesNotMatch(store.get(second), /edited/);
    assert.equal(store.size, 2);
});
test('removing the example trashes only a note that carries the demo flag', async () => {
    const { plugin, store, trashed } = fixture({});
    const name = plugin.demoNotePath();
    store.set(name, 'my own note');
    await plugin.removeDemo();
    assert.deepEqual(trashed, []);
    await plugin.loadDemo();
    await plugin.removeDemo();
    assert.deepEqual(trashed, [name.replace(/\.md$/, ' 2.md')]);
    assert.equal(store.get(name), 'my own note');
});
