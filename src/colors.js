/** Minimal ANSI colour helpers (respects NO_COLOR and non-TTY output). */
const enabled = process.stdout.isTTY && !process.env.NO_COLOR || process.env.FORCE_COLOR;

const wrap = (open, close = 39) => s => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const rgb = (r, g, b) => s => (enabled ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : String(s));

module.exports = {
    enabled: Boolean(enabled),
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    italic: wrap(3, 23),
    underline: wrap(4, 24),
    red: rgb(255, 77, 109),
    yellow: rgb(255, 209, 102),
    green: rgb(0, 255, 170),
    cyan: rgb(0, 210, 255),
    violet: rgb(124, 115, 255),
    pink: rgb(255, 94, 168),
    gray: rgb(130, 128, 160),
    white: rgb(236, 233, 255),
    bgViolet: s => (enabled ? `\x1b[48;2;108;99;255m\x1b[38;2;255;255;255m${s}\x1b[0m` : String(s)),
    /** Horizontal gradient across a string (violet → cyan). */
    gradient(str, from = [124, 115, 255], to = [0, 210, 255]) {
        if (!enabled) return str;
        const chars = [...str];
        return chars.map((ch, i) => {
            const t = chars.length > 1 ? i / (chars.length - 1) : 0;
            const c = from.map((v, k) => Math.round(v + (to[k] - v) * t));
            return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${ch}`;
        }).join('') + '\x1b[39m';
    },
    strip: s => String(s).replace(/\x1b\[[0-9;]*m/g, '')
};
