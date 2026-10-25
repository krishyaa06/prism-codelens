/**
 * Offline rule engine — fast heuristic checks that run without any API key.
 * Each rule inspects one line (plus light file context) and reports issues.
 */

const SEVERITY_WEIGHT = { critical: 15, warning: 6, suggestion: 2 };

const JS_LIKE = new Set(['javascript', 'typescript', 'vue', 'svelte', 'html']);

/** @type {Array<{id:string, severity:string, category:string, langs?:Set<string>|null, test:(line:string, ctx:object)=>boolean, title:string, detail:string, fix:string}>} */
const RULES = [
    {
        id: 'hardcoded-secret', severity: 'critical', category: 'security', langs: null,
        test: l => /(api[_-]?key|secret|token|password|passwd|private[_-]?key)\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i.test(l)
            && !/process\.env|os\.environ|getenv|example|your[_-]/i.test(l),
        title: 'Hard-coded secret',
        detail: 'A credential appears to be committed in source code. Anyone with repo access (or the public) can steal it.',
        fix: 'Move it to an environment variable (e.g. process.env.API_KEY), add .env to .gitignore and rotate the leaked key.'
    },
    {
        id: 'known-token-format', severity: 'critical', category: 'security', langs: null,
        test: l => /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27})/.test(l),
        title: 'Leaked API token',
        detail: 'This string matches a known token format (OpenAI, GitHub, Google, Slack or Discord).',
        fix: 'Revoke the token immediately, then load it from an environment variable.'
    },
    {
        id: 'eval', severity: 'critical', category: 'security', langs: null,
        test: l => /(^|[^\w.])(eval|exec)\s*\(/.test(l) && !/\.exec\(/.test(l) && !/^\s*(\/\/|#)/.test(l),
        title: 'Dynamic code execution',
        detail: 'eval/exec runs arbitrary strings as code, a classic remote-code-execution vector.',
        fix: 'Parse data with JSON.parse / ast.literal_eval or use an explicit lookup table instead.'
    },
    {
        id: 'innerhtml', severity: 'warning', category: 'security', langs: JS_LIKE,
        test: l => /\.innerHTML\s*\+?=\s*(?!['"`]\s*['"`])/.test(l) && /(\$\{|\+\s*\w)/.test(l)
            && !/\b(esc|escape\w*|sanitize\w*|DOMPurify)\(/.test(l),
        title: 'Possible XSS via innerHTML',
        detail: 'Interpolated values are written as HTML. If any value comes from users or an API, scripts can be injected.',
        fix: 'Use textContent, or escape values before building HTML.'
    },
    {
        id: 'sql-concat', severity: 'critical', category: 'security', langs: null,
        test: l => /(select|insert|update|delete)\s.+(from|into|set|where)/i.test(l) && /(\+\s*\w|\$\{|%s|\.format\(|f["'])/.test(l),
        title: 'SQL built with string concatenation',
        detail: 'User input concatenated into SQL allows SQL injection.',
        fix: 'Use parameterised queries / prepared statements (e.g. db.query("... WHERE id = ?", [id])).'
    },
    {
        id: 'loose-equality', severity: 'warning', category: 'bug', langs: JS_LIKE,
        // codelens-ignore-next-line
        test: l => /[^=!<>]==[^=]|!=[^=]/.test(l.replace(/(['"`]).*?\1/g, '""')) && !/^\s*(\/\/|\/?\*)/.test(l),
        title: 'Loose equality (== / !=)',
        detail: 'Type coercion makes comparisons like 0 == "" or null == undefined true, causing subtle bugs.',
        fix: 'Use strict equality: === and !==.'
    },
    {
        id: 'var', severity: 'suggestion', category: 'maintainability', langs: JS_LIKE,
        test: l => /^\s*var\s+\w/.test(l),
        title: 'Use of var',
        detail: 'var is function-scoped and hoisted, which leads to accidental re-use of variables.',
        fix: 'Use const by default and let when the value is reassigned.'
    },
    {
        id: 'empty-catch', severity: 'warning', category: 'bug', langs: null,
        test: l => /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(l) || /^\s*except(\s+\w+)?\s*:\s*pass\s*$/.test(l),
        title: 'Error silently swallowed',
        detail: 'An empty catch/except hides failures and makes debugging very hard.',
        fix: 'Log the error or handle it explicitly; re-throw if you cannot recover.'
    },
    {
        id: 'bare-except', severity: 'warning', category: 'bug', langs: new Set(['python']),
        test: l => /^\s*except\s*:/.test(l),
        title: 'Bare except',
        detail: 'A bare except also catches KeyboardInterrupt and SystemExit.',
        fix: 'Catch specific exceptions, e.g. except ValueError as err:'
    },
    {
        id: 'console-log', severity: 'suggestion', category: 'style', langs: JS_LIKE,
        // CLIs and scripts print on purpose, so they are skipped.
        skipFile: f => /(^|[\\/])(bin|scripts?|cli)([\\/]|\.js$)/.test(f),
        test: l => /console\.(log|debug)\(/.test(l) && !/^\s*\/\//.test(l),
        title: 'Debug logging left in code',
        detail: 'console.log calls clutter output and can leak data in production.',
        fix: 'Remove it or use a proper logger with log levels.'
    },
    {
        id: 'print-debug', severity: 'suggestion', category: 'style', langs: new Set(['python']),
        test: l => /^\s*print\(/.test(l),
        title: 'print() used for debugging',
        detail: 'print statements are hard to silence and filter.',
        fix: 'Use the logging module (logging.getLogger(__name__)).'
    },
    {
        id: 'todo', severity: 'suggestion', category: 'maintainability', langs: null,
        test: l => /(\/\/|#|\/\*|\*)\s*(TODO|FIXME|HACK|XXX)\b/i.test(l),
        title: 'Unresolved TODO/FIXME',
        detail: 'Leftover TODOs often mark unfinished or known-broken logic.',
        fix: 'Resolve it or move it to an issue tracker with context.'
    },
    {
        id: 'http-url', severity: 'warning', category: 'security', langs: null,
        test: l => /['"`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|www\.w3\.org)[\w.-]+/.test(l),
        title: 'Insecure http:// URL',
        detail: 'Traffic over plain HTTP can be read or modified in transit.',
        fix: 'Use https:// for every external request.'
    },
    {
        id: 'async-foreach', severity: 'warning', category: 'bug', langs: JS_LIKE,
        test: l => /\.forEach\(\s*async\b/.test(l),
        title: 'async callback inside forEach',
        detail: 'forEach does not wait for promises, so errors are unhandled and the work finishes in random order.',
        fix: 'Use for...of with await, or await Promise.all(items.map(async ...)).'
    },
    {
        id: 'parseint-radix', severity: 'suggestion', category: 'bug', langs: JS_LIKE,
        test: l => /parseInt\(\s*[^,()]+\)/.test(l),
        title: 'parseInt without radix',
        detail: 'Without a radix, some inputs can be parsed in an unexpected base.',
        fix: 'Pass the radix: parseInt(value, 10), or use Number(value).'
    },
    {
        id: 'long-line', severity: 'suggestion', category: 'style', langs: null,
        test: l => l.length > 180 && !/https?:\/\//.test(l),
        title: 'Very long line',
        detail: 'Lines over 180 characters are hard to read and review.',
        fix: 'Break it into smaller expressions or helper variables.'
    }
];

/** Detects functions longer than `limit` lines (brace-based languages + python def). */
function longFunctions(lines, lang, limit = 60) {
    const issues = [];
    if (lang === 'python') {
        lines.forEach((line, i) => {
            const m = /^(\s*)def\s+(\w+)/.exec(line);
            if (!m) return;
            const indent = m[1].length;
            let end = i + 1;
            while (end < lines.length && (lines[end].trim() === '' || lines[end].search(/\S/) > indent)) end++;
            if (end - i > limit) issues.push({ line: i + 1, name: m[2], length: end - i });
        });
        return issues;
    }
    const fnStart = /(function\s+(\w+)|(\w+)\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>|^\s*(async\s+)?(\w+)\s*\([^)]*\)\s*\{)/;
    lines.forEach((line, i) => {
        const m = fnStart.exec(line);
        if (!m || !line.includes('{') || /^\s*(if|for|while|switch|catch)\b/.test(line)) return;
        let depth = 0;
        let started = false;
        for (let j = i; j < lines.length; j++) {
            for (const ch of lines[j].replace(/(['"`]).*?\1/g, '')) {
                if (ch === '{') { depth++; started = true; }
                if (ch === '}') depth--;
            }
            if (started && depth <= 0) {
                if (j - i + 1 > limit) issues.push({ line: i + 1, name: m[2] || m[3] || m[7] || 'anonymous', length: j - i + 1 });
                return;
            }
        }
    });
    return issues;
}

/**
 * Runs all rules over one file.
 * @param {{file:string, lang:string, content:string, changedLines:Set<number>|null}} f
 */
function analyzeFile(f) {
    const lines = f.content.split(/\r?\n/);
    const issues = [];
    const seen = new Set();
    lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        if (f.changedLines && !f.changedLines.has(lineNo)) return;
        // Inline suppression: "codelens-ignore" on the line or "codelens-ignore-next-line" above it.
        if (/codelens-ignore(?!-next-line)/.test(line) || /codelens-ignore-next-line/.test(lines[idx - 1] || '')) return;
        for (const rule of RULES) {
            if (rule.langs && !rule.langs.has(f.lang)) continue;
            if (rule.skipFile && rule.skipFile(f.file)) continue;
            if (!rule.test(line)) continue;
            const key = `${rule.id}:${lineNo}`;
            if (seen.has(key)) continue;
            // Only one secret finding per line.
            if (rule.id === 'known-token-format' && seen.has(`hardcoded-secret:${lineNo}`)) continue;
            seen.add(key);
            issues.push({
                file: f.file, line: lineNo, severity: rule.severity, category: rule.category,
                title: rule.title, detail: rule.detail, fix: rule.fix, rule: rule.id, snippet: line.trim().slice(0, 140)
            });
        }
    });
    for (const fn of longFunctions(lines, f.lang)) {
        if (f.changedLines && !f.changedLines.has(fn.line)) continue;
        issues.push({
            file: f.file, line: fn.line, severity: 'suggestion', category: 'maintainability',
            title: `Long function "${fn.name}" (${fn.length} lines)`,
            detail: 'Long functions usually do too many things and are hard to test.',
            fix: 'Split it into smaller, well-named helper functions.', rule: 'long-function'
        });
    }
    return issues;
}

/** Score from 0-100 based on weighted issues per 100 lines reviewed. */
function scoreIssues(issues, totalLines) {
    const penalty = issues.reduce((sum, i) => sum + (SEVERITY_WEIGHT[i.severity] || 0), 0);
    const size = Math.max(1, totalLines / 150);
    let score = Math.round(100 * Math.exp(-penalty / (120 * Math.sqrt(size))));
    // Any critical finding caps the score: code with a security hole is never "A" grade.
    if (issues.some(i => i.severity === 'critical')) score = Math.min(score, 69);
    return Math.max(0, Math.min(100, score));
}

function offlineReview(files) {
    const issues = files.flatMap(analyzeFile);
    const totalLines = files.reduce((n, f) => n + (f.changedLines ? f.changedLines.size : f.content.split('\n').length), 0);
    const counts = countBySeverity(issues);
    const score = scoreIssues(issues, totalLines);
    const summary = issues.length === 0
        ? 'No problems found by the offline rule engine. Run with an API key for a deeper AI review.'
        : `Found ${counts.critical} critical, ${counts.warning} warning and ${counts.suggestion} suggestion level issues across ${files.length} file(s).`
          + (counts.critical ? ' Fix the critical security findings first.' : '');
    return { mode: 'offline', score, summary, issues, highlights: [], totalLines };
}

function countBySeverity(issues) {
    return issues.reduce((acc, i) => { acc[i.severity] = (acc[i.severity] || 0) + 1; return acc; }, { critical: 0, warning: 0, suggestion: 0 });
}

module.exports = { RULES, analyzeFile, offlineReview, scoreIssues, countBySeverity, longFunctions, SEVERITY_WEIGHT };
