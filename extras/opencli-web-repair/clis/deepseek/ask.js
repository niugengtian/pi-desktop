import { cli, Strategy } from '@jackwener/opencli/registry';
import { createHash } from 'node:crypto';
import { ArgumentError, CliError, CommandExecutionError, EXIT_CODES, TimeoutError } from '@jackwener/opencli/errors';
import {
    DEEPSEEK_DOMAIN, DEEPSEEK_URL, ensureOnDeepSeek, selectModel, setFeature,
    sendMessage, sendWithFile, getBubbleCount, waitForResponse, parseBoolFlag, withRetry,
    parseDeepSeekConversationId, pickResumeUrl, TEXTAREA_SELECTOR,
    findExistingDeepSeekResponse, getVisibleMessages,
} from './utils.js';

async function observeConversation(page, onConversation) {
    if (typeof onConversation !== 'function') return;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            const conversationUrl = String(await page.evaluate('window.location.href') || '');
            const conversationId = parseDeepSeekConversationId(conversationUrl);
            await onConversation({ conversationId, conversationUrl });
            return;
        } catch {
            if (attempt < 39) await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
}

async function responseRow(page, result) {
    const row = result && typeof result === 'object' ? { ...result } : { response: result };
    try {
        const conversationUrl = String(await page.evaluate('window.location.href') || '');
        const conversationId = parseDeepSeekConversationId(conversationUrl);
        return { ...row, conversationId, conversationUrl };
    } catch {
        // Preserve the legacy row shape until the SPA commits a conversation URL.
        return row;
    }
}

export const askCommand = cli({
    site: 'deepseek',
    name: 'ask',
    access: 'write',
    description: 'Send a prompt to DeepSeek and get the response',
    domain: DEEPSEEK_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    siteSession: 'persistent',
    navigateBefore: false,
    args: [
        { name: 'prompt', positional: true, required: true, help: 'Prompt to send' },
        { name: 'timeout', type: 'int', default: 120, help: 'Max seconds to wait for response' },
        { name: 'new', type: 'boolean', default: false, help: 'Start a new chat before sending' },
        { name: 'conversation', valueRequired: true, help: 'Continue an existing DeepSeek conversation ID or /a/chat/s/<id> URL' },
        { name: 'model', default: 'instant', choices: ['instant', 'expert', 'vision'], help: 'Model to use: instant, expert, or vision' },
        { name: 'think', type: 'boolean', default: false, help: 'Enable DeepThink mode' },
        { name: 'search', type: 'boolean', default: false, help: 'Enable web search' },
        { name: 'file', help: 'Attach a file (PDF, image, text) with the prompt' },
    ],
    // columns omitted: derived from row keys so non-think output shows only 'response'

    func: async (page, kwargs) => {
        const prompt = kwargs.prompt;
        if ((kwargs.beforeSubmit || kwargs.onDelivery) && (typeof kwargs.beforeSubmit !== 'function'
            || typeof kwargs.onDelivery !== 'function' || (kwargs.new !== true && !kwargs.conversation)
            || kwargs.dedupe || kwargs.search))
            throw new ArgumentError('Gated DeepSeek requires a new or bound conversation turn with both callbacks.');
        const timeoutMs = (kwargs.timeout || 120) * 1000;
        const wantThink = parseBoolFlag(kwargs.think);
        const wantSearch = parseBoolFlag(kwargs.search);
        const wantModel = kwargs.model || 'instant';

        if ((wantModel === 'vision' || wantModel === 'expert') && wantSearch) {
            throw new CliError(
                'ARGUMENT',
                `DeepSeek ${wantModel} mode does not support --search.`,
                'Run without --search, or use --model instant for web search.',
                EXIT_CODES.USAGE_ERROR,
            );
        }

        const startNew = parseBoolFlag(kwargs.new);
        if (startNew && kwargs.conversation) {
            throw new CliError(
                'ARGUMENT',
                'deepseek ask cannot use --new and --conversation together',
                'Choose either a new chat or an existing conversation.',
                EXIT_CODES.USAGE_ERROR,
            );
        }

        if (kwargs.conversation) {
            const conversationId = parseDeepSeekConversationId(kwargs.conversation);
            await page.goto(`${DEEPSEEK_URL}a/chat/s/${conversationId}`);
            try {
                await page.wait({ selector: TEXTAREA_SELECTOR, timeout: 8 });
            } catch {
                // The downstream composer/send checks return the typed failure.
            }
        } else if (startNew) {
            // Same-URL navigation is a no-op in OpenCLI; a fresh URL also clears failed-upload drafts.
            await page.goto(kwargs.beforeSubmit ? `${DEEPSEEK_URL}?pi_new=${Date.now()}` : DEEPSEEK_URL);
            // Wait for the composer to mount instead of a fixed 3 s sleep.
            try {
                await page.wait({ selector: TEXTAREA_SELECTOR, timeout: 8 });
            } catch {
                // Selector still missing → downstream selectModel/sendMessage
                // will surface the failure with a typed error.
            }
        } else {
            const navigated = await ensureOnDeepSeek(page);
            if (navigated) {
                // Pinned conversations sit in their own DOM section and are
                // skipped so the resume never lands on a topped chat.
                const resumeUrl = await pickResumeUrl(page);
                if (!resumeUrl) {
                    throw new CommandExecutionError(
                        'Workspace was recycled but no prior conversation could be loaded',
                        'Pass --new to start a fresh chat, or wait for the sidebar to populate before retrying.',
                    );
                }
                await page.goto(resumeUrl);
                try {
                    await page.wait({ selector: TEXTAREA_SELECTOR, timeout: 5 });
                } catch {
                    // Conversation page may still be loading; subsequent steps
                    // will retry or report.
                }
            }
        }

        // Model selector is only available on the new-chat page, not inside
        // an existing conversation. Skip it when we resumed a prior thread.
        const currentUrl = await page.evaluate('window.location.href') || '';
        if (kwargs.beforeSubmit && (!currentUrl || (startNew ? new URL(String(currentUrl)).pathname !== '/' || (await getVisibleMessages(page)).length : parseDeepSeekConversationId(currentUrl) !== parseDeepSeekConversationId(kwargs.conversation))))
            throw new CommandExecutionError('Gated DeepSeek requires an observed requested conversation.');
        const inConversation = currentUrl.includes('/a/chat/s/');
        const modelExplicit = kwargs.__opencliOptionSources?.model === 'cli';

        if (inConversation && modelExplicit) {
            throw new CliError(
                'ARGUMENT',
                `Cannot switch to ${wantModel} model inside an existing conversation.`,
                'Re-run with --new to start a fresh chat before selecting a model.',
                EXIT_CODES.USAGE_ERROR,
            );
        }

        // The current DeepSeek home page no longer exposes the legacy radio
        // model picker. Preserve the page's current/default model unless the
        // caller explicitly requested a model switch.
        if (!inConversation && modelExplicit) {
            const modelResult = await withRetry(() => selectModel(page, wantModel));
            if (!modelResult?.ok) {
                throw new CommandExecutionError(`Could not switch to ${wantModel} model`);
            }
            // The 0.5 s settle previously here was redundant: each subsequent
            // step (setFeature, sendMessage) issues a fresh CDP eval, giving
            // React more than enough time to flush the toggle's state update.
        }

        const thinkResult = kwargs.beforeSubmit ? await setFeature(page, 'DeepThink', wantThink)
            : await withRetry(() => setFeature(page, 'DeepThink', wantThink));
        if (!thinkResult?.ok && (wantThink || kwargs.beforeSubmit)) {
            throw new CommandExecutionError('Could not enable DeepThink');
        }

        // Only instant mode has the Search toggle in the DeepSeek UI.
        let searchResult;
        if (wantModel !== 'vision' && wantModel !== 'expert') {
            searchResult = await withRetry(() => setFeature(page, 'Search', wantSearch));
            if (!searchResult?.ok && wantSearch) {
                throw new CommandExecutionError('Could not enable Search');
            }
        }

        // No settle wait after toggles: the next CDP eval below already gives
        // React time to flush the aria-checked state.

        if (kwargs.dedupe) {
            const messages = await withRetry(() => getVisibleMessages(page));
            const response = findExistingDeepSeekResponse(messages, prompt);
            if (response) return [await responseRow(page, response)];
        }

        if (kwargs.file) {
            const baseline = await withRetry(() => getBubbleCount(page));
            try {
                const fileResult = kwargs.beforeSubmit
                    ? await sendWithFile(page, kwargs.file, prompt, kwargs.beforeSubmit)
                    : await sendWithFile(page, kwargs.file, prompt);
                if (fileResult && !fileResult.ok) {
                    throw new CommandExecutionError(fileResult.reason || 'Failed to attach file');
                }
            } catch (err) {
                // SPA navigates after send; "Promise was collected" means send succeeded
                if (kwargs.beforeSubmit || !String(err?.message || err).includes('Promise was collected')) throw err;
            }
            await observeConversation(page, kwargs.onConversation);
            // waitForResponse polls every 3 s for new bubbles, so the previous
            // 3 s settle here was a redundant sleep on top of the first poll.
            const result = await waitForResponse(page, baseline, prompt, timeoutMs, wantThink);
            if (!result) {
                throw new TimeoutError('deepseek ask', kwargs.timeout, 'No DeepSeek reply observed before timeout. Retry with --timeout increased.');
            }
            if (kwargs.onDelivery) {
                const response = typeof result === 'string' ? result : result?.response;
                const confirmed = findExistingDeepSeekResponse(await getVisibleMessages(page, { answerOnly: true }), prompt);
                if (!response || confirmed !== response) throw new CommandExecutionError('DeepSeek image reply did not match the approved prompt pair.');
                await kwargs.onDelivery({evidence: 'adapter-exact-prompt-pair', promptHash: createHash('sha256').update(prompt).digest('hex'), responseHash: createHash('sha256').update(response).digest('hex')});
            }
            return [await responseRow(page, result)];
        }

        const baseline = await withRetry(() => getBubbleCount(page));
        const sendResult = kwargs.beforeSubmit ? await sendMessage(page, prompt, kwargs.beforeSubmit)
            : await withRetry(() => sendMessage(page, prompt));
        if (!sendResult?.ok) {
            throw new CommandExecutionError(sendResult?.reason || 'Failed to send message');
        }
        await observeConversation(page, kwargs.onConversation);

        const result = await waitForResponse(page, baseline, prompt, timeoutMs, wantThink);
        if (!result) {
            throw new TimeoutError('deepseek ask', kwargs.timeout, 'No DeepSeek reply observed before timeout. Retry with --timeout increased.');
        }

        if (kwargs.onDelivery) {
            const response = typeof result === 'string' ? result : result?.response;
            const confirmed = findExistingDeepSeekResponse(await getVisibleMessages(page, { answerOnly: true }), prompt);
            if (!response || confirmed !== response) throw new CommandExecutionError('DeepSeek completed reply did not match the approved prompt pair.');
            await kwargs.onDelivery({ evidence: 'adapter-exact-prompt-pair',
                promptHash: createHash('sha256').update(prompt,'utf8').digest('hex'),
                responseHash: createHash('sha256').update(response,'utf8').digest('hex') });
        }
        return [await responseRow(page, result)];
    },
});
askCommand.pageProviderDispatchContract = 'pi-tiered-web-1';
