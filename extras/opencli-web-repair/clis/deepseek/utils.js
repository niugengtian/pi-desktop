import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { htmlToMarkdown } from '@jackwener/opencli/utils';

export const DEEPSEEK_DOMAIN = 'chat.deepseek.com';
export const DEEPSEEK_URL = 'https://chat.deepseek.com/';
export const TEXTAREA_SELECTOR = 'textarea[placeholder*="DeepSeek"]';
const COMPOSER_ACTION_SELECTOR = 'div[role="button"].ds-button--primary.ds-button--circle';
export const MESSAGE_SELECTOR = '.ds-message';
const CONVERSATION_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * Normalize a DeepSeek conversation ID. Accepts a bare UUID or any URL that
 * embeds one (`/a/chat/s/<id>` or full chat URL).
 *
 * Throws ArgumentError when the input does not contain a UUID-shaped id, so
 * `detail` fails before any browser navigation happens.
 */
export function parseDeepSeekConversationId(input) {
    const raw = String(input ?? '').trim();
    if (!raw) {
        throw new ArgumentError('id', 'must be a non-empty conversation ID or URL');
    }
    const urlMatch = raw.match(/\/a\/chat\/s\/([a-f0-9-]+)/i);
    const candidate = urlMatch ? urlMatch[1] : raw;
    if (!CONVERSATION_ID_RE.test(candidate)) {
        throw new ArgumentError(
            'id',
            `not a valid DeepSeek conversation ID (got "${input}"); expected a UUID like "749e6bbd-6a45-4440-beaa-ae5238bf06d8" or a full /a/chat/s/<id> URL`,
        );
    }
    return candidate.toLowerCase();
}

export async function isOnDeepSeek(page) {
    const url = await page.evaluate('window.location.href').catch(() => '');
    if (typeof url !== 'string' || !url) return false;
    try {
        const h = new URL(url).hostname;
        return h === 'deepseek.com' || h.endsWith('.deepseek.com');
    } catch {
        return false;
    }
}

export async function ensureOnDeepSeek(page) {
    if (await isOnDeepSeek(page)) return false;
    await page.goto(DEEPSEEK_URL);
    // Wait for the composer textarea instead of a fixed 3 s sleep. On the login
    // page it never mounts; swallow the timeout so callers (status / read /
    // history) can still inspect page state.
    try {
        await page.wait({ selector: TEXTAREA_SELECTOR, timeout: 8 });
    } catch {
        // Login or error page — downstream will see hasTextarea=false / empty results.
    }
    return true;
}

export async function getPageState(page) {
    return page.evaluate(`(() => {
        const url = window.location.href;
        const title = document.title;
        const textarea = document.querySelector('${TEXTAREA_SELECTOR}');
        const avatar = document.querySelector('img[src*="user-avatar"]');
        return {
            url,
            title,
            hasTextarea: !!textarea,
            isLoggedIn: !!avatar,
        };
    })()`);
}

export async function selectModel(page, modelName) {
    return page.evaluate(`(() => {
        var radios = document.querySelectorAll('div[role="radio"]');
        if (radios.length === 0) return { ok: false };
        var name = '${modelName}'.toLowerCase();
        var index = name === 'instant' ? 0 : name === 'expert' ? 1 : name === 'vision' ? 2 : -1;
        if (index < 0 || index >= radios.length) return { ok: false };
        var target = radios[index];
        var alreadySelected = target.getAttribute('aria-checked') === 'true';
        if (!alreadySelected) target.click();
        return { ok: true, toggled: !alreadySelected };
    })()`);
}

export async function setFeature(page, featureName, enabled) {
    // Match by position: DeepThink is the first toggle, Search is the second
    var index = featureName === 'DeepThink' ? 0 : 1;
    return page.evaluate(`(() => {
        var toggles = Array.from(document.querySelectorAll('.ds-toggle-button'));
        var btn = toggles[${index}];
        if (!btn) return { ok: false };
        var isActive = btn.classList.contains('ds-toggle-button--selected');
        if (${enabled} !== isActive) btn.click();
        return { ok: true, toggled: ${enabled} !== isActive };
    })()`);
}

export async function sendMessage(page, prompt, beforeSubmit) {
    const promptJson = JSON.stringify(prompt);
    if (beforeSubmit) {
        const expectedPath = new URL(await page.evaluate("window.location.href")).pathname;
        const prepared = await page.evaluate(`(() => {
            const box = document.querySelector('${TEXTAREA_SELECTOR}');
            if (!box) return { ok: false };
            box.focus();
            // Use the native setter so React observes the change after file-upload rerenders.
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (!setter) return { ok: false };
            setter.call(box, ${promptJson});
            box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${promptJson} }));
            box.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
        })()`);
        if (!prepared?.ok) return { ok: false, reason: 'textarea not found' };
        const actual = await page.evaluate(`document.querySelector('${TEXTAREA_SELECTOR}')?.value`);
        if (actual !== prompt) throw new CommandExecutionError('DeepSeek composer did not preserve the complete approved text.');
        await beforeSubmit(actual);
        // Recheck in the same browser evaluation as the single side-effecting click.
        return page.evaluate(`(() => {
            const box = document.querySelector('${TEXTAREA_SELECTOR}');
            if (!box || box.value !== ${promptJson} || location.pathname !== ${JSON.stringify(expectedPath)})
                return { ok: false, reason: 'composer or fresh conversation changed' };
            var container = box.parentElement;
            while (container && !container.querySelector('${COMPOSER_ACTION_SELECTOR}')) container = container.parentElement;
            var buttons = container?.querySelectorAll('${COMPOSER_ACTION_SELECTOR}');
            var button = buttons?.[buttons.length - 1];
            if (!button || button.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'send not ready' };
            button.click(); return { ok: true };
        })()`);
    }
    return page.evaluate(`(async () => {
        const box = document.querySelector('${TEXTAREA_SELECTOR}');
        if (!box) return { ok: false, reason: 'textarea not found' };

        box.focus();
        box.value = '';
        document.execCommand('selectAll');
        document.execCommand('insertText', false, ${promptJson});
        await new Promise(r => setTimeout(r, 800));

        // Find the send button: last non-toggle button in the textarea's container
        var container = box.parentElement;
        while (container && !container.querySelector('${COMPOSER_ACTION_SELECTOR}')) {
            container = container.parentElement;
        }
        if (container) {
            var btns = container.querySelectorAll('${COMPOSER_ACTION_SELECTOR}');
            var sendBtn = btns[btns.length - 1];
            if (sendBtn && sendBtn.getAttribute('aria-disabled') !== 'true'
                && sendBtn.querySelectorAll('svg').length > 0) {
                sendBtn.click();
                return { ok: true };
            }
        }

        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        return { ok: true, method: 'enter' };
    })()`);
}

export function deepSeekHtmlToMarkdown(html, fallback = '') {
    try {
        return htmlToMarkdown(String(html || '')).trim() || String(fallback || '').trim();
    } catch {
        return String(fallback || '').trim();
    }
}

export async function getBubbleCount(page) {
    const baseline = await page.evaluate(`(() => {
        const bubbles = document.querySelectorAll('${MESSAGE_SELECTOR}');
        const texts = Array.from(bubbles).map(b => (b.innerText || '').trim()).filter(Boolean);
        return { count: texts.length, last: texts[texts.length - 1] || '' };
    })()`);
    return baseline && typeof baseline === 'object'
        ? { count: baseline.count || 0, last: baseline.last || '' }
        : { count: Number(baseline) || 0, last: '' };
}

// Parse thinking response using text as a fallback when DOM-level extraction
// is not available.  Does NOT split on \n\n — that heuristic silently corrupts
// multi-paragraph thinking or multi-paragraph answers.  Instead, everything
// after the header is treated as thinking content, and `response` stays empty
// until the caller provides a DOM-separated answer.
export function parseThinkingResponse(rawText) {
    if (!rawText) return null;

    // Match thinking header patterns: "Thought for X seconds" or "已思考（用时 X 秒）"
    const thinkHeaderMatch = rawText.match(/^(Thought for ([\d.]+) seconds?|已思考（用时 ([\d.]+) 秒）)\s*/);

    if (!thinkHeaderMatch) {
        // No thinking section found, return plain response
        return { response: rawText, thinking: null, thinking_time: null };
    }

    const thinkingTime = thinkHeaderMatch[2] || thinkHeaderMatch[3];
    const afterHeader = rawText.slice(thinkHeaderMatch[0].length);

    // Treat everything after the header as thinking.  The response will be
    // populated by the DOM-level extraction in waitForResponse().
    return {
        response: '',
        thinking: afterHeader.trim(),
        thinking_time: thinkingTime,
    };
}

export async function waitForResponse(page, baselineCount, prompt, timeoutMs, parseThinking = false) {
    const startTime = Date.now();
    const baseline = typeof baselineCount === 'object'
        ? baselineCount
        : { count: Number(baselineCount) || 0, last: '' };
    const normalizedPrompt = prompt.trim();
    let promptObserved = false;
    let lastText = '';
    let stableCount = 0;
    let emptyPollCount = 0;
    let virtualListPaintRequested = false;

    while (Date.now() - startTime < timeoutMs) {
        await page.wait(3);

        let result;
        try {
            result = await page.evaluate(`(() => {
                const bubbles = document.querySelectorAll('${MESSAGE_SELECTOR}');
                const entries = Array.from(bubbles).map(function(b) {
                    return {
                        element: b,
                        text: (b.innerText || '').trim(),
                        isUser: !b.querySelector('.ds-markdown, .ds-assistant-message-main-content'),
                    };
                }).filter(function(entry) { return entry.text; });
                const texts = entries.map(function(entry) { return entry.text; });
                var last = texts[texts.length - 1] || '';
                var promptObserved = entries.some(function(entry) {
                    return entry.isUser && entry.text === ${JSON.stringify(normalizedPrompt)};
                });

                function markdownHtml(element) {
                    if (!element) return null;
                    var clone = element.cloneNode(true);
                    Array.from(clone.querySelectorAll('.md-code-block')).forEach(function(block) {
                        var source = block.querySelector('pre');
                        if (!source) return;
                        var languageNode = block.querySelector('.md-code-block-banner span');
                        var language = languageNode ? (languageNode.textContent || '').trim().toLowerCase() : '';
                        if (!/^[a-z0-9_+#.-]{1,32}$/i.test(language)) language = '';
                        var pre = document.createElement('pre');
                        var code = document.createElement('code');
                        if (language) code.className = 'language-' + language;
                        code.textContent = source.textContent || '';
                        pre.appendChild(code);
                        block.replaceWith(pre);
                    });
                    Array.from(clone.querySelectorAll('button, [role="button"], svg')).forEach(function(node) {
                        node.remove();
                    });
                    return clone.innerHTML || '';
                }

                // DOM-level thinking/response separation.
                // DeepSeek renders thinking in a collapsible container with a
                // distinct class (e.g. .ds-markdown--think or similar) and the
                // final answer in the main .ds-markdown region.  By querying
                // these separately we avoid any text-heuristic split.
                var thinkEl = null, answerEl = null, thinkTime = null;
                var lastBubble = entries.length > 0 ? entries[entries.length - 1].element : null;
                var complete = false;
                var generating = null;
                if (lastBubble && lastBubble.parentElement) {
                    var actions = Array.from(lastBubble.parentElement.querySelectorAll('[role="button"], button'));
                    complete = actions.some(function(action) {
                        var label = ((action.getAttribute('aria-label') || '') + ' ' + (action.innerText || '')).trim();
                        return /^(朗读|Read aloud)$/i.test(label);
                    });
                }
                // The response action bar can mount before streaming ends.
                // The composer action is authoritative on current DeepSeek:
                // while generating it is an enabled Stop control; once done,
                // it becomes the disabled Send control for the empty textarea.
                var composer = document.querySelector('${TEXTAREA_SELECTOR}');
                var composerContainer = composer ? composer.parentElement : null;
                while (composerContainer && !composerContainer.querySelector('${COMPOSER_ACTION_SELECTOR}')) {
                    composerContainer = composerContainer.parentElement;
                }
                if (composerContainer) {
                    var composerButtons = Array.from(composerContainer.querySelectorAll('${COMPOSER_ACTION_SELECTOR}'));
                    var composerAction = composerButtons[composerButtons.length - 1];
                    if (composerAction) {
                        var disabled = composerAction.getAttribute('aria-disabled') === 'true'
                            || composerAction.classList.contains('ds-button--disabled');
                        generating = !disabled;
                    }
                }
                if (${parseThinking} && lastBubble) {
                    // Thinking container — DeepSeek uses various class names;
                    // try common selectors.
                    thinkEl = lastBubble.querySelector('.ds-markdown--think')
                           || lastBubble.querySelector('[class*="think"]');
                    // Final answer container — the main markdown block that is
                    // NOT the thinking section.
                    var markdownEls = lastBubble.querySelectorAll('.ds-markdown');
                    for (var i = 0; i < markdownEls.length; i++) {
                        if (markdownEls[i] !== thinkEl
                            && !(thinkEl && thinkEl.contains(markdownEls[i]))
                            && !markdownEls[i].classList.contains('ds-markdown--think')) {
                            answerEl = markdownEls[i];
                        }
                    }
                    // Thinking time from the toggle/header element
                    var timeEl = lastBubble.querySelector('[class*="think"] ~ *')
                              || lastBubble.querySelector('.ds-thinking-header');
                    if (!timeEl) {
                        // Fallback: parse from raw text header
                        var m = last.match(/^(?:Thought for ([\\d.]+) seconds?|已思考（用时 ([\\d.]+) 秒）)/);
                        if (m) thinkTime = m[1] || m[2];
                    } else {
                        var tm = (timeEl.textContent || '').match(/([\\d.]+)/);
                        if (tm) thinkTime = tm[1];
                    }
                }

                return {
                    count: texts.length,
                    last: last,
                    // DOM-separated fields (null when not available)
                    thinkText: thinkEl ? (thinkEl.innerText || '').trim() : null,
                    answerText: answerEl ? (answerEl.innerText || '').trim() : null,
                    lastHtml: markdownHtml(lastBubble),
                    thinkHtml: markdownHtml(thinkEl),
                    answerHtml: markdownHtml(answerEl),
                    thinkTime: thinkTime,
                    complete: complete,
                    generating: generating,
                    promptObserved: promptObserved,
                };
            })()`);
        } catch {
            continue;
        }

        if (!result) continue;

        if (result.count === 0 && !result.last) {
            emptyPollCount += 1;
            // A newly-created DeepSeek conversation can update the URL while
            // Chromium leaves its background virtual message list unpainted.
            // Request one in-memory viewport capture to force that paint. This
            // is a read-side recovery and never resends the prompt.
            if (!virtualListPaintRequested && emptyPollCount >= 5 && typeof page.screenshot === 'function') {
                const conversationUrl = await page.evaluate('window.location.href').catch(() => '');
                if (/\/a\/chat\/s\/[a-f0-9-]+/i.test(String(conversationUrl))) {
                    virtualListPaintRequested = true;
                    try {
                        // Keep the image in memory only; it is neither returned
                        // to the provider nor persisted as a trace artifact.
                        await page.screenshot();
                        await page.wait({ selector: MESSAGE_SELECTOR, timeout: 10 });
                    } catch {
                        // Continue bounded polling; the normal timeout remains authoritative.
                    }
                }
            }
            continue;
        }
        emptyPollCount = 0;

        const candidate = result.last;
        if (result.promptObserved || candidate === normalizedPrompt) {
            promptObserved = true;
        }
        if (candidate === normalizedPrompt) {
            lastText = '';
            stableCount = 0;
            continue;
        }
        const advanced = result.count > baseline.count
            || candidate !== baseline.last
            || promptObserved;
        if (candidate && advanced && promptObserved) {
            if (result.generating === true) {
                // A Reasoner answer can pause for many seconds between the
                // thinking section and final code block. Text stability during
                // that pause is not completion.
                stableCount = 0;
                lastText = candidate;
                continue;
            }
            if (candidate === lastText) {
                stableCount++;
                // When the composer confirms generation ended, require one
                // additional unchanged observation so the final DOM flush can
                // settle. Unknown composer state keeps a long bounded fallback.
                const requiredStablePolls = result.generating === false ? 1 : 6;
                if (stableCount >= requiredStablePolls) {
                    if (parseThinking) {
                        // Prefer DOM-level separation
                        if (result.thinkText != null || result.answerText != null) {
                            return {
                                thinking: deepSeekHtmlToMarkdown(result.thinkHtml, result.thinkText),
                                response: deepSeekHtmlToMarkdown(result.answerHtml, result.answerText),
                                thinking_time: result.thinkTime || null,
                            };
                        }
                        // Fallback to text-header parsing (no \n\n split)
                        return parseThinkingResponse(candidate);
                    }
                    return deepSeekHtmlToMarkdown(result.lastHtml, candidate);
                }
            } else {
                stableCount = 0;
            }
            lastText = candidate;
        }
    }

    if (parseThinking && lastText) {
        return parseThinkingResponse(lastText);
    }
    return lastText || null;
}

export function findExistingDeepSeekResponse(messages, prompt) {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const promptKey = normalize(prompt);
    if (!promptKey) return '';
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const user = messages[index];
        if (user?.Role !== 'user' || normalize(user.Text) !== promptKey) continue;
        const assistant = messages.slice(index + 1).find((message) => message?.Role === 'assistant');
        if (assistant?.Text) return String(assistant.Text).trim();
    }
    return '';
}

export async function getVisibleMessages(page, { answerOnly = false } = {}) {
    const result = await page.evaluate(`(() => {
        function markdownHtml(element) {
            var clone = element.cloneNode(true);
            Array.from(clone.querySelectorAll('.md-code-block')).forEach(function(block) {
                var source = block.querySelector('pre');
                if (!source) return;
                var languageNode = block.querySelector('.md-code-block-banner span');
                var language = languageNode ? (languageNode.textContent || '').trim().toLowerCase() : '';
                if (!/^[a-z0-9_+#.-]{1,32}$/i.test(language)) language = '';
                var pre = document.createElement('pre');
                var code = document.createElement('code');
                if (language) code.className = 'language-' + language;
                code.textContent = source.textContent || '';
                pre.appendChild(code);
                block.replaceWith(pre);
            });
            Array.from(clone.querySelectorAll('button, [role="button"], svg')).forEach(function(node) {
                node.remove();
            });
            return clone.innerHTML || '';
        }
        const msgs = document.querySelectorAll('${MESSAGE_SELECTOR}');
        return Array.from(msgs).map(m => {
            // Assistant messages own the rendered Markdown container; user
            // bubble hash classes are unstable and must not define the role.
            const isUser = !m.querySelector('.ds-markdown, .ds-assistant-message-main-content');
            var body = m;
            if (${answerOnly} && !isUser) {
                var think = m.querySelector('.ds-markdown--think') || m.querySelector('[class*="think"]');
                var answers = Array.from(m.querySelectorAll('.ds-markdown')).filter(function(node) {
                    return node !== think && !(think && think.contains(node)) && !node.classList.contains('ds-markdown--think');
                });
                body = answers[answers.length - 1];
                if (!body) return { Role: 'assistant', Text: '', Html: '' };
            }
            const textClone = body.cloneNode(true);
            Array.from(textClone.querySelectorAll('button, [role="button"], svg')).forEach(function(control) {
                control.remove();
            });
            return {
                Role: isUser ? 'user' : 'assistant',
                Text: (textClone.textContent || '').trim(),
                Html: isUser ? '' : markdownHtml(body),
            };
        }).filter(m => m.Text);
    })()`);
    if (!Array.isArray(result)) return [];
    return result.map((message) => ({
        Role: message.Role,
        Text: message.Role === 'assistant'
            ? deepSeekHtmlToMarkdown(message.Html, message.Text)
            : message.Text,
    }));
}

export async function getConversationList(page) {
    await ensureOnDeepSeek(page);
    // Expand sidebar if collapsed
    await page.evaluate(`(() => {
        if (document.querySelectorAll('a[href*="/a/chat/s/"]').length === 0) {
            const btn = document.querySelector('div[tabindex="0"][role="button"]');
            if (btn) btn.click();
        }
    })()`);
    for (let attempt = 0; attempt < 5; attempt++) {
        await page.wait(2);
        const items = await page.evaluate(`(() => {
            const items = [];
            const links = document.querySelectorAll('a[href*="/a/chat/s/"]');
            links.forEach((link, i) => {
                const title = (link.innerText || '').trim().split('\\n')[0].trim();
                const href = link.getAttribute('href') || '';
                const idMatch = href.match(/\\/s\\/([a-f0-9-]+)/);
                items.push({
                    Index: i + 1,
                    Id: idMatch ? idMatch[1] : href,
                    Title: title || '(untitled)',
                    Url: 'https://chat.deepseek.com' + href,
                });
            });
            return items;
        })()`);
        if (Array.isArray(items) && items.length > 0) return items;
    }
    return [];
}

/**
 * Pick the URL of the most recent non-pinned conversation, or the first overall
 * if every visible conversation is pinned.
 *
 * Used by `ask` when the workspace was recycled and we need to resume an
 * existing thread instead of opening a new chat. Polls the sidebar for up to
 * 10s and returns null if no conversation links surface in time, so callers
 * can fail fast instead of silently navigating to a fresh page.
 *
 * Pinned detection is text-based on the section header ("置顶" / "Pinned"),
 * because DeepSeek's CSS-module class names are randomized per build.
 */
export async function pickResumeUrl(page) {
    await page.evaluate(`(() => {
        if (document.querySelectorAll('a[href*="/a/chat/s/"]').length === 0) {
            const btn = document.querySelector('div[tabindex="0"][role="button"]');
            if (btn) btn.click();
        }
    })()`);
    for (let attempt = 0; attempt < 5; attempt++) {
        await page.wait(2);
        const url = await page.evaluate(`(() => {
            const links = document.querySelectorAll('a[href*="/a/chat/s/"]');
            if (links.length === 0) return null;
            const PINNED_HEADER = /^\\s*(置\\s*顶|Pinned)\\s*$/i;
            const isPinned = (link) => {
                const section = link.parentElement;
                const header = section && section.firstElementChild;
                if (!header || header === link) return false;
                return PINNED_HEADER.test((header.innerText || header.textContent || '').trim());
            };
            const target = Array.from(links).find((l) => !isPinned(l)) || links[0];
            const href = target.getAttribute('href') || '';
            return href ? 'https://chat.deepseek.com' + href : null;
        })()`);
        if (url) return url;
    }
    return null;
}

export async function waitForFilePreview(page, fileName) {
    for (let attempt = 0; attempt < 60; attempt++) {
        await page.wait(2);
        const ready = await page.evaluate(`(() => {
            var name = ${JSON.stringify(fileName)};
            var hasFileName = Array.from(document.querySelectorAll('div'))
                .some(function(el) { return el.children.length === 0 && (el.textContent || '').trim() === name; });
            var hasImageAlt = Array.from(document.querySelectorAll('img'))
                .some(function(img) { return (img.getAttribute('alt') || '') === name; });
            if (hasFileName || hasImageAlt) {
                const thumbnail = Array.from(document.querySelectorAll('img')).find(img => img.getAttribute('alt') === name);
                const preview = thumbnail?.closest('[role="button"]');
                // DeepSeek keeps the spinner mounted after upload, hiding its overlay
                // with opacity: 0. Only a visibly loading preview is still pending.
                const isVisible = (node) => {
                    for (let el = node; el; el = el.parentElement) {
                        const style = getComputedStyle(el);
                        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                    }
                    return true;
                };
                return !Array.from(preview?.querySelectorAll('.ds-loading, [data-icon="spin"]') || []).some(isVisible);
            }
            // Vision mode shows an image thumbnail, not filename text. Require
            // a preview-like node here; send-button readiness is checked later.
            var box = document.querySelector('${TEXTAREA_SELECTOR}');
            if (!box) return false;
            var c = box.parentElement;
            while (c && !c.querySelector('${COMPOSER_ACTION_SELECTOR}')) c = c.parentElement;
            if (!c) return false;
            return !!c.querySelector('img[src], canvas, video, [style*="background-image"], [class*="preview"], [class*="upload"]');
        })()`);
        if (ready) return true;
    }
    return false;
}

export async function sendWithFile(page, filePath, prompt, beforeSubmit) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const inputPaths = Array.isArray(filePath) ? filePath : [filePath];
    if (inputPaths.length === 0 || inputPaths.length > 8) {
        return { ok: false, reason: 'Attach between 1 and 8 files' };
    }
    const absPaths = inputPaths.map(value => path.default.resolve(value));

    let totalSize = 0;
    for (const absPath of absPaths) {
        if (!fs.default.existsSync(absPath)) {
            return { ok: false, reason: `File not found: ${absPath}` };
        }
        const stats = fs.default.statSync(absPath);
        if (!stats.isFile()) {
            return { ok: false, reason: `Not a regular file: ${absPath}` };
        }
        if (stats.size > 100 * 1024 * 1024) {
            return { ok: false, reason: `File too large (${(stats.size / 1024 / 1024).toFixed(1)} MB). Max: 100 MB` };
        }
        totalSize += stats.size;
    }

    const fileNames = absPaths.map(value => path.default.basename(value));

    // Collapse sidebar to keep DOM simple for send button matching
    await page.evaluate(`(() => {
        if (document.querySelectorAll('a[href*="/a/chat/s/"]').length > 0) {
            const btn = document.querySelector('div[tabindex="0"][role="button"]');
            if (btn) btn.click();
        }
    })()`);
    await page.wait(0.5);

    let uploaded = false;
    let fallbackAccepted = false;
    if (page.setFileInput) {
        try {
            await page.setFileInput(absPaths, 'input[type="file"]');
            uploaded = true;
        } catch (err) {
            const msg = String(err?.message || err);
            if (!msg.includes('Unknown action')
                && !msg.includes('not supported')
                && !msg.includes('Not allowed')
                && !msg.includes('fileChooserOpened not received')) {
                throw err;
            }
        }
    }

    if (!uploaded) {
        // The compatibility path base64-encodes every file in memory. Bound the
        // aggregate before reading so eight individually valid files cannot
        // create a gigabyte-scale browser-evaluation payload.
        if (totalSize > 100 * 1024 * 1024) {
            return { ok: false, reason: 'Files are too large for the compatibility upload path. Max total: 100 MB' };
        }
        const mimeByExtension = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
        };
        const encodedFiles = absPaths.map((absPath, index) => ({
            name: fileNames[index],
            type: mimeByExtension[path.default.extname(absPath).toLowerCase()] || 'application/octet-stream',
            base64: fs.default.readFileSync(absPath).toString('base64'),
        }));
        const fallbackResult = await page.evaluate(`(async () => {
            var encodedFiles = ${JSON.stringify(encodedFiles)};
            var dt = new DataTransfer();
            for (var fileIndex = 0; fileIndex < encodedFiles.length; fileIndex++) {
                var encoded = encodedFiles[fileIndex];
                var binary = atob(encoded.base64);
                var bytes = new Uint8Array(binary.length);
                for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                dt.items.add(new File([bytes], encoded.name, { type: encoded.type }));
            }

            var inp = document.querySelector('input[type="file"]');
            if (!inp) return { ok: false, reason: 'file input not found' };

            inp.files = dt.files;
            // React consumes and clears the native file input synchronously.
            // Record the accepted count first, then use the standard delegated event.
            var acceptedCount = inp.files.length;
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, acceptedCount: acceptedCount };
        })()`);
        if (fallbackResult && !fallbackResult.ok) return fallbackResult;
        fallbackAccepted = fallbackResult?.acceptedCount === absPaths.length;
        if (!fallbackAccepted) {
            return { ok: false, reason: 'file input did not accept every selected file' };
        }
    }

    for (const fileName of fileNames) {
        const ready = await waitForFilePreview(page, fileName);
        if (!ready) return { ok: false, reason: `file preview did not appear: ${fileName}` };
    }

    // File preview appears immediately but send button stays disabled until
    // the server upload finishes. Wait for it.
    let sendEnabled = false;
    for (let tick = 0; tick < 60; tick++) {
        const enabled = await page.evaluate(`(() => {
            var box = document.querySelector('${TEXTAREA_SELECTOR}');
            if (!box) return false;
            var c = box.parentElement;
            while (c && !c.querySelector('${COMPOSER_ACTION_SELECTOR}')) c = c.parentElement;
            if (!c) return false;
            var btns = c.querySelectorAll('${COMPOSER_ACTION_SELECTOR}');
            var last = btns[btns.length - 1];
            return !!(last && last.getAttribute('aria-disabled') !== 'true' && !last.classList.contains('ds-button--disabled'));
        })()`);
        if (enabled) {
            sendEnabled = true;
            break;
        }
        await page.wait(1);
    }
    if (!sendEnabled) {
        return { ok: false, reason: 'send button did not enable after upload' };
    }

    return sendMessage(page, prompt, beforeSubmit);
}

// Retries on CDP "Promise was collected" errors caused by DeepSeek's SPA router transitions.
export async function withRetry(fn, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            const msg = String(err?.message || err);
            if (i < retries && msg.includes('Promise was collected')) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            throw err;
        }
    }
}

export function parseBoolFlag(value) {
    if (typeof value === 'boolean') return value;
    return String(value ?? '').trim().toLowerCase() === 'true';
}
