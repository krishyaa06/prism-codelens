/**
 * Collects source files (from paths or a git diff) for review.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const IGNORED_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
    'vendor', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode'
]);
const IGNORED_FILES = /(\.min\.(js|css)$|\.map$|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|\.lock$)/i;
const EXTENSIONS = new Set([
    '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.java', '.kt', '.go', '.rs', '.rb', '.php',
    '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.dart', '.sol', '.sh', '.sql', '.html', '.css', '.scss', '.vue', '.svelte'
]);

const LANG = {
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.py': 'python', '.java': 'java', '.kt': 'kotlin', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php', '.c': 'c', '.h': 'c',
    '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.swift': 'swift', '.dart': 'dart', '.sol': 'solidity', '.sh': 'bash', '.sql': 'sql',
    '.html': 'html', '.css': 'css', '.scss': 'scss', '.vue': 'vue', '.svelte': 'svelte'
};

const MAX_FILE_BYTES = 200 * 1024;

function isReviewable(file) {
    return EXTENSIONS.has(path.extname(file).toLowerCase()) && !IGNORED_FILES.test(file);
}

function walk(target, out) {
    let stat;
    try { stat = fs.statSync(target); } catch { throw new Error(`Path not found: ${target}`); }
    if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(target)) {
            if (IGNORED_DIRS.has(entry) || entry.startsWith('.')) continue;
            walk(path.join(target, entry), out);
        }
    } else if (stat.isFile() && isReviewable(target) && stat.size <= MAX_FILE_BYTES) {
        out.push(target);
    }
}

/** Reads files from paths/directories. Every line is "changed" (full review). */
function fromPaths(paths, { maxFiles = 25 } = {}) {
    const files = [];
    for (const p of paths.length ? paths : ['.']) walk(p, files);
    const unique = [...new Set(files.map(f => path.normalize(f)))].sort();
    return unique.slice(0, maxFiles).map(file => {
        const content = fs.readFileSync(file, 'utf8');
        return { file, lang: LANG[path.extname(file).toLowerCase()] || 'text', content, changedLines: null, skipped: unique.length > maxFiles };
    });
}

/**
 * Parses unified diff output into { file -> Set(changed line numbers) }.
 */
function parseDiff(diff) {
    const result = new Map();
    let current = null;
    let lineNo = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ ')) {
            const name = line.slice(4).replace(/^b\//, '').trim();
            current = name === '/dev/null' ? null : name;
            if (current && !result.has(current)) result.set(current, new Set());
        } else if (line.startsWith('@@')) {
            const m = /\+(\d+)(?:,(\d+))?/.exec(line);
            lineNo = m ? Number(m[1]) : 0;
        } else if (current && line.startsWith('+') && !line.startsWith('+++')) {
            result.get(current).add(lineNo++);
        } else if (current && !line.startsWith('-')) {
            lineNo++;
        }
    }
    return result;
}

/** Reads only files touched by `git diff` (staged or against a ref). */
function fromGitDiff({ staged = false, ref = null, maxFiles = 25 } = {}) {
    const git = a => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        git(['rev-parse', '--is-inside-work-tree']);
    } catch {
        throw new Error('Not a git repository. Run "codelens diff" inside a repo, or use "codelens review <paths>".');
    }
    // --relative keeps paths relative to the current folder, so it also works from sub-folders.
    const args = ['diff', '--relative', '--unified=0', '--no-color', '--diff-filter=AM'];
    if (staged) args.push('--staged');
    if (ref) args.push(ref);
    let diff;
    try {
        diff = git(args);
    } catch (err) {
        throw new Error(`git diff failed: ${String(err.stderr || err.message).split('\n')[0]}`);
    }
    const changed = parseDiff(diff);
    return [...changed.entries()]
        .filter(([file]) => isReviewable(file) && fs.existsSync(file))
        .slice(0, maxFiles)
        .map(([file, lines]) => ({
            file,
            lang: LANG[path.extname(file).toLowerCase()] || 'text',
            content: fs.readFileSync(file, 'utf8'),
            changedLines: lines
        }));
}

module.exports = { fromPaths, fromGitDiff, parseDiff, isReviewable };
