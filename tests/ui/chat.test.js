import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UiSession } from '../../src/ui/session.js';
import { newClient, fixtureName, tinyPng, LIVE_GEN, withLiveGenRetry, purgeFixtures } from '../helpers.js';

// Live integration tests for the UI chat controller.
// Fixtures: one throwaway character created over HTTP; all chats happen on it.
// UI navigation state is saved and restored around the suite.
const BASE_URL = process.env.ST_URL ?? 'http://localhost:8000';
const TEST_TIMEOUT = 240_000;

let session, client, fixtureChar, savedState;

before(async () => {
    client = await newClient();
    // create fixture character via HTTP
    const name = fixtureName('uichar');
    const avatar = await client.postForm('/api/characters/create', {
        ch_name: name,
        description: 'A test character for driver integration tests.',
        first_mes: 'Hello from the fixture character.',
        personality: 'helpful',
        scenario: 'testing',
        mes_example: '<START>\n{{user}}: hi\n{{char}}: hello',
        talkativeness: '0.5',
    });
    fixtureChar = { name, avatar: avatar.trim() };

    session = new UiSession({ baseUrl: BASE_URL, headless: true });
    await session.launch({ timeout: TEST_TIMEOUT });
    savedState = await session.state.save();
    // refresh the frontend character list (created behind its back via HTTP)
    await session.evaluate(async () => {
        const { getCharacters } = await import('/script.js');
        await getCharacters();
    });
});

after(async () => {
    try {
        if (session && savedState) await session.state.restore(savedState);
    } finally {
        await session?.close();
        if (client && fixtureChar) {
            await client.post('/api/characters/delete', { avatar_url: fixtureChar.avatar, delete_chats: true }).catch(() => {});
        }
        // Deleting the card leaves a dangling tag_map key (and possibly
        // active_character) behind; purgeFixtures clears fixture-valued pointers.
        if (client) await purgeFixtures(client).catch(() => {});
        await client?.close();
    }
});

async function openFixtureChat() {
    await session.evaluate(async ({ name }) => {
        const ctx = SillyTavern.getContext();
        const idx = ctx.characters.findIndex(c => c.name === name);
        if (idx < 0) throw new Error('fixture char not in frontend list');
        await ctx.selectCharacterById(idx, { switchMenu: false });
    }, { name: fixtureChar.name });
}

describe('ChatControl: open & read', { timeout: TEST_TIMEOUT }, () => {
    test('openCharacterByName opens the fixture character chat', async () => {
        await openFixtureChat();
        const state = await session.state.save();
        assert.ok(state.characterId !== null, 'a character must be selected');
    });

    test('read returns the greeting message', async () => {
        await openFixtureChat();
        const msgs = await session.chat.read();
        assert.ok(msgs.length >= 1, 'first_mes should be present');
        const first = msgs[0];
        assert.equal(first.is_user, false);
        assert.match(first.mes, /Hello from the fixture/);
    });

    test('length counts messages', async () => {
        const n = await session.chat.length();
        assert.ok(n >= 1);
    });

    test('last returns the final message', async () => {
        const last = await session.chat.last();
        assert.ok(last);
        assert.equal(typeof last.mes, 'string');
    });
});

describe('ChatControl: injecting messages', { timeout: TEST_TIMEOUT }, () => {
    test('sendUser appends a user message without generating', async () => {
        await openFixtureChat();
        const before = await session.chat.length();
        const marker = `user-inject-${Date.now()}`;
        const r = await session.chat.sendUser(marker);
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const after = await session.chat.length();
        assert.equal(after, before + 1);
        const last = await session.chat.last();
        assert.equal(last.is_user, true);
        assert.equal(last.mes, marker, 'message text must be stored verbatim');
    });

    test('sendUser stores text WITHOUT wrapping quotes (raw=false regression guard)', async () => {
        // /send is declared rawQuotes:true; without raw=false the quotes would
        // end up inside the message text. This is the exact regression we fixed.
        const marker = `quoteguard-${Date.now()}`;
        await session.chat.sendUser(marker);
        const last = await session.chat.last();
        assert.equal(last.mes, marker);
        assert.ok(!last.mes.startsWith('"'), `quotes leaked into message: ${last.mes}`);
        assert.ok(!last.mes.endsWith('"'), `quotes leaked into message: ${last.mes}`);
    });

    test('sendUser preserves a literal pipe character', async () => {
        const marker = `pipe-${Date.now()} | still-here`;
        await session.chat.sendUser(marker);
        const last = await session.chat.last();
        assert.equal(last.mes, marker, 'pipe must not truncate the message');
    });

    test('sendUser preserves literal name= content instead of parsing it as an arg', async () => {
        const marker = `name=world-${Date.now()}`;
        await session.chat.sendUser(marker);
        const last = await session.chat.last();
        assert.equal(last.mes, marker, 'text starting with name= must not be eaten as a named argument');
    });

    test('sendUser preserves inner double quotes', async () => {
        const marker = `say "hi" ok-${Date.now()}`;
        await session.chat.sendUser(marker);
        const last = await session.chat.last();
        assert.equal(last.mes, marker);
    });

    test('sendUser preserves backslashes and newlines', async () => {
        const marker = `line1\nline2 path\\to ${Date.now()}`;
        await session.chat.sendUser(marker);
        const last = await session.chat.last();
        assert.equal(last.mes, marker);
    });

    test('sendUser preserves unicode (CJK + umlauts)', async () => {
        const marker = `中文 ümlaut 日本語-${Date.now()}`;
        await session.chat.sendUser(marker);
        const last = await session.chat.last();
        assert.equal(last.mes, marker);
    });

    test('sendUser compact=true marks the message compact', async () => {
        const marker = `compact-${Date.now()}`;
        const r = await session.chat.sendUser(marker, { compact: true });
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const msgs = await session.chat.read({ includeSystem: true });
        const msg = msgs[msgs.length - 1];
        assert.equal(msg.mes, marker);
        assert.ok(msg.extraKeys.includes('isSmallSys'), `extra keys: ${msg.extraKeys.join(',')}`);
    });

    test('sendUser with at= inserts at the given position', async () => {
        const marker = `at-insert-${Date.now()}`;
        const before = await session.chat.length();
        const r = await session.chat.sendUser(marker, { at: 0 });
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const msgs = await session.chat.read({ includeSystem: true });
        assert.equal(msgs.length, before + 1);
        assert.equal(msgs[0].mes, marker, 'message must land at index 0');
    });

    test('sendAs writes a message attributed to the given character', async () => {
        const marker = `as-inject-${Date.now()}`;
        const r = await session.chat.sendAs(fixtureChar.name, marker);
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const last = await session.chat.last();
        assert.equal(last.is_user, false);
        assert.equal(last.name, fixtureChar.name);
        assert.equal(last.mes, marker);
    });

    test('sendAs rejects a missing name', async () => {
        await assert.rejects(() => session.chat.sendAs('', 'text'), /name is required/);
        await assert.rejects(() => session.chat.sendAs(undefined, 'text'), /name is required/);
    });

    test('sendNarrator writes a visible narrator message (is_system=false, is_user=false)', async () => {
        // /sys narrator messages are INCLUDED in the prompt and shown normally;
        // they are not flagged is_system (only /comment hidden messages are).
        const marker = `narr-${Date.now()}`;
        const r = await session.chat.sendNarrator(marker);
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const msgs = await session.chat.read({ includeSystem: true });
        const msg = msgs.find(m => m.mes === marker);
        assert.ok(msg, 'narrator message must be findable with exact text');
        assert.equal(msg.is_user, false);
        assert.equal(msg.is_system, false);
    });

    test('sendComment writes a hidden comment (is_system=true)', async () => {
        const marker = `comment-${Date.now()}`;
        const r = await session.chat.sendComment(marker);
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const msgs = await session.chat.read({ includeSystem: true });
        const msg = msgs.find(m => m.mes === marker);
        assert.ok(msg, 'comment must exist in chat data');
        assert.equal(msg.is_system, true);
        // and it must be excluded from the default read
        const visible = await session.chat.read();
        assert.ok(!visible.some(m => m.mes === marker), 'comments are hidden by default');
    });

    test('messages(range) reads back by index', async () => {
        const out = await session.chat.messages('0-1');
        assert.equal(typeof out, 'string');
    });
});

describe('ChatControl: deletion & rewinding', { timeout: TEST_TIMEOUT }, () => {
    test('deleteLast removes the final message', async () => {
        await session.chat.sendUser(`doomed-${Date.now()}`);
        const before = await session.chat.length();
        const r = await session.chat.deleteLast(1);
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const after = await session.chat.length();
        assert.equal(after, before - 1);
    });

    test('deleteLast with count=3 removes three messages', async () => {
        for (let i = 0; i < 3; i++) await session.chat.sendUser(`doomed3-${i}-${Date.now()}`);
        const before = await session.chat.length();
        await session.chat.deleteLast(3);
        const after = await session.chat.length();
        assert.equal(after, before - 3);
    });

    test('deleteAt removes a message by index', async () => {
        await session.chat.sendUser(`at-target-${Date.now()}`);
        const before = await session.chat.length();
        await session.chat.deleteAt(before - 1);
        const after = await session.chat.length();
        assert.equal(after, before - 1);
    });
});

describe('ChatControl: swipes', { timeout: TEST_TIMEOUT }, () => {
    // Ensure the last message is a plain character message that swipes can
    // attach to (narrator/comment injections from earlier tests leave the tail
    // in an unpredictable state).
    async function ensureTrailingCharMessage() {
        await openFixtureChat();
        let guard = 0;
        let msgs = await session.chat.read({ includeSystem: true });
        while (msgs.length && (msgs.at(-1).is_user || msgs.at(-1).is_system) && guard++ < 10) {
            await session.chat.deleteAt(msgs.length - 1);
            msgs = await session.chat.read({ includeSystem: true });
        }
        if (!msgs.length || msgs.at(-1).is_user || msgs.at(-1).is_system) {
            await session.chat.sendAs(fixtureChar.name, `seed-for-swipe-${Date.now()}`);
        }
    }

    test('addSwipe appends an alternative to the last char message', async () => {
        await ensureTrailingCharMessage();
        const r = await session.chat.addSwipe(`alt-reply-${Date.now()}`);
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const msgs = await session.chat.read({ includeSystem: true });
        const final = msgs.at(-1);
        assert.ok(final.swipes >= 2, `expected >=2 swipes, got ${final.swipes}`);
    });

    test('deleteSwipe removes a swipe by 1-based number', async () => {
        await ensureTrailingCharMessage();
        const before = (await session.chat.read({ includeSystem: true })).at(-1).swipes;
        if (before < 2) await session.chat.addSwipe(`extra-swipe-${Date.now()}`);
        const count = (await session.chat.read({ includeSystem: true })).at(-1).swipes;
        const r = await session.chat.deleteSwipe(count); // delete the last swipe
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const after = (await session.chat.read({ includeSystem: true })).at(-1).swipes;
        assert.equal(after, count - 1);
    });

    test('swipe left/right changes swipe_id without error', async () => {
        await ensureTrailingCharMessage();
        // make sure there are at least two swipes to move between
        const cur = (await session.chat.read({ includeSystem: true })).at(-1).swipes;
        if (cur < 2) await session.chat.addSwipe(`swipe-target-${Date.now()}`);
        const r = await session.chat.swipe('left');
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const r2 = await session.chat.swipe('right');
        assert.equal(r2.isError, false, r2.errorMessage ?? '');
    });

    test('swipe rejects an invalid direction', async () => {
        await assert.rejects(() => session.chat.swipe('sideways'), /direction must be/);
    });
});

describe('ChatControl: chat lifecycle', { timeout: TEST_TIMEOUT }, () => {
    test('newChat starts an empty chat', async () => {
        await openFixtureChat();
        const r = await session.chat.newChat();
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const n = await session.chat.length();
        assert.ok(n <= 1, `new chat should be empty or greeting-only, got ${n}`);
    });

    test('renameChat renames the current chat file', async () => {
        const newName = fixtureName('renamed');
        const r = await session.chat.renameChat(newName);
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const state = await session.state.save();
        assert.ok(String(state.chatId).includes(newName), `chatId ${state.chatId} should contain ${newName}`);
    });

    test('listVariables returns the chat variable bag', async () => {
        const vars = await session.chat.listVariables();
        assert.equal(typeof vars, 'object');
    });
});

describe('GenerationControl (live LLM, gated by ST_DRIVER_LIVE_GEN)', { timeout: TEST_TIMEOUT }, () => {
    test('sendAndGenerate adds the user turn AND a new character reply', { skip: !LIVE_GEN && 'set ST_DRIVER_LIVE_GEN=1 to enable' }, async () => {
        // Retried on TRANSIENT provider failures only (empty deepseek content /
        // aborted socket - see withLiveGenRetry). Each attempt starts from a
        // fresh chat so a retry never builds on a half-written one. Structural
        // assertions below are NOT retryable: they indicate a driver bug.
        await withLiveGenRetry(async () => {
            await openFixtureChat();
            await session.chat.newChat();
            const greetingCount = await session.chat.length();
            const marker = `say-pong-${Date.now()}`;
            const r = await session.generation.sendAndGenerate(`Reply with exactly: PONG. (${marker})`, { timeout: 240_000 });
            assert.equal(r.ok, true,
                `generation not ok: outcome=${r.outcome} timedOut=${r.timedOut} settledEmpty=${r.settledEmpty} lastMes=${JSON.stringify(r.lastMessage?.mes?.slice(0, 120))}`);

            // the user turn must actually be in the chat (regression: merely filling
            // #send_textarea does NOT add a message in a headless session)
            const msgs = await session.chat.read({ includeSystem: true });
            assert.ok(msgs.some(m => m.is_user && m.mes.includes(marker)), 'the user message must be persisted in the chat');

            // a NEW character message must exist beyond greeting + user turn
            assert.ok(r.chatLength >= greetingCount + 2, `expected greeting+user+reply, got ${r.chatLength} (was ${greetingCount})`);
            const last = await session.chat.last();
            assert.equal(last.is_user, false, 'the last message must be the character reply');
            assert.ok(last.mes.length > 0, 'reply must be non-empty');
            assert.ok(!last.mes.includes('Hello from the fixture'), 'reply must NOT be the greeting (regression guard: silent no-LLM generation)');
        });
    });

    test('generation actually issues an LLM request (no silent skip)', { skip: !LIVE_GEN && 'set ST_DRIVER_LIVE_GEN=1 to enable' }, async () => {
        // Guard against the verified failure mode: with online_status
        // 'no_connection', Generate() returns without calling the backend.
        assert.equal(await session.connection.isConnected(), true, 'generation must ensure a live connection');
    });

    test('quiet generation does not touch the chat', { skip: !LIVE_GEN && 'set ST_DRIVER_LIVE_GEN=1 to enable' }, async () => {
        // `text.length > 0` is retryable: /gen's catch returns '' when deepseek
        // aborts a long non-streaming request (observed live: AbortError in the
        // ST log, green on immediate rerun). The chat-untouched assertion is not.
        await withLiveGenRetry(async () => {
            const before = await session.chat.length();
            const text = await session.generation.gen('Reply with exactly one word: QUIET');
            assert.equal(typeof text, 'string');
            assert.ok(text.length > 0, 'gen must return generated text');
            const after = await session.chat.length();
            assert.equal(after, before, 'chat length must not change');
        });
    });
});
