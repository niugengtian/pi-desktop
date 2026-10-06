import { cli, Strategy } from '@jackwener/opencli/registry';
import { createHash } from 'node:crypto';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
    sleepForChatGPTPoll,
    CHATGPT_DOMAIN,
    CHATGPT_URL,
    currentChatGPTUrl,
    ensureChatGPTComposer,
    ensureOnChatGPT,
    findExistingChatGPTResponse,
    getChatGPTResponsePairCounts,
    getVisibleMessages,
    normalizeBooleanFlag,
    openChatGPTConversation,
    requireNonEmptyPrompt,
    requirePositiveInt,
    parseChatGPTConversationId,
    sendChatGPTMessage,
    selectChatGPTTool,
    isGenerating,
    startNewChat,
    navigateToProject,
    uploadChatGPTImages,
    waitForChatGPTResponse,
} from './utils.js';

async function waitForConversationUrl(page, timeoutSeconds = 30) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutSeconds * 1000) {
        const conversationUrl = await currentChatGPTUrl(page);
        try {
            const conversationId = parseChatGPTConversationId(conversationUrl);
            return { conversationId, conversationUrl };
        } catch {
            await page.wait(1);
        }
    }
    throw new CommandExecutionError('ChatGPT did not create a conversation URL after sending the message.');
}

export const askCommand = cli({
    site: 'chatgpt',
    name: 'ask',
    access: 'write',
    description: 'Send a prompt to ChatGPT web and wait for the response',
    domain: CHATGPT_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    siteSession: 'persistent',
    navigateBefore: false,
    args: [
        { name: 'prompt', positional: true, required: true, help: 'Prompt to send' },
        { name: 'timeout', type: 'int', default: 120, help: 'Max seconds to wait for response' },
        { name: 'new', type: 'boolean', default: false, help: 'Start a new chat before sending' },
        { name: 'conversation', valueRequired: true, help: 'Continue an existing ChatGPT conversation ID or /c/<id> URL' },
        { name: 'project', valueRequired: true, help: 'Start a new chat inside a ChatGPT project ID or /g/g-p-<id> URL' },
        { name: 'wait', type: 'boolean', default: true, help: 'Wait for the assistant response after sending' },
        { name: 'deep-research', type: 'boolean', default: false, help: 'Enable ChatGPT 深度研究 (Deep Research)' },
        { name: 'web-search', type: 'boolean', default: false, help: 'Enable ChatGPT 网页搜索 (Web Search)' },
        { name: 'file', help: 'Attach one image path or an ordered array of image paths' },
    ],
    columns: ['conversationId', 'conversationUrl', 'tool', 'response'],
    func: async (page, kwargs) => {
        const prompt = requireNonEmptyPrompt(kwargs.prompt, 'chatgpt ask');
        if ((kwargs.beforeSubmit || kwargs.onDelivery) && (typeof kwargs.beforeSubmit !== 'function'
            || typeof kwargs.onDelivery !== 'function' || (kwargs.new !== true && !kwargs.conversation)
            || kwargs.dedupe || kwargs.project || kwargs.wait === false
            || kwargs['deep-research'] || kwargs['web-search']))
            throw new ArgumentError('Gated ChatGPT requires a new or bound conversation, waiting turn with both callbacks.');
        const timeout = requirePositiveInt(
            Number(kwargs.timeout ?? 120),
            'chatgpt ask --timeout',
            'Example: opencli chatgpt ask "hello" --timeout 120',
        );
        const useDeepResearch = normalizeBooleanFlag(kwargs['deep-research'], false);
        const useWebSearch = normalizeBooleanFlag(kwargs['web-search'], false);
        const shouldWait = normalizeBooleanFlag(kwargs.wait, true);
        if (useDeepResearch && useWebSearch) {
            throw new ArgumentError(
                'chatgpt ask cannot enable both --deep-research and --web-search',
                'Choose one ChatGPT composer tool for this message.',
            );
        }
        if (normalizeBooleanFlag(kwargs.new) && kwargs.conversation) {
            throw new ArgumentError(
                'chatgpt ask cannot use --new and --conversation together',
                'Choose either a new chat or an existing conversation.',
            );
        }
        if (kwargs.project && kwargs.conversation) {
            throw new ArgumentError(
                'chatgpt ask cannot use --project and --conversation together',
                'Choose either a project new chat or an existing conversation.',
            );
        }
        const tool = useDeepResearch ? 'deep-research' : (useWebSearch ? 'web-search' : null);

        if (kwargs.conversation) {
            await openChatGPTConversation(page, kwargs.conversation);
        } else if (kwargs.project) {
            await navigateToProject(page, kwargs.project);
        } else if (normalizeBooleanFlag(kwargs.new)) {
            await startNewChat(page);
        } else {
            await ensureOnChatGPT(page);
        }
        // startNewChat / ensureOnChatGPT now wait for the composer selector
        // after navigating, so the previous standalone 2 s settle is redundant.
        await ensureChatGPTComposer(page, 'ChatGPT ask requires a logged-in ChatGPT session with a visible composer.');
        const selectedTool = tool ? await selectChatGPTTool(page, tool) : null;

        const settleStart = Date.now();
        while (await isGenerating(page)) {
            if (Date.now() - settleStart > timeout * 1000) {
                throw new CommandExecutionError('ChatGPT conversation is still generating; wait for it to finish before sending another message.');
            }
            await sleepForChatGPTPoll(page, 3);
        }

        const baselineMessages = await getVisibleMessages(page);
        const baseline = baselineMessages.length;
        const baselinePairCounts = getChatGPTResponsePairCounts(baselineMessages, prompt);
        if (kwargs.dedupe) {
            const response = findExistingChatGPTResponse(baselineMessages, prompt);
            if (response) {
                const conversationUrl = await currentChatGPTUrl(page);
                const conversationId = parseChatGPTConversationId(conversationUrl);
                return [{ conversationId, conversationUrl, tool: selectedTool?.Tool ?? '', response }];
            }
        }
        if (kwargs.file) {
            const imagePaths = Array.isArray(kwargs.file) ? kwargs.file : [kwargs.file];
            const uploadResult = await uploadChatGPTImages(page, imagePaths);
            if (!uploadResult?.ok) {
                throw new CommandExecutionError(uploadResult?.reason || 'Failed to attach images to ChatGPT');
            }
        }
        if (kwargs.beforeSubmit) {
            const url = await currentChatGPTUrl(page);
            if (!url || (kwargs.new === true ? new URL(url).pathname !== '/' || (await getVisibleMessages(page)).length : parseChatGPTConversationId(url) !== parseChatGPTConversationId(kwargs.conversation)))
                throw new CommandExecutionError('Gated ChatGPT requires an observed requested conversation.');
        }
        const sent = kwargs.beforeSubmit
            ? await sendChatGPTMessage(page, prompt, kwargs.beforeSubmit)
            : await sendChatGPTMessage(page, prompt);
        if (!sent) {
            throw new CommandExecutionError('Failed to send message to ChatGPT', `Open ${CHATGPT_URL} and verify the composer is ready.`);
        }

        const { conversationId, conversationUrl } = await waitForConversationUrl(page);
        if (typeof kwargs.onConversation === 'function') {
            await kwargs.onConversation({ conversationId, conversationUrl });
        }
        if (!shouldWait) {
            return [{ conversationId, conversationUrl, tool: selectedTool?.Tool ?? '', response: '' }];
        }
        const response = await waitForChatGPTResponse(page, baseline, prompt, timeout, {
            baselinePairCounts,
            conversationUrl,
        });
        if (kwargs.onDelivery) {
            const confirmed = findExistingChatGPTResponse(await getVisibleMessages(page), prompt);
            if (confirmed !== response || !response) throw new CommandExecutionError('ChatGPT completed reply did not match the approved prompt pair.');
            await kwargs.onDelivery({ evidence: 'adapter-exact-prompt-pair',
                promptHash: createHash('sha256').update(prompt,'utf8').digest('hex'),
                responseHash: createHash('sha256').update(response,'utf8').digest('hex') });
        }
        return [{ conversationId, conversationUrl, tool: selectedTool?.Tool ?? '', response }];
    },
});
askCommand.pageProviderDispatchContract = 'pi-tiered-web-1';
