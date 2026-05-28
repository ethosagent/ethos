import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';
const PLATFORMS = [
    { id: 'telegram', label: 'Telegram', hint: 'bot token from @BotFather' },
    { id: 'discord', label: 'Discord', hint: 'bot token from Discord Developer Portal' },
    { id: 'slack', label: 'Slack', hint: 'bot token + app token + signing secret' },
    { id: 'email', label: 'Email (IMAP/SMTP)', hint: 'IMAP + SMTP credentials' },
    { id: 'skip', label: 'Skip', hint: 'chat in your browser via `ethos serve`' },
];
function getFields(platform) {
    switch (platform) {
        case 'telegram':
            return [{ key: 'telegramToken', label: 'Bot token', sensitive: true }];
        case 'discord':
            return [{ key: 'discordToken', label: 'Bot token', sensitive: true }];
        case 'slack':
            return [
                { key: 'slackBotToken', label: 'Bot token (xoxb-...)', sensitive: true },
                { key: 'slackAppToken', label: 'App token (xapp-...)', sensitive: true },
                { key: 'slackSigningSecret', label: 'Signing secret', sensitive: true },
            ];
        case 'email':
            return [
                { key: 'emailImapHost', label: 'IMAP host', sensitive: false },
                { key: 'emailUser', label: 'Email address', sensitive: false },
                { key: 'emailPassword', label: 'Password', sensitive: true },
                { key: 'emailSmtpHost', label: 'SMTP host', sensitive: false },
            ];
        default:
            return [];
    }
}
async function validatePlatform(platform, values) {
    try {
        if (platform === 'telegram') {
            const { validateTelegramToken } = await import('@ethosagent/platform-telegram/validate');
            return validateTelegramToken(values.telegramToken ?? '');
        }
        if (platform === 'discord') {
            const { validateDiscordToken } = await import('@ethosagent/platform-discord/validate');
            return validateDiscordToken(values.discordToken ?? '');
        }
        if (platform === 'slack') {
            const { validateSlackToken } = await import('@ethosagent/platform-slack/validate');
            return validateSlackToken(values.slackBotToken ?? '');
        }
    }
    catch {
        // Validator module not available — save anyway
        return { ok: true };
    }
    // email: no live validation (IMAP open is too slow for a wizard step)
    return { ok: true };
}
export function MessagingStep() {
    const { accent, dispatch } = useWizardContext();
    const [phase, setPhase] = useState('select');
    const [selected, setSelected] = useState(0);
    const [fieldValues, setFieldValues] = useState({});
    const [activeField, setActiveField] = useState(0);
    const [validation, setValidation] = useState(null);
    const selectedPlatform = PLATFORMS[selected];
    // Run validation when phase transitions to 'validating'
    useEffect(() => {
        if (phase !== 'validating' || !selectedPlatform)
            return;
        let cancelled = false;
        validatePlatform(selectedPlatform.id, fieldValues).then((result) => {
            if (!cancelled) {
                setValidation(result);
                setPhase('validated');
            }
        });
        return () => {
            cancelled = true;
        };
    }, [phase, selectedPlatform, fieldValues]);
    useInput((input, key) => {
        if (phase === 'select') {
            if (key.upArrow)
                setSelected((s) => Math.max(0, s - 1));
            if (key.downArrow)
                setSelected((s) => Math.min(PLATFORMS.length - 1, s + 1));
            if (key.return) {
                const p = PLATFORMS[selected];
                if (!p)
                    return;
                if (p.id === 'skip') {
                    dispatch({ type: 'next', patch: {} });
                }
                else {
                    setPhase('configure');
                    setActiveField(0);
                    setFieldValues({});
                    setValidation(null);
                }
            }
            if (key.escape)
                dispatch({ type: 'back' });
        }
        else if (phase === 'configure') {
            const fields = getFields(selectedPlatform?.id ?? 'skip');
            const currentFieldKey = fields[activeField]?.key ?? '';
            if (key.escape) {
                setPhase('select');
                return;
            }
            if (key.return) {
                if (activeField < fields.length - 1) {
                    setActiveField((f) => f + 1);
                }
                else {
                    // All fields filled — validate
                    setPhase('validating');
                }
                return;
            }
            if (key.backspace || key.delete) {
                setFieldValues((v) => ({
                    ...v,
                    [currentFieldKey]: (v[currentFieldKey] ?? '').slice(0, -1),
                }));
                return;
            }
            if (!key.ctrl && !key.meta && input) {
                setFieldValues((v) => ({ ...v, [currentFieldKey]: (v[currentFieldKey] ?? '') + input }));
            }
        }
        else if (phase === 'validated') {
            if (key.return) {
                dispatch({ type: 'next', patch: fieldValues });
            }
            if (key.escape) {
                setPhase('configure');
                setActiveField(0);
            }
        }
    });
    if (phase === 'select') {
        return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, bold: true, children: "Connect a messaging platform:" }), _jsx(Box, { flexDirection: "column", children: PLATFORMS.map((p, i) => {
                        const isSelected = i === selected;
                        const cursor = isSelected ? GLYPHS.prompt : ' ';
                        const isSkip = p.id === 'skip';
                        return (_jsxs(Box, { flexDirection: "row", gap: 1, children: [_jsx(Text, { color: isSelected ? accent : DESIGN.textTertiary, children: ` ${cursor} ` }), _jsx(Text, { color: isSelected ? DESIGN.textPrimary : DESIGN.textSecondary, bold: isSelected, children: p.label.padEnd(20) }), _jsx(Text, { color: isSkip && isSelected ? accent : DESIGN.textTertiary, children: p.hint })] }, p.id));
                    }) }), _jsx(Text, { color: DESIGN.textTertiary, children: '  ↑↓ select   Enter confirm   Esc back' })] }));
    }
    if (phase === 'validating') {
        return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, bold: true, children: `Validating ${selectedPlatform?.label ?? ''}...` }), _jsx(Text, { color: DESIGN.textTertiary, children: '  Checking credentials (3s timeout)' })] }));
    }
    if (phase === 'validated' && validation) {
        return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, bold: true, children: `${selectedPlatform?.label ?? ''} credentials:` }), validation.ok ? (_jsx(Text, { color: DESIGN.success, children: `  ${GLYPHS.toolOk} Connected${validation.label ? ` · ${validation.label}` : ''}` })) : (_jsx(Text, { color: DESIGN.error, children: `  ${GLYPHS.toolFail} ${validation.error ?? 'Validation failed'}` })), !validation.ok && (_jsx(Text, { color: DESIGN.textTertiary, children: '  Esc to re-enter credentials   Enter to save anyway' })), validation.ok && _jsx(Text, { color: DESIGN.textTertiary, children: '  Enter to continue' })] }));
    }
    // configure phase
    const fields = getFields(selectedPlatform?.id ?? 'skip');
    return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, bold: true, children: `Configure ${selectedPlatform?.label ?? ''}:` }), _jsx(Box, { flexDirection: "column", children: fields.map((f, i) => {
                    const isActive = i === activeField;
                    const isDone = i < activeField;
                    const value = fieldValues[f.key] ?? '';
                    const maskedValue = f.sensitive && value.length > 0
                        ? `${'•'.repeat(Math.min(value.length, 20))}${value.length > 20 ? ` (${value.length} chars)` : ''}`
                        : value;
                    return (_jsxs(Box, { flexDirection: "row", gap: 1, children: [_jsx(Text, { color: isDone ? DESIGN.success : isActive ? accent : DESIGN.textTertiary, children: isDone ? `  ${GLYPHS.toolOk} ` : isActive ? `  ${GLYPHS.prompt} ` : '    ' }), _jsx(Text, { color: isDone ? DESIGN.textSecondary : DESIGN.textPrimary, children: `${f.label}: ` }), isActive ? (_jsx(Text, { color: maskedValue ? DESIGN.textPrimary : DESIGN.textTertiary, children: maskedValue || '(type here)' })) : isDone ? (_jsx(Text, { color: DESIGN.textTertiary, children: maskedValue || '—' })) : null] }, f.key));
                }) }), _jsx(Text, { color: DESIGN.textTertiary, children: '  Enter next field   Esc back to platform select' })] }));
}
