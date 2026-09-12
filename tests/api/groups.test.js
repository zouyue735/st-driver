/**
 * Live integration tests for src/api/groups.js (GroupsApi).
 *
 * Verified against ST 1.18.0 handlers:
 *   src/endpoints/groups.js  (/api/groups/all|create|edit|delete)
 *   src/endpoints/chats.js   (/api/chats/group/get|save|info|delete)
 *
 * Notes on observed server behaviour:
 * - /api/groups/create drops `fav` AND `avatar_url` when they are not
 *   provided (JSON.stringify omits undefined), so those keys are only
 *   present on groups created/edited with explicit values.
 * - /api/groups/delete returns { ok: true } even when the id does not exist.
 * - /api/chats/group/get returns [] (200) when the chat file does not exist.
 * - /api/chats/group/delete returns 400 when the chat file does not exist.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GroupsApi } from '../../src/api/groups.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, fixtureName, purgeFixtures } from '../helpers.js';

let client;
let api;
/** Avatar filenames of fixture characters (group members). */
let charA;
let charB;
/** Group ids created during the run - deleted in after() as cleanup. */
const createdGroupIds = new Set();
/** Chat ids that were explicitly saved and must be deleted in after(). */
const createdChatIds = new Set();

/** Create a group and register it for cleanup. */
async function createGroup(fields = {}) {
    const group = await api.create({ name: fixtureName('grp'), ...fields });
    createdGroupIds.add(group.id);
    return group;
}

/** Re-read a single group from /api/groups/all by id. */
async function readGroup(id) {
    const all = await api.all();
    return all.find(g => g.id === id);
}

before(async () => {
    client = await newClient();
    api = new GroupsApi(client);
    // Group members are character avatar file names -> create two fixture characters.
    // POST /api/characters/create is multipart (global multer single('avatar'));
    // with no file attached the server still creates the card and answers with
    // the avatar file name as plain text.
    charA = (await client.postForm('/api/characters/create', { ch_name: fixtureName('gcharA') })).trim();
    charB = (await client.postForm('/api/characters/create', { ch_name: fixtureName('gcharB') })).trim();
});

after(async () => {
    for (const chatId of createdChatIds) {
        await api.deleteChat(chatId).catch(() => {});
    }
    for (const id of createdGroupIds) {
        await api.delete(id).catch(() => {});
    }
    await purgeFixtures(client).catch(() => {});
    await client?.close();
});

describe('GroupsApi construction', () => {
    test('stores the provided client', () => {
        const a = new GroupsApi(client);
        assert.equal(a.client, client);
    });
});

describe('all()', () => {
    test('returns an array of groups', async () => {
        const groups = await api.all();
        assert.ok(Array.isArray(groups));
    });

    test('a created group appears with all documented fields', async () => {
        // avatar_url and fav must be passed explicitly: create() drops them
        // when undefined (observed: key absent from the stored group).
        const created = await createGroup({ fav: true, avatar_url: charA });
        const found = await readGroup(created.id);
        assert.ok(found, 'group must be listed by all()');
        for (const key of [
            'id', 'name', 'members', 'avatar_url', 'allow_self_responses',
            'activation_strategy', 'generation_mode', 'disabled_members', 'fav',
            'chat_id', 'chats', 'auto_mode_delay',
            'generation_mode_join_prefix', 'generation_mode_join_suffix', 'create_date',
        ]) {
            assert.ok(key in found, `field "${key}" must be present`);
        }
        assert.equal(found.id, created.id);
        assert.equal(found.name, created.name);
        // all() adds file-stat metadata
        assert.equal(typeof found.create_date, 'string');
        assert.ok(Number.isFinite(found.date_added));
    });
});

describe('create()', () => {
    test('with no fields applies server defaults', async () => {
        const group = await api.create();
        createdGroupIds.add(group.id);
        assert.match(group.id, /^\d+$/, 'id is String(Date.now())');
        assert.equal(group.name, 'New Group');
        assert.deepEqual(group.members, []);
        assert.equal(group.allow_self_responses, false);
        assert.equal(group.activation_strategy, 0);
        assert.equal(group.generation_mode, 0);
        assert.deepEqual(group.disabled_members, []);
        assert.equal(group.auto_mode_delay, 5);
        assert.equal(group.generation_mode_join_prefix, '');
        assert.equal(group.generation_mode_join_suffix, '');
        assert.equal(group.chat_id, group.id, 'chat_id defaults to the group id');
        assert.deepEqual(group.chats, [group.id], 'chats defaults to [id]');
    });

    test('returns the complete group object including generated id', async () => {
        const name = fixtureName('grp');
        const group = await api.create({ name });
        createdGroupIds.add(group.id);
        assert.equal(group.id, String(Number(group.id)));
        assert.equal(group.name, name);
        const found = await readGroup(group.id);
        assert.equal(found?.name, name);
    });

    test('honours the name parameter', async () => {
        const name = fixtureName('grpname');
        const group = await createGroup({ name });
        assert.equal(group.name, name);
    });

    test('honours the members parameter', async () => {
        const group = await createGroup({ members: [charA, charB] });
        assert.deepEqual(group.members, [charA, charB]);
    });

    test('honours the avatar_url parameter', async () => {
        const group = await createGroup({ avatar_url: charA });
        assert.equal(group.avatar_url, charA);
    });

    test('honours the allow_self_responses parameter', async () => {
        const group = await createGroup({ allow_self_responses: true });
        assert.equal(group.allow_self_responses, true);
    });

    test('honours the activation_strategy parameter (1 = LIST)', async () => {
        const group = await createGroup({ activation_strategy: 1 });
        assert.equal(group.activation_strategy, 1);
    });

    test('honours the activation_strategy parameter (3 = POOLED)', async () => {
        const group = await createGroup({ activation_strategy: 3 });
        assert.equal(group.activation_strategy, 3);
    });

    test('honours the generation_mode parameter (2 = APPEND_DISABLED)', async () => {
        const group = await createGroup({ generation_mode: 2 });
        assert.equal(group.generation_mode, 2);
    });

    test('honours the disabled_members parameter', async () => {
        const group = await createGroup({ members: [charA, charB], disabled_members: [charB] });
        assert.deepEqual(group.disabled_members, [charB]);
    });

    test('honours the fav parameter', async () => {
        const group = await createGroup({ fav: true });
        assert.equal(group.fav, true);
    });

    test('honours the chat_id parameter', async () => {
        const chatId = `${Date.now()}_custom_chat`;
        const group = await createGroup({ chat_id: chatId });
        assert.equal(group.chat_id, chatId);
    });

    test('honours the chats parameter', async () => {
        const chats = [`${Date.now()}_c1`, `${Date.now()}_c2`];
        const group = await createGroup({ chats });
        assert.deepEqual(group.chats, chats);
    });

    test('honours the auto_mode_delay parameter', async () => {
        const group = await createGroup({ auto_mode_delay: 17 });
        assert.equal(group.auto_mode_delay, 17);
    });

    test('honours the generation_mode_join_prefix parameter', async () => {
        const group = await createGroup({ generation_mode_join_prefix: '<P>' });
        assert.equal(group.generation_mode_join_prefix, '<P>');
    });

    test('honours the generation_mode_join_suffix parameter', async () => {
        const group = await createGroup({ generation_mode_join_suffix: '</P>' });
        assert.equal(group.generation_mode_join_suffix, '</P>');
    });
});

describe('edit()', () => {
    test('returns { ok: true }', async () => {
        const group = await createGroup();
        const res = await api.edit({ ...group, name: `${group.name}_edited` });
        assert.deepEqual(res, { ok: true });
    });

    test('updates the name parameter (verified via all())', async () => {
        const group = await createGroup();
        const newName = fixtureName('grpEdited');
        await api.edit({ ...group, name: newName });
        assert.equal((await readGroup(group.id)).name, newName);
    });

    test('updates the members parameter', async () => {
        const group = await createGroup({ members: [] });
        await api.edit({ ...group, members: [charA, charB] });
        assert.deepEqual((await readGroup(group.id)).members, [charA, charB]);
    });

    test('updates the disabled_members parameter', async () => {
        const group = await createGroup({ members: [charA, charB] });
        await api.edit({ ...group, disabled_members: [charA] });
        assert.deepEqual((await readGroup(group.id)).disabled_members, [charA]);
    });

    test('updates the activation_strategy parameter', async () => {
        const group = await createGroup({ activation_strategy: 0 });
        await api.edit({ ...group, activation_strategy: 2 });
        assert.equal((await readGroup(group.id)).activation_strategy, 2);
    });

    test('updates the generation_mode parameter', async () => {
        const group = await createGroup({ generation_mode: 0 });
        await api.edit({ ...group, generation_mode: 1 });
        assert.equal((await readGroup(group.id)).generation_mode, 1);
    });

    test('updates the allow_self_responses parameter', async () => {
        const group = await createGroup({ allow_self_responses: false });
        await api.edit({ ...group, allow_self_responses: true });
        assert.equal((await readGroup(group.id)).allow_self_responses, true);
    });

    test('updates the auto_mode_delay parameter', async () => {
        const group = await createGroup({ auto_mode_delay: 5 });
        await api.edit({ ...group, auto_mode_delay: 42 });
        assert.equal((await readGroup(group.id)).auto_mode_delay, 42);
    });

    test('updates the generation_mode_join_prefix parameter', async () => {
        const group = await createGroup();
        await api.edit({ ...group, generation_mode_join_prefix: '{' });
        assert.equal((await readGroup(group.id)).generation_mode_join_prefix, '{');
    });

    test('updates the generation_mode_join_suffix parameter', async () => {
        const group = await createGroup();
        await api.edit({ ...group, generation_mode_join_suffix: '}' });
        assert.equal((await readGroup(group.id)).generation_mode_join_suffix, '}');
    });

    test('updates the fav parameter', async () => {
        const group = await createGroup({ fav: false });
        await api.edit({ ...group, fav: true });
        assert.equal((await readGroup(group.id)).fav, true);
    });

    test('overwrites the whole object: omitted fields are lost', async () => {
        const group = await createGroup({ auto_mode_delay: 9 });
        // Body without auto_mode_delay -> the file is replaced wholesale.
        await api.edit({ id: group.id, name: group.name });
        const found = await readGroup(group.id);
        assert.equal(found.auto_mode_delay, undefined);
        assert.equal(found.name, group.name);
    });

    test('without id throws StApiError 400', async () => {
        await assert.rejects(
            () => api.edit({ name: 'no-id' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('delete()', () => {
    test('returns { ok: true } and removes the group from all()', async () => {
        const group = await createGroup();
        const res = await api.delete(group.id);
        assert.deepEqual(res, { ok: true });
        createdGroupIds.delete(group.id);
        assert.equal(await readGroup(group.id), undefined);
    });

    test('cascades: group chat files listed in chats are deleted too', async () => {
        const group = await createGroup();
        const header = { chat_metadata: {}, user_name: 'unused', character_name: 'unused' };
        const message = { name: 'User', is_user: true, is_system: false, send_date: '2026-01-01T00:00:00.000Z', mes: 'cascade me', extra: {} };
        await api.saveChat(group.chat_id, [header, message]);
        // sanity: the chat file exists now
        assert.equal((await api.getChat(group.chat_id)).length, 2);
        await api.delete(group.id);
        createdGroupIds.delete(group.id);
        // chat file was cascade-deleted -> getChat returns []
        assert.deepEqual(await api.getChat(group.chat_id), []);
    });

    test('of a non-existent id still returns { ok: true } (observed server behaviour)', async () => {
        const res = await api.delete('9999999999999_does_not_exist');
        assert.deepEqual(res, { ok: true });
    });

    test('without id throws StApiError 400', async () => {
        await assert.rejects(
            () => api.delete(undefined),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('group chat records (/api/chats/group/*)', () => {
    /** Build a valid chat payload: header line + message lines. */
    function chatPayload(messages) {
        const header = { chat_metadata: {}, user_name: 'unused', character_name: 'unused' };
        return [header, ...messages];
    }

    function message(name, mes, isUser = false) {
        return {
            name,
            is_user: isUser,
            is_system: false,
            send_date: new Date().toISOString(),
            mes,
            extra: {},
        };
    }

    test('getChat of a fresh group (no file yet) returns []', async () => {
        const group = await createGroup();
        assert.deepEqual(await api.getChat(group.chat_id), []);
    });

    test('saveChat returns { ok: true }', async () => {
        const group = await createGroup();
        createdChatIds.add(group.chat_id);
        const res = await api.saveChat(group.chat_id, chatPayload([message('User', 'hello', true)]));
        assert.deepEqual(res, { ok: true });
    });

    test('saveChat + getChat round-trips header and messages', async () => {
        const group = await createGroup();
        createdChatIds.add(group.chat_id);
        const msgs = [
            message('User', 'first user line', true),
            message('Alice', 'first char line'),
            message('Bob', 'second char line'),
        ];
        await api.saveChat(group.chat_id, chatPayload(msgs));
        const chat = await api.getChat(group.chat_id);
        assert.equal(chat.length, 4);
        // header
        assert.deepEqual(chat[0], { chat_metadata: {}, user_name: 'unused', character_name: 'unused' });
        // messages, field by field
        for (let i = 0; i < msgs.length; i++) {
            assert.equal(chat[i + 1].name, msgs[i].name);
            assert.equal(chat[i + 1].is_user, msgs[i].is_user);
            assert.equal(chat[i + 1].is_system, msgs[i].is_system);
            assert.equal(chat[i + 1].send_date, msgs[i].send_date);
            assert.equal(chat[i + 1].mes, msgs[i].mes);
            assert.deepEqual(chat[i + 1].extra, msgs[i].extra);
        }
    });

    test('saveChat overwrites the whole file (chat is replaced, not appended)', async () => {
        const group = await createGroup();
        createdChatIds.add(group.chat_id);
        await api.saveChat(group.chat_id, chatPayload([message('User', 'one', true), message('Alice', 'two')]));
        await api.saveChat(group.chat_id, chatPayload([message('User', 'only', true)]));
        const chat = await api.getChat(group.chat_id);
        assert.equal(chat.length, 2);
        assert.equal(chat[1].mes, 'only');
    });

    test('saveChat honours the force parameter (skips integrity check)', async () => {
        const group = await createGroup();
        createdChatIds.add(group.chat_id);
        const res = await api.saveChat(group.chat_id, chatPayload([message('User', 'forced', true)]), true);
        assert.deepEqual(res, { ok: true });
        assert.equal((await api.getChat(group.chat_id))[1].mes, 'forced');
    });

    test('saveChat with a non-array chat throws StApiError 400', async () => {
        const group = await createGroup();
        await assert.rejects(
            () => api.saveChat(group.chat_id, { not: 'an array' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('getChat without id throws StApiError 400', async () => {
        await assert.rejects(
            () => api.getChat(undefined),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('chatInfo returns metadata about the saved chat', async () => {
        const group = await createGroup();
        createdChatIds.add(group.chat_id);
        const sendDate = '2026-02-03T04:05:06.000Z';
        const msgs = [message('User', 'info one', true), { ...message('Alice', 'info two'), send_date: sendDate }];
        await api.saveChat(group.chat_id, chatPayload(msgs));
        const info = await api.chatInfo(group.chat_id);
        assert.equal(info.file_id, group.chat_id);
        assert.equal(info.file_name, `${group.chat_id}.jsonl`);
        assert.equal(info.chat_items, 2, 'chat_items counts messages excluding the header');
        assert.equal(info.mes, 'info two', 'mes is the last message text');
        assert.equal(info.last_mes, sendDate, 'last_mes falls back to the send_date of the last message');
        assert.equal(info.match, true);
        assert.equal(typeof info.file_size, 'string');
    });

    test('chatInfo without id throws StApiError 400', async () => {
        await assert.rejects(
            () => api.chatInfo(undefined),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('deleteChat removes the chat file and returns { ok: true }', async () => {
        const group = await createGroup();
        await api.saveChat(group.chat_id, chatPayload([message('User', 'bye', true)]));
        const res = await api.deleteChat(group.chat_id);
        assert.deepEqual(res, { ok: true });
        assert.deepEqual(await api.getChat(group.chat_id), []);
    });

    test('deleteChat of a non-existent chat throws StApiError 400', async () => {
        await assert.rejects(
            () => api.deleteChat('9999999999999_no_such_chat'),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('deleteChat without id throws StApiError 400', async () => {
        await assert.rejects(
            () => api.deleteChat(undefined),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});
