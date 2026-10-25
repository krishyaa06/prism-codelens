/**
 * Command-line interface for Prism CodeLens.
 */
const fs = require('node:fs');
const path = require('node:path');
const c = require('./colors');
const { fromPaths, fromGitDiff } = require('./collect');
const { review, countBySeverity } = require('./review');
const { resolveProvider, PROVIDERS } = require('./providers');
const { banner, spinner, renderReport } = require('./render');
const { toMarkdown } = require('./report');

const HELP = `
  ${c.bold('Usage')}
    codelens review [paths...]      Review files or folders (default: current folder)
    codelens diff [ref] [--staged]  Review only lines changed in git
    codelens demo                   Review the bundled example files
    codelens providers              List supported AI providers

  ${c.bold('Options')}
    --offline              Use the built-in rule engine only (no API key needed)
    --provider <name>      gemini | groq | openrouter | openai | ollama | custom
    --model <id>           Override the model
    --base-url <url>       Custom OpenAI-compatible endpoint
    --focus <text>         Ask the AI to focus on something (e.g. "security")
    --max-files <n>        Max files to review (default 25)
    --out <file.md>        Save a Markdown report
    --json                 Print raw JSON (for scripts / CI)
    --fail-on <level>      Exit with code 1 if issues at level: critical | warning | suggestion
    -h, --help             Show help
    -v, --version          Show version

  ${c.bold('Environment')}
    CODELENS_API_KEY, CODELENS_PROVIDER, CODELENS_MODEL, CODELENS_BASE_URL
    (or GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY)

  ${c.bold('Examples')}
    codelens review src --offline
    GROQ_API_KEY=... codelens review src/app.js --out review.md
    codelens diff --staged --fail-on critical
`;

const VALUE_FLAGS = new Set(['provider', 'model', 'base-url', 'focus', 'max-files', 'out', 'fail-on', 'api-key']);

function parseArgs(argv) {
    const opts = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-h') { opts.help = true; continue; }
        if (arg === '-v') { opts.version = true; continue; }
        if (arg.startsWith('--')) {
            let [key, value] = arg.slice(2).split(/=(.*)/s);
            if (VALUE_FLAGS.has(key)) {
                if (value === undefined) value = argv[++i];
                if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
                opts[key] = value;
            } else {
                opts[key] = true;
            }
        } else {
            opts._.push(arg);
        }
    }
    return opts;
}

const LEVELS = ['critical', 'warning', 'suggestion'];

function shouldFail(result, level) {
    if (!level) return false;
    const idx = LEVELS.indexOf(level);
    if (idx === -1) throw new Error(`--fail-on must be one of ${LEVELS.join(', ')}`);
    const counts = countBySeverity(result.issues);
    return LEVELS.slice(0, idx + 1).some(l => counts[l] > 0);
}

function collectFiles(command, rest, maxFiles, opts) {
    if (command === 'review') return fromPaths(rest, { maxFiles });
    if (command === 'diff') return fromGitDiff({ staged: Boolean(opts.staged), ref: rest[0] || null, maxFiles });
    if (command === 'demo') {
        const root = path.join(__dirname, '..');
        return fromPaths([path.join(root, 'examples')], { maxFiles }).map(f => ({ ...f, file: path.relative(root, f.file) }));
    }
    throw new Error(`Unknown command "${command}". Run codelens --help`);
}

function printProviders() {
    banner();
    for (const [id, p] of Object.entries(PROVIDERS)) {
        console.log(`  ${c.violet(id.padEnd(11))} ${c.white(p.label.padEnd(28))} ${c.gray(p.model || '(set --model)')}`);
    }
    console.log();
}

async function main(argv = process.argv.slice(2)) {
    const opts = parseArgs(argv);
    const version = require('../package.json').version;
    if (opts.version) { console.log(version); return 0; }

    const [command = 'help', ...rest] = opts._;
    if (opts.help || command === 'help') { banner(); console.log(HELP); return 0; }

    if (command === 'providers') { printProviders(); return 0; }

    const maxFiles = opts['max-files'] ? Number(opts['max-files']) : 25;
    if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error('--max-files must be a positive integer');

    const files = collectFiles(command, rest, maxFiles, opts);
    const json = Boolean(opts.json);
    if (!json) banner();

    if (!files.length) {
        if (!json) console.log(`  ${c.yellow('Nothing to review.')} ${c.gray(command === 'diff' ? 'No changed source files in the diff.' : 'No supported source files found.')}\n`);
        else console.log(JSON.stringify({ score: 100, issues: [], files: [] }));
        return 0;
    }

    const offline = opts.offline || (command === 'demo' && !opts.provider);
    const provider = offline ? null : resolveProvider({
        provider: opts.provider, model: opts.model, baseUrl: opts['base-url'], apiKey: opts['api-key']
    });
    if (!json && !provider && !opts.offline && command !== 'demo') {
        console.log(`  ${c.gray('No API key found, running the offline rule engine. Set CODELENS_API_KEY for AI reviews.')}\n`);
    }

    const spin = json ? { stop() {} } : spinner(provider ? `Reviewing ${files.length} file(s) with ${provider.label}…` : `Scanning ${files.length} file(s)…`);
    let result;
    try {
        result = await review(files, { provider, focus: opts.focus });
    } finally {
        spin.stop();
    }

    if (json) console.log(JSON.stringify(result, null, 2));
    else renderReport(result);

    if (opts.out) {
        fs.writeFileSync(opts.out, toMarkdown(result));
        if (!json) console.log(`  ${c.green('✔')} Report saved to ${c.underline(opts.out)}\n`);
    }

    return shouldFail(result, opts['fail-on']) ? 1 : 0;
}

module.exports = { main, parseArgs, shouldFail };
