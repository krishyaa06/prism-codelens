/**
 * Pretty terminal output: banner, spinner, score gauge and grouped issues.
 */
const c = require('./colors');
const { countBySeverity } = require('./rules');

const VERSION = require('../package.json').version;

const SEV = {
    critical: { icon: '●', label: 'CRITICAL', color: c.red },
    warning: { icon: '▲', label: 'WARNING', color: c.yellow },
    suggestion: { icon: '◆', label: 'SUGGESTION', color: c.cyan }
};

const CAT_ICON = { bug: '🐞', security: '🔒', performance: '⚡', maintainability: '🧩', style: '🎨' };

function banner(out = process.stdout) {
    const art = [
        '  ┏━╸┏━┓╺┳┓┏━╸╻  ┏━╸┏┓╻┏━┓',
        '  ┃  ┃ ┃ ┃┃┣╸ ┃  ┣╸ ┃┗┫┗━┓',
        '  ┗━╸┗━┛╺┻┛┗━╸┗━╸┗━╸╹ ╹┗━┛'
    ];
    out.write('\n');
    for (const line of art) out.write(c.bold(c.gradient(line)) + '\n');
    out.write(`  ${c.gray('AI code reviewer')} ${c.dim('·')} ${c.violet('Prism Protocol')} ${c.dim('· v' + VERSION)}\n\n`);
}

function spinner(text, out = process.stderr) {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    if (!out.isTTY) {
        out.write(`  ${text}\n`);
        return { stop() {}, update() {} };
    }
    let i = 0;
    let label = text;
    const start = Date.now();
    const timer = setInterval(() => {
        const secs = ((Date.now() - start) / 1000).toFixed(1);
        out.write(`\r  ${c.violet(frames[i++ % frames.length])} ${label} ${c.gray(secs + 's')}   `);
    }, 80);
    return {
        update(t) { label = t; },
        stop(final) {
            clearInterval(timer);
            out.write('\r\x1b[2K');
            if (final) out.write(`  ${final}\n`);
        }
    };
}

function scoreColor(score) {
    return score >= 85 ? c.green : score >= 65 ? c.cyan : score >= 45 ? c.yellow : c.red;
}

function grade(score) {
    return score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 60 ? 'C' : score >= 45 ? 'D' : 'F';
}

function gauge(score, width = 30) {
    const filled = Math.round((score / 100) * width);
    const col = scoreColor(score);
    return col('█'.repeat(filled)) + c.gray('░'.repeat(width - filled));
}

function wrapText(text, width, indent, firstIndent = indent) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
        if ((line + ' ' + w).trim().length > width) { lines.push(line.trim()); line = w; } else line += ' ' + w;
    }
    if (line.trim()) lines.push(line.trim());
    return lines.map((l, i) => (i ? indent : firstIndent) + l).join('\n');
}

function renderReport(result, out = process.stdout) {
    const counts = countBySeverity(result.issues);
    const col = scoreColor(result.score);
    const w = Math.min(process.stdout.columns || 90, 100) - 10;

    const scoreText = c.bold(col(String(result.score).padStart(3))) + c.gray('/100');
    out.write(`  ${c.bold(c.white('Score'))}  ${gauge(result.score)}  ${scoreText}  ${c.bold(col('Grade ' + grade(result.score)))}\n`);
    out.write(`  ${c.gray('Mode')}   ${result.mode === 'ai' ? c.pink('AI review') + c.gray(' · ' + result.provider) : c.cyan('Offline rule engine')}\n`);
    out.write(`  ${c.gray('Files')}  ${result.files.length} file(s) · ${result.totalLines} lines reviewed\n\n`);

    const tally = (sev, word) => SEV[sev].color(`${SEV[sev].icon} ${counts[sev]} ${word}`);
    out.write(`  ${tally('critical', 'critical')}   ${tally('warning', 'warnings')}   ${tally('suggestion', 'suggestions')}\n\n`);

    if (result.summary) out.write(wrapText(result.summary, w, '  ') + '\n\n');

    if (result.highlights?.length) {
        out.write(`  ${c.bold(c.green('What looks good'))}\n`);
        for (const h of result.highlights) out.write(`  ${c.green('✔')} ${h}\n`);
        out.write('\n');
    }

    let lastFile = null;
    for (const issue of result.issues) {
        if (issue.file !== lastFile) {
            out.write(`  ${c.bold(c.violet('▌ ' + issue.file))}\n`);
            lastFile = issue.file;
        }
        const s = SEV[issue.severity];
        const loc = c.gray(issue.line ? `L${issue.line}`.padEnd(5) : '     ');
        out.write(`    ${s.color(s.icon)} ${loc} ${c.bold(issue.title)}  ${c.dim(s.color(s.label))} ${c.gray((CAT_ICON[issue.category] || '') + ' ' + issue.category)}\n`);
        if (issue.snippet) out.write(`      ${c.gray('│')} ${c.dim(issue.snippet)}\n`);
        if (issue.detail) out.write(c.gray(wrapText(issue.detail, w - 6, '      ')) + '\n');
        if (issue.fix) out.write(`      ${c.green('↳ fix:')} ${wrapText(issue.fix, w - 13, '             ', '')}\n`);
        out.write('\n');
    }

    if (!result.issues.length) out.write(`  ${c.green('✨ Clean! No issues found.')}\n\n`);
    if (result.truncated?.length) out.write(`  ${c.yellow('Note:')} ${c.gray('some files were truncated to fit the model context: ' + result.truncated.join(', '))}\n\n`);
}

module.exports = { banner, spinner, renderReport, gauge, grade, SEV };
