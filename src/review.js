/**
 * AI review: builds the prompt, calls the model and normalises its answer.
 */
const { chat, extractJson } = require('./providers');
const { offlineReview, countBySeverity } = require('./rules');

const MAX_PROMPT_CHARS = 60_000;
const SEVERITIES = ['critical', 'warning', 'suggestion'];
const CATEGORIES = ['bug', 'security', 'performance', 'maintainability', 'style'];

const SYSTEM_PROMPT = `You are CodeLens, a senior staff engineer doing a careful code review.
Find real problems: bugs, security vulnerabilities, race conditions, performance traps, poor error handling and maintainability issues.
Do NOT invent issues. Prefer few, high-value findings over many trivial ones. Reference exact line numbers from the numbered code.
Reply with ONLY a JSON object in this exact shape:
{
  "summary": "2-3 sentence overall verdict",
  "score": 0-100 integer (100 = production ready),
  "highlights": ["things done well", "..."],
  "issues": [
    {
      "file": "path as given",
      "line": 12,
      "severity": "critical" | "warning" | "suggestion",
      "category": "bug" | "security" | "performance" | "maintainability" | "style",
      "title": "short title",
      "detail": "why this is a problem",
      "fix": "concrete fix, may include a short code snippet"
    }
  ]
}`;

function numbered(content, changedLines) {
    return content.split(/\r?\n/).map((l, i) => {
        const n = i + 1;
        const mark = changedLines ? (changedLines.has(n) ? '+' : ' ') : '';
        return `${String(n).padStart(4)}${mark}| ${l}`;
    }).join('\n');
}

function buildPrompt(files, { focus } = {}) {
    let budget = MAX_PROMPT_CHARS;
    const parts = [];
    const truncated = [];
    for (const f of files) {
        let body = numbered(f.content, f.changedLines);
        if (body.length > budget) {
            if (budget < 2000) { truncated.push(f.file); continue; }
            body = body.slice(0, budget) + '\n... (truncated)';
            truncated.push(f.file);
        }
        budget -= body.length;
        parts.push(`### File: ${f.file} (${f.lang})\n${body}`);
    }
    const diffNote = files.some(f => f.changedLines) ? '\nLines marked with "+" were changed in this diff. Focus your review on them, but use surrounding code for context.' : '';
    const focusNote = focus ? `\nThe author asked you to focus on: ${focus}.` : '';
    return { text: `Review the following code.${diffNote}${focusNote}\n\n${parts.join('\n\n')}`, truncated };
}

/** Maps the file name the model returned back to a reviewed file (models sometimes shorten paths). */
function matchFile(name, files, knownFiles) {
    if (knownFiles.has(name)) return name;
    const hit = name && files.find(f => name.endsWith(f.file) || f.file.endsWith(name));
    return hit ? hit.file : (name || files[0]?.file || '');
}

function normalise(raw, files) {
    const knownFiles = new Set(files.map(f => f.file));
    const issues = (Array.isArray(raw.issues) ? raw.issues : [])
        .filter(i => i && i.title)
        .map(i => ({
            file: matchFile(String(i.file || ''), files, knownFiles),
            line: Number.isFinite(Number(i.line)) && Number(i.line) > 0 ? Math.round(Number(i.line)) : null,
            severity: SEVERITIES.includes(String(i.severity).toLowerCase()) ? String(i.severity).toLowerCase() : 'suggestion',
            category: CATEGORIES.includes(String(i.category).toLowerCase()) ? String(i.category).toLowerCase() : 'maintainability',
            title: String(i.title).slice(0, 140),
            detail: String(i.detail || ''),
            fix: String(i.fix || '')
        }));
    const score = Number.isFinite(Number(raw.score)) ? Math.max(0, Math.min(100, Math.round(Number(raw.score)))) : null;
    return {
        summary: String(raw.summary || ''),
        score,
        highlights: Array.isArray(raw.highlights) ? raw.highlights.map(String).slice(0, 6) : [],
        issues
    };
}

const SEV_RANK = { critical: 0, warning: 1, suggestion: 2 };
function sortIssues(issues) {
    return issues.sort((a, b) => a.file.localeCompare(b.file) || SEV_RANK[a.severity] - SEV_RANK[b.severity] || (a.line || 0) - (b.line || 0));
}

/**
 * Full review. With a provider: AI review + offline rules merged (deduped).
 * Without a provider: offline only.
 */
async function review(files, { provider = null, focus = null, chatImpl = chat } = {}) {
    if (!files.length) throw new Error('No reviewable source files found.');
    const offline = offlineReview(files);
    if (!provider) return { ...offline, issues: sortIssues(offline.issues), files: files.map(f => f.file) };

    const { text, truncated } = buildPrompt(files, { focus });
    const reply = await chatImpl(provider, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text }
    ]);
    let ai;
    try {
        ai = normalise(extractJson(reply), files);
    } catch (err) {
        throw new Error(`Could not parse the AI response: ${err.message}`);
    }

    // Merge: keep AI issues, add offline security/bug findings the AI missed on the same line.
    const taken = new Set(ai.issues.map(i => `${i.file}:${i.line}`));
    const extra = offline.issues.filter(i => (i.severity === 'critical' || i.category === 'security') && !taken.has(`${i.file}:${i.line}`));
    const issues = sortIssues([...ai.issues, ...extra]);
    const score = ai.score ?? offline.score;
    return {
        mode: 'ai',
        provider: `${provider.label} · ${provider.model}`,
        score: extra.some(i => i.severity === 'critical') ? Math.min(score, 60) : score,
        summary: ai.summary || offline.summary,
        highlights: ai.highlights,
        issues,
        files: files.map(f => f.file),
        truncated,
        totalLines: offline.totalLines
    };
}

module.exports = { review, buildPrompt, normalise, numbered, sortIssues, SYSTEM_PROMPT, countBySeverity };
