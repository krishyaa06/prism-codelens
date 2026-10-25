/**
 * OpenAI-compatible chat providers. Every provider below exposes
 * POST {baseUrl}/chat/completions, so one client covers all of them.
 */
const PROVIDERS = {
    gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
    groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyEnv: ['GROQ_API_KEY'] },
    openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', keyEnv: ['OPENROUTER_API_KEY'] },
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyEnv: ['OPENAI_API_KEY'] },
    ollama: { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder', keyEnv: [], noKey: true },
    custom: { label: 'Custom (OpenAI-compatible)', baseUrl: '', model: '', keyEnv: [] }
};

/** Guesses the provider from the shape of a generic API key. */
function guessProviderFromKey(key = '') {
    if (!key) return '';
    if (key.startsWith('gsk_')) return 'groq';
    if (key.startsWith('sk-or-')) return 'openrouter';
    if (key.startsWith('sk-')) return 'openai';
    return 'gemini';
}

/** Resolves provider settings from CLI flags and environment variables. */
function resolveProvider(opts = {}, env = process.env) {
    let name = (opts.provider || env.CODELENS_PROVIDER || '').toLowerCase();
    if (!name) {
        // Auto-detect from whichever key is present.
        name = Object.keys(PROVIDERS).find(p => PROVIDERS[p].keyEnv.some(k => env[k])) || '';
    }
    if (!name) name = guessProviderFromKey(opts.apiKey || env.CODELENS_API_KEY);
    if (!name) return null;
    const preset = PROVIDERS[name];
    if (!preset) throw new Error(`Unknown provider "${name}". Use one of: ${Object.keys(PROVIDERS).join(', ')}`);
    const apiKey = opts.apiKey || env.CODELENS_API_KEY || preset.keyEnv.map(k => env[k]).find(Boolean) || '';
    const baseUrl = (opts.baseUrl || env.CODELENS_BASE_URL || preset.baseUrl).replace(/\/+$/, '');
    const model = opts.model || env.CODELENS_MODEL || preset.model;
    if (!baseUrl) throw new Error('Custom provider needs --base-url or CODELENS_BASE_URL.');
    if (!model) throw new Error('No model set. Pass --model or CODELENS_MODEL.');
    if (!apiKey && !preset.noKey) {
        throw new Error(`No API key for ${preset.label}. Set CODELENS_API_KEY (or ${preset.keyEnv[0] || 'CODELENS_API_KEY'}), or use --offline.`);
    }
    return { name, label: preset.label, baseUrl, model, apiKey };
}

async function chat(provider, messages, { timeoutMs = 90_000, fetchImpl = globalThis.fetch } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
        if (provider.name === 'openrouter') {
            headers['HTTP-Referer'] = 'https://github.com/krishyaa06/prism-codelens';
            headers['X-Title'] = 'Prism CodeLens';
        }
        const res = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: provider.model, messages, temperature: 0.2 }),
            signal: controller.signal
        });
        const text = await res.text();
        if (!res.ok) {
            let msg = text.slice(0, 300);
            try { msg = JSON.parse(text).error?.message || msg; } catch { /* keep raw text */ }
            const hint = res.status === 401 || res.status === 403 ? ' (check your API key)' : res.status === 429 ? ' (rate limited, try again shortly)' : '';
            throw new Error(`${provider.label} returned HTTP ${res.status}${hint}: ${msg}`);
        }
        const data = JSON.parse(text);
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error(`${provider.label} returned an empty response.`);
        return content;
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`${provider.label} timed out after ${timeoutMs / 1000}s.`);
        if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
            const code = err.cause?.code ? ` (${err.cause.code})` : '';
            throw new Error(`Could not reach ${provider.baseUrl}${code}. Check your internet connection or --base-url.`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/** Extracts the first JSON object from a model reply (handles ```json fences and chatter). */
function extractJson(text) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('The model did not return JSON.');
    return JSON.parse(candidate.slice(start, end + 1));
}

module.exports = { guessProviderFromKey, PROVIDERS, resolveProvider, chat, extractJson };
