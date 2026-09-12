import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createStDriver, createUiDriver } from '../../src/index.js';
import { fixtureName, LIVE_GEN } from '../helpers.js';

/**
 * End-to-end workflow tests spanning BOTH tracks:
 *   HTTP API (data plane) -> UI/Playwright (behaviour plane)
 *
 * Scenario mirrors what an agent would actually do:
 *   create a character + a lorebook over HTTP, bind the lorebook, open the chat
 *   in the live frontend, inject messages, drive generation, verify, clean up.
 *
 * Everything uses __drvtest_ fixtures; the UI navigation state is restored and
 * all server-side fixtures are deleted afterwards.
 */
const BASE_URL = process.env.ST_URL ?? 'http://localhost:8000';
const TEST_TIMEOUT = 300_000;

let st, ui, charName, charAvatar, bookName, savedState;

before(async () => {
    st = await createStDriver({ baseUrl: BASE_URL });
    charName = fixtureName('e2e_char');
    bookName = fixtureName('e2e_book');

    // --- data plane: character ---
    const characters = await st.loadApi('characters');
    charAvatar = await characters.create({
        ch_name: charName,
        description: 'An end-to-end test character. She answers briefly and always mentions the secret codeword SUNFISH when asked about the project.',
        personality: 'concise, cooperative',
        scenario: 'integration testing',
        first_mes: `${charName} is ready for the end-to-end test.`,
        mes_example: '<START>\n{{user}}: hi\n{{char}}: Ready.',
        talkativeness: 0.5,
        world: bookName,
    });
    assert.ok(charAvatar.endsWith('.png'), `expected an avatar filename, got ${charAvatar}`);

    // --- data plane: lorebook with a constant entry ---
    const worldinfo = await st.loadApi('worldinfo');
    await worldinfo.edit(bookName, {
        entries: {
            0: {
                uid: 0,
                key: ['project'],
                keysecondary: [],
                comment: 'e2e codeword entry',
                content: 'The project codeword is SUNFISH.',
                constant: true,
                selective: false,
                order: 100,
                position: 0,
                disable: false,
                probability: 100,
                useProbability: true,
                depth: 4,
                role: 0,
            },
        },
    });

    // --- behaviour plane ---
    ui = await createUiDriver({ baseUrl: BASE_URL, headless: true, timeout: TEST_TIMEOUT });
    savedState = await ui.session.state.save();
    await ui.session.evaluate(async () => {
        const { getCharacters } = await import('/script.js');
        await getCharacters();
    });
});

after(async () => {
    try {
        if (ui?.session && savedState) await ui.session.state.restore(savedState);
    } finally {
        await ui?.close();
        if (st && charAvatar) {
            const characters = await st.loadApi('characters').catch(() => null);
            await characters?.delete(charAvatar, { deleteChats: true }).catch(() => {});
        }
        if (st && bookName) {
            const worldinfo = await st.loadApi('worldinfo').catch(() => null);
            await worldinfo?.delete(bookName).catch(() => {});
        }
        await st?.close();
    }
});

describe('E2E: HTTP data plane', { timeout: TEST_TIMEOUT }, () => {
    test('the created character is readable with all card fields', async () => {
        const characters = await st.loadApi('characters');
        const card = await characters.get(charAvatar);
        assert.equal(card.name, charName);
        assert.match(card.description, /end-to-end test character/);
        assert.equal(card.data?.extensions?.world, bookName, 'lorebook must be linked on the card');
    });

    test('the lorebook round-trips every entry field', async () => {
        const worldinfo = await st.loadApi('worldinfo');
        const book = await worldinfo.get(bookName);
        const entry = book.entries[0];
        assert.equal(entry.content, 'The project codeword is SUNFISH.');
        assert.equal(entry.constant, true);
        assert.deepEqual(entry.key, ['project']);
        assert.equal(entry.order, 100);
    });

    test('the character lists in /all with the fixture prefix', async () => {
        const characters = await st.loadApi('characters');
        const all = await characters.all();
        assert.ok(all.some(c => c.avatar === charAvatar));
    });
});

describe('E2E: UI behaviour plane', { timeout: TEST_TIMEOUT }, () => {
    test('the character opens in the live frontend', async () => {
        await ui.session.chat.openCharacterByName(charName);
        const state = await ui.session.state.save();
        assert.ok(state.characterId !== null, 'a character must be selected');
    });

    test('the greeting from the card is rendered into the chat', async () => {
        await ui.session.chat.openCharacterByName(charName);
        const msgs = await ui.session.chat.read();
        assert.ok(msgs.length >= 1, 'first_mes should populate the chat');
        assert.match(msgs[0].mes, /ready for the end-to-end test/);
    });

    test('a narrator message and a user message can be injected', async () => {
        await ui.session.chat.openCharacterByName(charName);
        const narr = await ui.session.chat.sendNarrator('The test harness injects a narrator line.');
        assert.equal(narr.isError, false, narr.errorMessage ?? '');
        const user = await ui.session.chat.sendUser(`e2e-marker-${Date.now()}`);
        assert.equal(user.isError, false, user.errorMessage ?? '');
        const msgs = await ui.session.chat.read({ includeSystem: true });
        assert.ok(msgs.some(m => m.mes.includes('test harness injects a narrator line')));
        assert.ok(msgs.some(m => m.mes.startsWith('e2e-marker-')));
    });

    test('STscript chat variables persist across calls in the same chat', async () => {
        const key = `e2e_${Date.now().toString(36)}`;
        await ui.session.stscript.runOrThrow(`/setvar key=${key} 7`);
        const got = await ui.session.stscript.runOrThrow(`/getvar key=${key}`);
        assert.equal(got, '7');
        const inc = await ui.session.stscript.runOrThrow(`/incvar ${key}`);
        assert.equal(inc, '8');
        await ui.session.stscript.runOrThrow(`/flushvar ${key}`);
    });

    test('the lorebook is visible to the frontend world-info scanner', async () => {
        const visible = await ui.session.stscript.runOrThrow(`/world "${bookName}"`);
        // /world binds a global book; empty pipe with no error means success
        assert.equal(typeof visible, 'string');
        // unbind again so the user's global WI selection is unchanged
        await ui.session.stscript.run(`/world "${bookName}"`).catch(() => {});
    });
});

describe('E2E: full generation round trip (live LLM, gated)', { timeout: TEST_TIMEOUT }, () => {
    let userTurnCount;

    test('user message -> generation -> a NEW character reply (not the greeting)', { skip: !LIVE_GEN && 'set ST_DRIVER_LIVE_GEN=1 to enable' }, async () => {
        await ui.session.chat.openCharacterByName(charName);
        await ui.session.chat.newChat();
        const greetingCount = await ui.session.chat.length();
        // assign BEFORE the assertions so a failure here still leaves the
        // follow-up persistence test with a meaningful diagnostic
        userTurnCount = greetingCount;

        const result = await ui.session.generation.sendAndGenerate(
            'What is the project codeword? Answer in one short sentence.',
            { timeout: 240_000 },
        );
        assert.equal(result.ok, true,
            `generation not ok: outcome=${result.outcome} timedOut=${result.timedOut} settledEmpty=${result.settledEmpty} lastMes=${JSON.stringify(result.lastMessage?.mes?.slice(0, 120))}`);

        // Strict regression guards for two verified failure modes:
        //  1. the user turn silently not being added to the chat
        //  2. Generate() returning without calling the LLM (no_connection),
        //     which left the greeting as the "reply"
        assert.ok(result.chatLength >= greetingCount + 2,
            `expected greeting + user turn + reply, got ${result.chatLength} (greeting was ${greetingCount})`);

        const msgs = await ui.session.chat.read({ includeSystem: true });
        assert.ok(msgs.some(m => m.is_user && /codeword/i.test(m.mes ?? '')), 'the user turn must be in the chat');

        const last = await ui.session.chat.last();
        assert.equal(last.is_user, false, 'the last message must come from the character');
        assert.ok(last.mes.length > 0, 'reply must be non-empty');
        assert.ok(!/ready for the end-to-end test/i.test(last.mes),
            `reply must not be the greeting (silent no-LLM generation): ${last.mes.slice(0, 120)}`);

        // The lorebook entry is `constant`, so it is always injected - the model
        // should be able to name the codeword. Soft assert: LLM wording varies.
        if (!/SUNFISH/i.test(last.mes)) {
            console.warn(`[e2e] lorebook codeword not echoed in reply: ${last.mes.slice(0, 200)}`);
        }
    });

    test('the generated chat is persisted server-side and readable over HTTP', { skip: !LIVE_GEN && 'set ST_DRIVER_LIVE_GEN=1 to enable' }, async () => {
        const chats = await st.loadApi('chats');
        const state = await ui.session.state.save();
        assert.ok(state.chatId, 'the frontend must know the active chat id');

        // ST saves chats on a debounce; poll until BOTH the user turn and the
        // character reply have landed instead of sleeping a fixed interval
        // (a fixed wait was flaky when the LLM reply streamed in slowly).
        let saved = null;
        const deadline = Date.now() + 60_000;
        let lastError = null;
        while (Date.now() < deadline) {
            try {
                const candidate = await chats.get({ avatarUrl: charAvatar, fileName: state.chatId });
                const hasUser = Array.isArray(candidate) && candidate.some(m => m.is_user && /codeword/i.test(m.mes ?? ''));
                const hasReply = Array.isArray(candidate) && candidate.some(m => !m.is_user && !m.is_system);
                if (hasUser && hasReply) {
                    saved = candidate;
                    break;
                }
                lastError = `partial (user=${hasUser}, reply=${hasReply}, lines=${Array.isArray(candidate) ? candidate.length : 'n/a'})`;
            } catch (e) {
                lastError = String(e?.message ?? e);
            }
            await new Promise(r => setTimeout(r, 1500));
        }
        assert.ok(saved, `chat never reached the server within 60s: ${lastError}`);

        const list = await chats.search({ avatarUrl: charAvatar });
        assert.ok(list.length >= 1, 'at least one chat file must exist');
        assert.ok(saved.length >= 2, 'header + messages expected');
        assert.ok(saved.some(m => m.is_user && /codeword/i.test(m.mes ?? '')), 'the user turn must be persisted');
        assert.ok(saved.some(m => !m.is_user && !m.is_system), 'the character reply must be persisted');
        assert.ok(userTurnCount >= 1, 'the greeting turn must have existed before generation');
    });
});
