const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeFile, offlineReview, scoreIssues } = require('../src/rules');
const { parseDiff } = require('../src/collect');
const { review, normalise, buildPrompt } = require('../src/review');
const { extractJson, resolveProvider } = require('../src/providers');
const { parseArgs, shouldFail } = require('../src/cli');
const { toMarkdown } = require('../src/report');

const js = (content, changedLines = null) => ({ file: 'a.js', lang: 'javascript', content, changedLines });
const ids = issues => issues.map(i => i.rule).sort();

// Built at runtime so this fake token never appears in the repo as a literal.
const FAKE_TOKEN = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');

test('detects common JavaScript problems', () => {
    const issues = analyzeFile(js([
        `const token = "${FAKE_TOKEN}";`,
        'if (a == b) {}',
        'var x = parseInt(y);',
        'items.forEach(async i => await save(i));',
        'el.innerHTML = "<b>" + name + "</b>";'
    ].join('\n')));
    const found = ids(issues);
    for (const id of ['hardcoded-secret', 'loose-equality', 'var', 'parseint-radix', 'async-foreach', 'innerhtml']) {
        assert.ok(found.includes(id), `expected ${id} in ${found}`);
    }
});

test('does not flag strict equality, env secrets or comments', () => {
    const issues = analyzeFile(js([
        'if (a === b && c !== d) return;',
        'const apiKey = process.env.API_KEY;',
        '// eval(something) is mentioned in a comment',
        'const re = /x/.exec(str);'
    ].join('\n')));
    assert.deepEqual(issues, []);
});

test('inline codelens-ignore suppresses findings', () => {
    const issues = analyzeFile(js('var a = 1; // codelens-ignore\n// codelens-ignore-next-line\nvar b = 2;\nvar c = 3;'));
    assert.deepEqual(issues.map(i => i.line), [4]);
});

test('python rules', () => {
    const issues = analyzeFile({ file: 'a.py', lang: 'python', changedLines: null, content: 'try:\n    eval(x)\nexcept:\n    pass\nprint("hi")' });
    assert.deepEqual(ids(issues), ['bare-except', 'eval', 'print-debug']);
});

test('diff mode only reports changed lines', () => {
    const changed = parseDiff('+++ b/a.js\n@@ -1,0 +2,2 @@\n+var a = 1;\n+var b = 2;\n');
    assert.deepEqual([...changed.get('a.js')], [2, 3]);
    const issues = analyzeFile(js('var z = 0;\nvar a = 1;\nvar b = 2;', changed.get('a.js')));
    assert.deepEqual(issues.map(i => i.line), [2, 3]);
});

test('score: clean code is 100 and critical issues cap the grade', () => {
    assert.equal(scoreIssues([], 100), 100);
    assert.ok(scoreIssues([{ severity: 'critical' }], 100) <= 69);
    const r = offlineReview([js('const a = 1;')]);
    assert.equal(r.score, 100);
});

test('extractJson handles fenced and chatty replies', () => {
    assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('result: {"b": [1,2]} done'), { b: [1, 2] });
    assert.throws(() => extractJson('no json here'));
});

test('normalise cleans bad model output', () => {
    const files = [{ file: 'src/app.js' }];
    const r = normalise({ score: 140, issues: [{ file: 'app.js', line: 'x', severity: 'HIGH', title: 'T' }, { nope: 1 }] }, files);
    assert.equal(r.score, 100);
    assert.equal(r.issues.length, 1);
    assert.deepEqual(r.issues[0], { file: 'src/app.js', line: null, severity: 'suggestion', category: 'maintainability', title: 'T', detail: '', fix: '' });
});

test('AI review merges offline security findings and caps score', async () => {
    const files = [js('const password = "supersecret123";\nconst a = 1;')];
    const chatImpl = async () => JSON.stringify({ summary: 'ok', score: 95, issues: [] });
    const r = await review(files, { provider: { label: 'Mock', model: 'm' }, chatImpl });
    assert.equal(r.mode, 'ai');
    assert.equal(r.issues[0].rule, 'hardcoded-secret');
    assert.ok(r.score <= 60);
});

test('prompt numbers lines and marks diff lines', () => {
    const { text } = buildPrompt([js('a\nb', new Set([2]))]);
    assert.match(text, /   1 \| a/);
    assert.match(text, /   2\+\| b/);
});

test('provider resolution', () => {
    assert.equal(resolveProvider({}, {}), null);
    const p = resolveProvider({}, { GROQ_API_KEY: 'k' });
    assert.equal(p.name, 'groq');
    assert.equal(p.apiKey, 'k');
    assert.throws(() => resolveProvider({ provider: 'openai' }, {}), /No API key/);
    assert.throws(() => resolveProvider({ provider: 'nope' }, {}), /Unknown provider/);
    assert.equal(resolveProvider({ provider: 'ollama' }, {}).apiKey, '');
    // A generic CODELENS_API_KEY picks the provider from the key format.
    assert.equal(resolveProvider({}, { CODELENS_API_KEY: 'gsk_abc' }).name, 'groq');
    assert.equal(resolveProvider({}, { CODELENS_API_KEY: 'sk-or-v1-abc' }).name, 'openrouter');
    assert.equal(resolveProvider({}, { CODELENS_API_KEY: 'AIzaabc' }).name, 'gemini');
    assert.equal(resolveProvider({ apiKey: 'sk-abc' }, {}).name, 'openai');
});

test('cli args and --fail-on', () => {
    const o = parseArgs(['review', 'src', '--out=r.md', '--model', 'x', '--json']);
    assert.deepEqual(o, { _: ['review', 'src'], out: 'r.md', model: 'x', json: true });
    assert.throws(() => parseArgs(['--model']), /needs a value/);
    const res = { issues: [{ severity: 'warning' }] };
    assert.equal(shouldFail(res, 'critical'), false);
    assert.equal(shouldFail(res, 'warning'), true);
    assert.equal(shouldFail(res, 'suggestion'), true);
});

test('markdown report', () => {
    const md = toMarkdown({ mode: 'offline', score: 80, summary: 's', issues: [{ file: 'a.js', line: 3, severity: 'warning', category: 'bug', title: 'T', detail: 'd', fix: 'f' }], files: ['a.js'] }, { date: new Date('2026-01-01') });
    assert.match(md, /\*\*80\/100\*\*/);
    assert.match(md, /`a\.js:3`/);
    assert.match(md, /🟡 Warning \(1\)/);
});
