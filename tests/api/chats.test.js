/**
 * LIVE integration tests for ChatsApi (src/api/chats.js).
 *
 * These tests talk to a real, running SillyTavern server (default
 * http://localhost:8000, override with ST_URL). A single fixture character is
 * created in before(), every chat operation runs against it, and the character
 * (with all of its chats) is deleted in after().
 *
 * Behaviors verified against the live server that deviate from naive
 * expectations (also documented in the module JSDoc):
 * - /save and /get always append '.jsonl' to file_name, so a caller that
 *   passes 'x.jsonl' would silently create 'x.jsonl.jsonl'. ChatsApi strips a
 *   trailing '.jsonl' before sending.
 * - /rename does NOT append '.jsonl' to renamed_file. Renaming to 'x' (no
 *   extension) succeeds with 200 but produces a file the chat list can no
 *   longer see. ChatsApi appends '.jsonl' when the extension is missing.
 * - /export expects `file` WITH the '.jsonl' extension (404 otherwise);
 *   ChatsApi appends it when missing. Without `exportfilename` the response
 *   message is literally 'Chat saved to undefined'.
 * - /search returns `file_name` values WITHOUT the .jsonl extension (they are
 *   the file_id), unlike /api/characters/chats.
 * - /delete appends '.jsonl' only when the given name has no extension at all.
 * - Group chat routes (/api/chats/group/*) are out of scope for this module.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChatsApi } from '../../src/api/chats.js';
import { CharactersApi } from '../../src/api/characters.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, fixtureName, purgeFixtures, FIXTURE_PREFIX } from '../helpers.js';

let client;
let api;
let characters;
/** Fixture character everything is operated on. */
let avatar;
let charName;

before(async () => {
    client = await newClient();
    api = new ChatsApi(client);
    characters = new CharactersApi(client);
    charName = fixtureName('chat');
    avatar = await characters.create({ ch_name: charName, description: 'chat fixture' });
});

after(async () => {
    if (avatar) {
        await characters.delete(avatar, { deleteChats: true }).catch(() => {});
    }
    await purgeFixtures(client);
    const remaining = (await characters.all()).filter(c => String(c.avatar).startsWith(FIXTURE_PREFIX));
    assert.deepEqual(remaining.map(c => c.avatar), [], 'all character fixtures must be cleaned up');
    await client?.close();
});

/**
 * Build a minimal valid chat array: header + the given messages.
 * @param {object[]} [messages]
 * @returns {object[]}
 */
function chatArray(messages = []) {
    return [header(), ...messages];
}

/** The chat file header object ST expects at index 0. */
function header(chatMetadata = {}) {
    return { chat_metadata: chatMetadata, user_name: 'unused', character_name: 'unused' };
}

/** A message object in the shape ST stores in JSONL. */
function message(mes, extra = {}) {
    return {
        name: extra.is_user ? 'Tester' : charName,
        is_user: !!extra.is_user,
        is_system: !!extra.is_system,
        send_date: extra.send_date ?? new Date().toISOString(),
        mes,
        extra: extra.extra ?? {},
    };
}

describe('ChatsApi.save (POST /api/chats/save)', () => {
    test('save creates a new chat file and returns {ok: true}', async () => {
        const fileName = `${charName} - save basic`;
        const res = await api.save({ avatarUrl: avatar, fileName, chat: chatArray([message('hello', { is_user: true })]) });
        assert.deepEqual(res, { ok: true });
        const list = await api.search({ avatarUrl: avatar });
        assert.ok(list.some(c => c.file_name === fileName), 'the saved chat must be findable');
    });

    test('save persists the chat[0] header {chat_metadata, user_name, character_name} verbatim', async () => {
        const fileName = `${charName} - save header`;
        await api.save({
            avatarUrl: avatar,
            fileName,
            chat: [header({ drvtest_key: 'drvtest_value' })],
        });
        const chat = await api.get({ avatarUrl: avatar, fileName });
        assert.equal(chat.length, 1);
        assert.deepEqual(chat[0].chat_metadata, { drvtest_key: 'drvtest_value' });
        assert.equal(chat[0].user_name, 'unused');
        assert.equal(chat[0].character_name, 'unused');
    });

    test('save round-trips every message field: name, is_user, is_system, send_date, mes, extra', async () => {
        const fileName = `${charName} - save fields`;
        const sendDate = '2026-01-02T03:04:05.000Z';
        await api.save({
            avatarUrl: avatar,
            fileName,
            chat: chatArray([
                message('user text', { is_user: true, send_date: sendDate, extra: { drvtest: 'u' } }),
                message('char text', { is_user: false, send_date: sendDate, extra: { drvtest: 'c' } }),
                message('system text', { is_system: true, send_date: sendDate, extra: {} }),
            ]),
        });
        const chat = await api.get({ avatarUrl: avatar, fileName });
        assert.equal(chat.length, 4);
        const [userMsg, charMsg, sysMsg] = chat.slice(1);
        assert.equal(userMsg.name, 'Tester');
        assert.equal(userMsg.is_user, true);
        assert.equal(userMsg.is_system, false);
        assert.equal(userMsg.send_date, sendDate);
        assert.equal(userMsg.mes, 'user text');
        assert.deepEqual(userMsg.extra, { drvtest: 'u' });
        assert.equal(charMsg.name, charName);
        assert.equal(charMsg.is_user, false);
        assert.equal(charMsg.mes, 'char text');
        assert.deepEqual(charMsg.extra, { drvtest: 'c' });
        assert.equal(sysMsg.is_system, true);
        assert.equal(sysMsg.mes, 'system text');
    });

    test('save persists swipe fields swipes[], swipe_info[] and swipe_id', async () => {
        const fileName = `${charName} - save swipes`;
        const swipeInfo = [
            { send_date: new Date().toISOString(), gen_started: null, gen_finished: null, extra: {} },
            { send_date: new Date().toISOString(), gen_started: null, gen_finished: null, extra: {} },
        ];
        await api.save({
            avatarUrl: avatar,
            fileName,
            chat: chatArray([
                {
                    name: charName,
                    is_user: false,
                    is_system: false,
                    send_date: new Date().toISOString(),
                    mes: 'swipe two',
                    extra: {},
                    swipes: ['swipe one', 'swipe two'],
                    swipe_id: 1,
                    swipe_info: swipeInfo,
                },
            ]),
        });
        const chat = await api.get({ avatarUrl: avatar, fileName });
        const msg = chat[1];
        assert.deepEqual(msg.swipes, ['swipe one', 'swipe two']);
        assert.equal(msg.swipe_id, 1);
        assert.equal(msg.swipe_info.length, 2);
        assert.deepEqual(msg.swipe_info[0], swipeInfo[0]);
        assert.equal(msg.mes, 'swipe two', 'mes stays whatever the caller saved');
    });

    test('save with force: true overwrites an existing chat file', async () => {
        const fileName = `${charName} - save force`;
        await api.save({ avatarUrl: avatar, fileName, chat: chatArray([message('first version', { is_user: true })]) });
        const res = await api.save({
            avatarUrl: avatar,
            fileName,
            force: true,
            chat: chatArray([message('second version', { is_user: true })]),
        });
        assert.deepEqual(res, { ok: true });
        const chat = await api.get({ avatarUrl: avatar, fileName });
        assert.equal(chat.length, 2);
        assert.equal(chat[1].mes, 'second version');
    });

    test('save with a fileName that already ends in .jsonl does not double the extension', async () => {
        const fileName = `${charName} - save ext`;
        await api.save({ avatarUrl: avatar, fileName: `${fileName}.jsonl`, chat: chatArray([message('ext check', { is_user: true })]) });
        const list = await api.search({ avatarUrl: avatar });
        assert.ok(list.some(c => c.file_name === fileName), 'file must be stored as "<name>.jsonl"');
        assert.equal(list.some(c => c.file_name === `${fileName}.jsonl`), false, 'no "<name>.jsonl.jsonl" file');
        const chat = await api.get({ avatarUrl: avatar, fileName: `${fileName}.jsonl` });
        assert.equal(chat.length, 2);
    });

    test('save with a non-array chat throws StApiError 400', async () => {
        await assert.rejects(
            () => api.save({ avatarUrl: avatar, fileName: `${charName} - bad`, chat: 'not-an-array' }),
            err => err instanceof StApiError && err.status === 400 && err.body.error.includes('not an array'),
        );
    });

    test("save with '/' in fileName is sanitized by the server (verified: 'bad/name' -> 'badname.jsonl')", async () => {
        // The validateFileName middleware only guards avatar_url; file_name goes
        // through sanitize-filename, which STRIPS the slash and saves happily (200).
        const res = await api.save({ avatarUrl: avatar, fileName: 'bad/name', chat: chatArray([message('slash probe')]) });
        assert.deepEqual(res, { ok: true });
        // NOTE: /search reports file_name WITHOUT the extension (it is the file_id),
        // unlike /api/characters/chats which includes it.
        const list = await api.search({ avatarUrl: avatar });
        assert.ok(list.some(c => c.file_name === 'badname'), 'slash must be stripped, not rejected');
    });

    test('save without a fileName rejects client-side (TypeError, no bogus request)', async () => {
        await assert.rejects(
            () => api.save({ avatarUrl: avatar, chat: chatArray() }),
            err => err instanceof TypeError && /'fileName' is required/.test(err.message),
        );
    });

    test('save with an empty fileName rejects client-side', async () => {
        await assert.rejects(
            () => api.save({ avatarUrl: avatar, fileName: '   ', chat: chatArray() }),
            err => err instanceof TypeError && /non-empty/.test(err.message),
        );
    });
});

describe('ChatsApi.get (POST /api/chats/get)', () => {
    test('get returns the header plus all saved messages as an array', async () => {
        const fileName = `${charName} - get basic`;
        await api.save({
            avatarUrl: avatar,
            fileName,
            chat: chatArray([message('m1', { is_user: true }), message('m2'), message('m3', { is_user: true })]),
        });
        const chat = await api.get({ avatarUrl: avatar, fileName });
        assert.ok(Array.isArray(chat));
        assert.equal(chat.length, 4);
        assert.deepEqual(chat.map(m => m.mes).slice(1), ['m1', 'm2', 'm3']);
    });

    test('get for a nonexistent fileName returns [] (empty array, HTTP 200)', async () => {
        const chat = await api.get({ avatarUrl: avatar, fileName: `${charName} - definitely missing` });
        assert.deepEqual(chat, []);
    });

    test('get without fileName returns {} (HTTP 200)', async () => {
        const chat = await api.get({ avatarUrl: avatar });
        assert.deepEqual(chat, {});
    });

    test('get for an unknown avatarUrl returns {} and creates the chat directory server-side', async () => {
        const ghost = `${fixtureName('ghostchat')}.png`;
        assert.deepEqual(await api.get({ avatarUrl: ghost, fileName: 'x' }), {});
        // the directory now exists, so /api/characters/chats no longer reports an error
        assert.deepEqual(await characters.chats(ghost), []);
        // cleanup: create + delete a character under that name to remove the
        // empty chat directory the server just created
        const base = ghost.replace(/\.png$/, '');
        const ghostAvatar = await characters.create({ ch_name: base, file_name: base });
        await characters.delete(ghostAvatar, { deleteChats: true });
    });

    test("get with '/' in avatar_url throws StApiError 400 (validateFileName middleware)", async () => {
        await assert.rejects(
            () => api.get({ avatarUrl: 'bad/name.png', fileName: 'x' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('ChatsApi.rename (POST /api/chats/rename)', () => {
    test('rename moves the chat file and returns {ok: true, sanitizedFileName}', async () => {
        const original = `${charName} - rename src`;
        const renamed = `${charName} - rename dst`;
        await api.save({ avatarUrl: avatar, fileName: original, chat: chatArray([message('keep me', { is_user: true })]) });
        const res = await api.rename({ avatarUrl: avatar, originalFile: original, renamedFile: renamed });
        assert.equal(res.ok, true);
        assert.equal(res.sanitizedFileName, renamed);
        const chat = await api.get({ avatarUrl: avatar, fileName: renamed });
        assert.equal(chat[1].mes, 'keep me');
        assert.deepEqual(await api.get({ avatarUrl: avatar, fileName: original }), [], 'source must be gone');
    });

    test('rename appends .jsonl when renamedFile has no extension (the server does not)', async () => {
        // Live finding: renaming to a bare name succeeds but stores the file
        // without an extension, which makes it invisible to every chat listing.
        const original = `${charName} - rename noext src`;
        const renamed = `${charName} - rename noext dst`;
        await api.save({ avatarUrl: avatar, fileName: original, chat: chatArray([message('ext check', { is_user: true })]) });
        const res = await api.rename({ avatarUrl: avatar, originalFile: original, renamedFile: renamed });
        assert.equal(res.ok, true);
        const chat = await api.get({ avatarUrl: avatar, fileName: renamed });
        assert.equal(chat[1].mes, 'ext check', 'renamed chat must still be readable as a .jsonl file');
        const list = await api.search({ avatarUrl: avatar });
        assert.ok(list.some(c => c.file_name === renamed), 'renamed chat must appear in listings');
    });

    test('rename accepts originalFile with the .jsonl extension', async () => {
        const original = `${charName} - rename with ext`;
        await api.save({ avatarUrl: avatar, fileName: original, chat: chatArray([message('x', { is_user: true })]) });
        const res = await api.rename({ avatarUrl: avatar, originalFile: `${original}.jsonl`, renamedFile: `${original}2.jsonl` });
        assert.equal(res.ok, true);
        assert.deepEqual((await api.get({ avatarUrl: avatar, fileName: `${original}2` })).length, 2);
    });

    test('rename without renamedFile rejects client-side (TypeError); raw server answers 400', async () => {
        const original = `${charName} - rename missing dst`;
        await api.save({ avatarUrl: avatar, fileName: original, chat: chatArray() });
        // wrapper fails fast instead of sending 'undefined.jsonl'
        await assert.rejects(
            () => api.rename({ avatarUrl: avatar, originalFile: original }),
            err => err instanceof TypeError && /'renamedFile' is required/.test(err.message),
        );
        // the server itself answers 400 when the field is truly absent
        await assert.rejects(
            () => client.post('/api/chats/rename', { avatar_url: avatar, original_file: `${original}.jsonl`, is_group: false }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('rename without originalFile rejects client-side', async () => {
        await assert.rejects(
            () => api.rename({ avatarUrl: avatar, renamedFile: 'x' }),
            err => err instanceof TypeError && /'originalFile' is required/.test(err.message),
        );
    });

    test('rename onto an existing destination throws StApiError 400', async () => {
        const a = `${charName} - rename clash a`;
        const b = `${charName} - rename clash b`;
        await api.save({ avatarUrl: avatar, fileName: a, chat: chatArray() });
        await api.save({ avatarUrl: avatar, fileName: b, chat: chatArray() });
        await assert.rejects(
            () => api.rename({ avatarUrl: avatar, originalFile: a, renamedFile: b }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('rename for a nonexistent source throws StApiError 400', async () => {
        await assert.rejects(
            () => api.rename({ avatarUrl: avatar, originalFile: `${charName} - no such chat`, renamedFile: `${charName} - target` }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('ChatsApi.delete (POST /api/chats/delete)', () => {
    test('delete removes the chat file and returns {ok: true} (extension optional)', async () => {
        const fileName = `${charName} - delete no ext`;
        await api.save({ avatarUrl: avatar, fileName, chat: chatArray([message('doomed', { is_user: true })]) });
        const res = await api.delete({ avatarUrl: avatar, chatFile: fileName });
        assert.deepEqual(res, { ok: true });
        assert.deepEqual(await api.get({ avatarUrl: avatar, fileName }), []);
    });

    test('delete accepts chatFile with the .jsonl extension', async () => {
        const fileName = `${charName} - delete with ext`;
        await api.save({ avatarUrl: avatar, fileName, chat: chatArray([message('doomed', { is_user: true })]) });
        const res = await api.delete({ avatarUrl: avatar, chatFile: `${fileName}.jsonl` });
        assert.deepEqual(res, { ok: true });
        assert.deepEqual(await api.get({ avatarUrl: avatar, fileName }), []);
    });

    test('delete of a nonexistent chat throws StApiError 400', async () => {
        await assert.rejects(
            () => api.delete({ avatarUrl: avatar, chatFile: `${charName} - not here` }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('ChatsApi.search (POST /api/chats/search)', () => {
    test('search with a matching query returns file_name (without .jsonl), file_size, message_count, last_mes and preview_message', async () => {
        const fileName = `${charName} - search hit`;
        const sendDate = new Date().toISOString();
        await api.save({
            avatarUrl: avatar,
            fileName,
            chat: chatArray([message('needle-in-haystack text', { is_user: true, send_date: sendDate })]),
        });
        const results = await api.search({ query: 'needle-in-haystack', avatarUrl: avatar });
        assert.equal(results.length, 1);
        assert.equal(results[0].file_name, fileName, 'search file_name is the file_id, i.e. no extension');
        assert.equal(results[0].message_count, 1);
        assert.equal(results[0].last_mes, sendDate);
        assert.equal(typeof results[0].file_size, 'string');
        assert.ok(results[0].preview_message.includes('needle-in-haystack'));
    });

    test('search is case-insensitive and matches every whitespace-separated fragment', async () => {
        const fileName = `${charName} - search case`;
        await api.save({ avatarUrl: avatar, fileName, chat: chatArray([message('Mixed CASE Token', { is_user: true })]) });
        assert.equal((await api.search({ query: 'mixed token', avatarUrl: avatar })).length, 1);
    });

    test('search with a non-matching query returns []', async () => {
        const results = await api.search({ query: 'zzz-definitely-no-match-zzz', avatarUrl: avatar });
        assert.deepEqual(results, []);
    });

    test('search without a query lists every chat of the character', async () => {
        const all = await api.search({ avatarUrl: avatar });
        const list = await characters.chats(avatar, { simple: true });
        assert.equal(all.length, list.length, 'search must see the same files as /api/characters/chats');
        assert.ok(all.every(entry => typeof entry.file_name === 'string' && typeof entry.message_count === 'number'));
    });

    test('search only returns chats of the given avatarUrl', async () => {
        const other = await characters.create({ ch_name: fixtureName('chato') });
        try {
            const unique = 'drvtest-unique-marker-9f3a';
            await api.save({ avatarUrl: other, fileName: 'other chat', chat: chatArray([message(unique, { is_user: true })]) });
            const results = await api.search({ query: unique, avatarUrl: avatar });
            assert.deepEqual(results, [], 'the other character chat must not leak into this search');
        } finally {
            await characters.delete(other, { deleteChats: true }).catch(() => {});
        }
    });

    test('search for a character with no chat directory returns []', async () => {
        assert.deepEqual(await api.search({ query: 'anything', avatarUrl: `${fixtureName('nodir')}.png` }), []);
    });
});

describe('ChatsApi.recent (POST /api/chats/recent)', () => {
    test('recent returns recently touched chats across characters, each tagged with its avatar', async () => {
        const fileName = `${charName} - recent basic`;
        await api.save({ avatarUrl: avatar, fileName, chat: chatArray([message('recent me', { is_user: true })]) });
        const recent = await api.recent();
        assert.ok(Array.isArray(recent));
        const entry = recent.find(r => r.file_id === fileName && r.avatar === avatar);
        assert.ok(entry, 'the freshly saved chat must be listed');
        assert.equal(entry.file_name, `${fileName}.jsonl`);
        assert.equal(entry.chat_items, 1);
        assert.equal(entry.chat_metadata, undefined, 'metadata is only included when requested');
    });

    test('recent({max}) limits the number of returned entries', async () => {
        const small = await api.recent({ max: 2 });
        const large = await api.recent({ max: 50 });
        assert.ok(small.length <= 2, `expected at most 2 entries, got ${small.length}`);
        assert.ok(large.length > small.length, 'a larger max must return at least as many chats');
    });

    test('recent({metadata: true}) includes chat_metadata for each entry', async () => {
        const fileName = `${charName} - recent meta`;
        await api.save({ avatarUrl: avatar, fileName, chat: [header({ drvtest_recent: 'yes' })] });
        const recent = await api.recent({ max: 20, metadata: true });
        const entry = recent.find(r => r.file_id === fileName);
        assert.ok(entry, 'fixture chat must be in the recent list');
        assert.deepEqual(entry.chat_metadata, { drvtest_recent: 'yes' });
    });
});

describe('ChatsApi.export (POST /api/chats/export)', () => {
    test("export with format 'jsonl' returns {message, result} where result is the raw JSONL text", async () => {
        const fileName = `${charName} - export jsonl`;
        await api.save({ avatarUrl: avatar, fileName, chat: chatArray([message('raw line one', { is_user: true }), message('raw line two')]) });
        const res = await api.export({ file: fileName, avatarUrl: avatar, format: 'jsonl' });
        assert.equal(typeof res.message, 'string');
        assert.equal(typeof res.result, 'string');
        const lines = res.result.split('\n').filter(Boolean);
        assert.equal(lines.length, 3);
        assert.deepEqual(JSON.parse(lines[0]), header());
        assert.equal(JSON.parse(lines[1]).mes, 'raw line one');
        assert.equal(JSON.parse(lines[2]).mes, 'raw line two');
    });

    test("export with format 'txt' renders 'name: message' blocks and skips is_system messages", async () => {
        const fileName = `${charName} - export txt`;
        await api.save({
            avatarUrl: avatar,
            fileName,
            chat: chatArray([
                message('visible user line', { is_user: true }),
                message('hidden system line', { is_system: true }),
                message('visible char line'),
            ]),
        });
        const res = await api.export({ file: fileName, avatarUrl: avatar, format: 'txt' });
        assert.ok(res.result.includes('Tester: visible user line'));
        assert.ok(res.result.includes(`${charName}: visible char line`));
        assert.equal(res.result.includes('hidden system line'), false, 'system messages are not exported');
    });

    test('export passes exportfilename through into the response message', async () => {
        const fileName = `${charName} - export name`;
        await api.save({ avatarUrl: avatar, fileName, chat: chatArray([message('x', { is_user: true })]) });
        const res = await api.export({ file: fileName, avatarUrl: avatar, format: 'jsonl', exportfilename: 'my-backup.jsonl' });
        assert.equal(res.message, 'Chat saved to my-backup.jsonl');
    });

    test("export without exportfilename yields the literal message 'Chat saved to undefined' (ST quirk)", async () => {
        const fileName = `${charName} - export noname`;
        await api.save({ avatarUrl: avatar, fileName, chat: chatArray([message('x', { is_user: true })]) });
        const res = await api.export({ file: fileName, avatarUrl: avatar, format: 'jsonl' });
        assert.equal(res.message, 'Chat saved to undefined');
    });

    test('export accepts file with or without the .jsonl extension', async () => {
        const fileName = `${charName} - export ext`;
        await api.save({ avatarUrl: avatar, fileName, chat: chatArray([message('ext export', { is_user: true })]) });
        const withExt = await api.export({ file: `${fileName}.jsonl`, avatarUrl: avatar, format: 'jsonl' });
        assert.ok(withExt.result.includes('ext export'));
    });

    test('export of a nonexistent file throws StApiError 404', async () => {
        await assert.rejects(
            () => api.export({ file: `${charName} - missing export`, avatarUrl: avatar, format: 'jsonl' }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('export without file rejects client-side (TypeError); raw server answers 400', async () => {
        // wrapper fails fast instead of exporting 'undefined.jsonl'
        await assert.rejects(
            () => api.export({ avatarUrl: avatar, format: 'jsonl' }),
            err => err instanceof TypeError && /'file' is required/.test(err.message),
        );
        // the server itself answers 400 when `file` is absent
        await assert.rejects(
            () => client.post('/api/chats/export', { avatar_url: avatar, format: 'jsonl' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('export of a non-existent chat file throws StApiError 404', async () => {
        await assert.rejects(
            () => api.export({ file: `${charName} - definitely missing`, avatarUrl: avatar, format: 'jsonl' }),
            err => err instanceof StApiError && err.status === 404,
        );
    });
});

describe('ChatsApi.import (POST /api/chats/import, multipart)', () => {
    test("import(buffer, {fileType: 'jsonl'}) imports a JSONL chat and returns {res: true, fileNames}", async () => {
        const jsonl = [
            header(),
            message('imported jsonl line', { is_user: true }),
        ].map(o => JSON.stringify(o)).join('\n');
        const res = await api.import(Buffer.from(jsonl, 'utf8'), {
            avatarUrl: avatar,
            fileType: 'jsonl',
            characterName: charName,
            userName: 'Tester',
        });
        assert.equal(res.res, true);
        assert.ok(Array.isArray(res.fileNames) && res.fileNames.length === 1);
        assert.ok(res.fileNames[0].endsWith('imported.jsonl'), `unexpected import name ${res.fileNames[0]}`);
        const imported = await api.get({ avatarUrl: avatar, fileName: res.fileNames[0].replace(/\.jsonl$/, '') });
        assert.equal(imported.length, 2);
        assert.equal(imported[1].mes, 'imported jsonl line');
    });

    test("import(buffer, {fileType: 'json'}) imports an Ooba-style chat and applies characterName/userName", async () => {
        const ooba = JSON.stringify({ data_visible: [['ooba user text', 'ooba char reply']] });
        const res = await api.import(Buffer.from(ooba, 'utf8'), {
            avatarUrl: avatar,
            fileType: 'json',
            characterName: 'ImportedChar',
            userName: 'ImportedUser',
        });
        assert.equal(res.res, true);
        assert.equal(res.fileNames.length, 1);
        assert.ok(res.fileNames[0].startsWith('ImportedChar - '));
        const imported = await api.get({ avatarUrl: avatar, fileName: res.fileNames[0].replace(/\.jsonl$/, '') });
        assert.equal(imported.length, 3);
        assert.equal(imported[1].name, 'ImportedUser');
        assert.equal(imported[1].is_user, true);
        assert.equal(imported[1].mes, 'ooba user text');
        assert.equal(imported[2].name, 'ImportedChar');
        assert.equal(imported[2].is_user, false);
        assert.equal(imported[2].mes, 'ooba char reply');
    });

    test('import omits characterName/userName defaults to Character and User', async () => {
        const ooba = JSON.stringify({ data_visible: [['hi', 'yo']] });
        const res = await api.import(Buffer.from(ooba, 'utf8'), { avatarUrl: avatar, fileType: 'json' });
        assert.equal(res.res, true);
        assert.ok(res.fileNames[0].startsWith('Character - '));
        const imported = await api.get({ avatarUrl: avatar, fileName: res.fileNames[0].replace(/\.jsonl$/, '') });
        assert.equal(imported[1].name, 'User');
        assert.equal(imported[2].name, 'Character');
    });

    test('import of malformed JSONL returns {error: true} (HTTP 200)', async () => {
        const res = await api.import(Buffer.from('this is not jsonl at all', 'utf8'), {
            avatarUrl: avatar,
            fileType: 'jsonl',
            characterName: charName,
            userName: 'Tester',
        });
        assert.deepEqual(res, { error: true });
    });

    test('import of an unrecognized JSON shape returns {error: true} (HTTP 200)', async () => {
        const res = await api.import(Buffer.from(JSON.stringify({ nope: true }), 'utf8'), {
            avatarUrl: avatar,
            fileType: 'json',
            characterName: charName,
            userName: 'Tester',
        });
        assert.deepEqual(res, { error: true });
    });

    test("import with '/' in avatar_url throws StApiError 400 (validateFileName middleware)", async () => {
        await assert.rejects(
            () => api.import(Buffer.from('x', 'utf8'), { avatarUrl: 'bad/name.png', fileType: 'jsonl' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('ChatsApi end-to-end lifecycle', () => {
    test('save -> search -> rename -> export -> import -> delete leaves no trace of the chat', async () => {
        const original = `${charName} - lifecycle`;
        const renamed = `${charName} - lifecycle renamed`;
        await api.save({
            avatarUrl: avatar,
            fileName: original,
            chat: chatArray([message('lifecycle start', { is_user: true }), message('lifecycle reply')]),
        });
        assert.equal((await api.search({ query: 'lifecycle start', avatarUrl: avatar })).length, 1);

        const rn = await api.rename({ avatarUrl: avatar, originalFile: original, renamedFile: renamed });
        assert.equal(rn.ok, true);

        const exported = await api.export({ file: renamed, avatarUrl: avatar, format: 'jsonl' });
        assert.ok(exported.result.includes('lifecycle reply'));

        const imported = await api.import(Buffer.from(exported.result, 'utf8'), {
            avatarUrl: avatar, fileType: 'jsonl', characterName: charName, userName: 'Tester',
        });
        assert.equal(imported.res, true);
        assert.deepEqual(await api.delete({ avatarUrl: avatar, chatFile: imported.fileNames[0] }), { ok: true });
        assert.deepEqual(await api.delete({ avatarUrl: avatar, chatFile: renamed }), { ok: true });

        const remaining = await api.search({ avatarUrl: avatar });
        assert.equal(remaining.some(c => c.file_name.includes('lifecycle')), false);
    });
});
