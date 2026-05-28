import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { PROVIDER_CATALOG } from '@ethosagent/wiring/provider-catalog';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';
export function AuthStep() {
    const { answers, dispatch } = useWizardContext();
    const [key, setKey] = useState(answers.apiKey ?? '');
    const [error, setError] = useState('');
    const provider = PROVIDER_CATALOG.find((p) => p.id === answers.provider);
    const isSelfHosted = provider?.authType === 'self-hosted';
    // Azure needs both an endpoint and an API key — the endpoint is the user's
    // resource URL (e.g. https://my-resource.openai.azure.com), not a default.
    const isAzure = answers.provider === 'azure';
    // Azure-specific: phase machine inside the step. Endpoint first, then apiKey.
    const [azurePhase, setAzurePhase] = useState(() => answers.baseUrl ? 'apiKey' : 'endpoint');
    const [endpoint, setEndpoint] = useState(answers.baseUrl ?? '');
    // Alias to avoid shadowing by the `key` parameter in useInput below
    const apiKeyValue = key;
    useInput((input, key) => {
        if (key.escape) {
            if (isAzure && azurePhase === 'apiKey') {
                // Step back to the endpoint field, not out of the step.
                setAzurePhase('endpoint');
                setError('');
                return;
            }
            dispatch({ type: 'back' });
            return;
        }
        if (key.return) {
            if (isAzure) {
                if (azurePhase === 'endpoint') {
                    if (!endpoint.trim()) {
                        setError('Azure endpoint is required');
                        return;
                    }
                    if (!/^https?:\/\//i.test(endpoint.trim())) {
                        setError('Endpoint must start with https:// or http://');
                        return;
                    }
                    setAzurePhase('apiKey');
                    setError('');
                    return;
                }
                // azurePhase === 'apiKey'
                if (!apiKeyValue) {
                    setError('API key is required');
                    return;
                }
                dispatch({
                    type: 'next',
                    patch: { baseUrl: endpoint.trim(), apiKey: apiKeyValue },
                });
                return;
            }
            if (!isSelfHosted && !apiKeyValue) {
                setError('API key is required');
                return;
            }
            dispatch({ type: 'next', patch: { apiKey: isSelfHosted ? '' : apiKeyValue } });
            return;
        }
        if (key.backspace || key.delete) {
            if (isAzure && azurePhase === 'endpoint') {
                setEndpoint((v) => v.slice(0, -1));
            }
            else {
                setKey((k) => k.slice(0, -1));
            }
            setError('');
            return;
        }
        if (!key.ctrl && !key.meta && input) {
            if (isAzure && azurePhase === 'endpoint') {
                setEndpoint((v) => v + input);
            }
            else {
                setKey((k) => k + input);
            }
            setError('');
        }
    });
    const signupNote = provider?.signupUrl ? `Get a key at ${provider.signupUrl}` : '';
    const maskedKey = apiKeyValue.length > 0
        ? `${'•'.repeat(Math.min(apiKeyValue.length, 20))}${apiKeyValue.length > 20 ? ` (${apiKeyValue.length} chars)` : ''}`
        : '';
    if (isAzure) {
        return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, bold: true, children: azurePhase === 'endpoint'
                        ? 'Enter your Azure OpenAI endpoint:'
                        : 'Enter your Azure API key:' }), azurePhase === 'endpoint' ? (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: DESIGN.textTertiary, children: '  Resource URL from the Azure portal (Keys and Endpoint).' }), _jsxs(Box, { flexDirection: "row", gap: 1, marginTop: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, children: `  ${GLYPHS.prompt} ` }), _jsx(Text, { color: endpoint ? DESIGN.textPrimary : DESIGN.textTertiary, children: endpoint || 'https://my-resource.openai.azure.com' })] }), error && _jsx(Text, { color: DESIGN.error, children: `  ${GLYPHS.toolFail} ${error}` })] })) : (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: DESIGN.textTertiary, children: `  Endpoint: ${endpoint}` }), _jsxs(Box, { flexDirection: "row", gap: 1, marginTop: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, children: `  ${GLYPHS.prompt} ` }), _jsx(Text, { color: maskedKey ? DESIGN.textPrimary : DESIGN.textTertiary, children: maskedKey || '(paste key — input is hidden)' })] }), error && _jsx(Text, { color: DESIGN.error, children: `  ${GLYPHS.toolFail} ${error}` })] })), _jsx(Text, { color: DESIGN.textTertiary, children: azurePhase === 'endpoint'
                        ? '  Enter confirm   Esc back to provider'
                        : '  Enter confirm   Esc edit endpoint' })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, bold: true, children: isSelfHosted
                    ? 'Confirm endpoint:'
                    : `Enter your ${provider?.label ?? answers.provider} API key:` }), isSelfHosted ? (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: DESIGN.textSecondary, children: `  Base URL: ${answers.baseUrl ?? 'http://localhost:11434/v1'}` }), _jsx(Text, { color: DESIGN.textTertiary, children: '  No API key required for local models.' })] })) : (_jsxs(Box, { flexDirection: "column", children: [signupNote && _jsx(Text, { color: DESIGN.textTertiary, children: `  ${signupNote}` }), _jsxs(Box, { flexDirection: "row", gap: 1, marginTop: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, children: `  ${GLYPHS.prompt} ` }), _jsx(Text, { color: maskedKey ? DESIGN.textPrimary : DESIGN.textTertiary, children: maskedKey || '(paste key — input is hidden)' })] }), !apiKeyValue && (_jsx(Text, { color: DESIGN.textTertiary, children: '  Tip: you can add a key later by editing ~/.ethos/config.yaml' })), error && _jsx(Text, { color: DESIGN.error, children: `  ${GLYPHS.toolFail} ${error}` })] })), _jsx(Text, { color: DESIGN.textTertiary, children: '  Enter confirm   Esc back' })] }));
}
