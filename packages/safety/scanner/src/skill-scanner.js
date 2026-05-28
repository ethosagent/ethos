// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildLines(content) {
    return content.split('\n');
}
function excerpt(text, maxLen = 80) {
    const trimmed = text.trim();
    return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}...` : trimmed;
}
function makeResult(findings) {
    return {
        findings,
        hasRed: findings.some((f) => f.severity === 'red'),
        hasYellow: findings.some((f) => f.severity === 'yellow'),
    };
}
// ---------------------------------------------------------------------------
// RED: Prompt-injection phrases
// ---------------------------------------------------------------------------
const PROMPT_INJECTION_PHRASES = [
    /ignore previous instructions/i,
    /you are now(?!\s*```)/i,
    /disregard the above/i,
    /forget everything/i,
    /new instructions:/i,
];
function checkPromptInjection(lines) {
    const findings = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        // "system:" mid-document (not at line 1, i.e. line index > 0)
        if (i > 0 && /^system:/i.test(line.trimStart())) {
            findings.push({
                severity: 'red',
                rule: 'prompt-injection',
                message: 'Prompt-injection phrase detected',
                line: i + 1,
                excerpt: excerpt(line),
            });
        }
        for (const pattern of PROMPT_INJECTION_PHRASES) {
            if (pattern.test(line)) {
                findings.push({
                    severity: 'red',
                    rule: 'prompt-injection',
                    message: 'Prompt-injection phrase detected',
                    line: i + 1,
                    excerpt: excerpt(line),
                });
                break;
            }
        }
    }
    return findings;
}
// ---------------------------------------------------------------------------
// RED: Hidden Unicode
// ---------------------------------------------------------------------------
const HIDDEN_UNICODE_CHARS = [
    { code: 0x200b, name: 'ZERO WIDTH SPACE' },
    { code: 0x200c, name: 'ZERO WIDTH NON-JOINER' },
    { code: 0x200d, name: 'ZERO WIDTH JOINER' },
    { code: 0x200e, name: 'LEFT-TO-RIGHT MARK' },
    { code: 0x200f, name: 'RIGHT-TO-LEFT MARK' },
    { code: 0x202e, name: 'RIGHT-TO-LEFT OVERRIDE' },
    { code: 0x2066, name: 'LEFT-TO-RIGHT ISOLATE' },
    { code: 0x2067, name: 'RIGHT-TO-LEFT ISOLATE' },
    { code: 0x2068, name: 'FIRST STRONG ISOLATE' },
    { code: 0x2069, name: 'POP DIRECTIONAL ISOLATE' },
    { code: 0x00ad, name: 'SOFT HYPHEN' },
];
function checkHiddenUnicode(lines) {
    const findings = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        for (const { code, name: _name } of HIDDEN_UNICODE_CHARS) {
            if (line.includes(String.fromCodePoint(code))) {
                const hex = code.toString(16).toUpperCase().padStart(4, '0');
                findings.push({
                    severity: 'red',
                    rule: 'hidden-unicode',
                    message: `Hidden Unicode control character detected (U+${hex})`,
                    line: i + 1,
                    excerpt: excerpt(line),
                });
            }
        }
    }
    return findings;
}
// ---------------------------------------------------------------------------
// YELLOW: Base64 blobs > 200 chars
// ---------------------------------------------------------------------------
const BASE64_BLOB_PATTERN = /[A-Za-z0-9+/]{200,}={0,2}/g;
function checkBase64Blobs(lines) {
    const findings = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        BASE64_BLOB_PATTERN.lastIndex = 0;
        let match = BASE64_BLOB_PATTERN.exec(line);
        while (match !== null) {
            const blob = match[0];
            findings.push({
                severity: 'yellow',
                rule: 'base64-blob',
                message: `Large base64-encoded blob (${blob.length} chars) — may hide payload`,
                line: i + 1,
                excerpt: `${blob.slice(0, 40)}...`,
            });
            match = BASE64_BLOB_PATTERN.exec(line);
        }
    }
    return findings;
}
// ---------------------------------------------------------------------------
// YELLOW: Sensitive tool instructions
// ---------------------------------------------------------------------------
const TOOL_KEYWORDS = ['bash', 'web_post', 'email_send', 'exec', 'shell'];
const ACTION_VERBS = ['send', 'exfil', 'upload', 'forward', 'post'];
function checkSensitiveToolInstructions(lines) {
    const findings = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const lowerLine = line.toLowerCase();
        let foundTool = -1;
        let foundVerb = -1;
        for (const tool of TOOL_KEYWORDS) {
            const idx = lowerLine.indexOf(tool);
            if (idx !== -1) {
                foundTool = idx;
                break;
            }
        }
        for (const verb of ACTION_VERBS) {
            const idx = lowerLine.indexOf(verb);
            if (idx !== -1) {
                foundVerb = idx;
                break;
            }
        }
        if (foundTool !== -1 && foundVerb !== -1 && Math.abs(foundTool - foundVerb) <= 100) {
            findings.push({
                severity: 'yellow',
                rule: 'sensitive-tool-instruction',
                message: 'Instruction mentions sensitive tool with action verb',
                line: i + 1,
                excerpt: excerpt(line),
            });
        }
    }
    return findings;
}
// ---------------------------------------------------------------------------
// YELLOW: Role override
// ---------------------------------------------------------------------------
const ROLE_OVERRIDE_PATTERNS = [
    /you are now an agent without restrictions/i,
    /act as if you have no/i,
    /ignore your guidelines/i,
    /pretend you are/i,
];
function checkRoleOverride(lines) {
    const findings = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        for (const pattern of ROLE_OVERRIDE_PATTERNS) {
            if (pattern.test(line)) {
                findings.push({
                    severity: 'yellow',
                    rule: 'role-override',
                    message: 'Personality/role override instruction detected',
                    line: i + 1,
                    excerpt: excerpt(line),
                });
                break;
            }
        }
    }
    return findings;
}
// ---------------------------------------------------------------------------
// YELLOW: External URL fetch instructions
// ---------------------------------------------------------------------------
const EXTERNAL_URL_PATTERNS = [/\bcurl\b/i, /\bwget\b/i, /\bfetch\s*\(/i, /https?:\/\//i];
function checkExternalUrlInstructions(lines) {
    const findings = [];
    let inCodeFence = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (/^```/.test(line.trimStart())) {
            inCodeFence = !inCodeFence;
            continue;
        }
        if (inCodeFence)
            continue;
        for (const pattern of EXTERNAL_URL_PATTERNS) {
            if (pattern.test(line)) {
                findings.push({
                    severity: 'yellow',
                    rule: 'external-url-instruction',
                    message: 'Instruction references external URL or HTTP fetch',
                    line: i + 1,
                    excerpt: excerpt(line),
                });
                break;
            }
        }
    }
    return findings;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function scanSkillMd(content, _filePath) {
    const lines = buildLines(content);
    const findings = [
        ...checkPromptInjection(lines),
        ...checkHiddenUnicode(lines),
        ...checkBase64Blobs(lines),
        ...checkSensitiveToolInstructions(lines),
        ...checkRoleOverride(lines),
        ...checkExternalUrlInstructions(lines),
    ];
    return makeResult(findings);
}
