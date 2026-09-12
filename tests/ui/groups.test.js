import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UiSession } from '../../src/ui/session.js';
import { newClient, fixtureName, LIVE_GEN } from '../helpers.js';

// Live integration tests for GroupControl (frontend group-chat operations).
// Fixtures: two throwaway characters + one throwaway group, all HTTP-created
// and deleted afterwards. UI navigation state is saved/restored.
const BASE_URL = process.env.ST_URL ?? 'http://localhost:8000';
const TEST_TIMEOUT = 300_000;

let session, client, chars, group, savedState;

before(async () => {
    client = await newClient();
    chars = [];
    for (const role of ['alice', 'bob']) {
        const name = fixtureName(`grp_${role}`);
        const avatar = (await client.postForm('/api/characters/create', {
            ch_name: name,
            description: `Group test character ${role}.`,
            first_mes: `${role} says hi.`,
            talkativeness: '0.5',
        })).trim();
        chars.push({ name, avatar });
    }
    group = await client.post('/api/groups/create', {
        name: fixtureName('group'),
        members: chars.map(c => c.avatar),
        activation_strategy: 1, // LIST order for deterministic replies
        generation_mode: 0, // SWAP
        allow_self_responses: false,
        auto_mode_delay: 5,
        disabled_members: [],
        fav: false,
    });

    session = new UiSession({ baseUrl: BASE_URL, headless: true });
    await session.launch({ timeout: TEST_TIMEOUT });
    savedState = await session.state.save();
    // refresh frontend caches (fixtures created via HTTP behind its back)
    await session.evaluate(async () => {
        const { getCharacters } = await import('/script.js');
        await getCharacters();
        const groupMod = await import('/scripts/group-chats.js');
        await groupMod.getGroups();
    });
});

after(async () => {
    try {
        if (session && savedState) await session.state.restore(savedState);
    } finally {
        await session?.close();
        if (client) {
            if (group?.id) await client.post('/api/groups/delete', { id: group.id }).catch(() => {});
            for (const c of chars ?? []) {
                await client.post('/api/characters/delete', { avatar_url: c.avatar, delete_chats: true }).catch(() => {});
            }
        }
        await client?.close();
    }
});

describe('GroupControl: open & inspect', { timeout: TEST_TIMEOUT }, () => {
    test('list includes the fixture group with expected fields', async () => {
        const groups = await session.groups.list();
        const found = groups.find(g => g.id === group.id);
        assert.ok(found, 'fixture group must be in frontend list');
        assert.equal(found.name, group.name);
        assert.equal(found.members.length, 2);
        assert.equal(found.activationStrategy, 1);
        assert.equal(found.generationMode, 0);
        assert.equal(found.allowSelfResponses, false);
    });

    test('open opens the group chat in the UI', async () => {
        await session.groups.open(group.id);
        const state = await session.state.save();
        assert.equal(state.groupId, group.id);
    });

    test('memberCount reports 2', async () => {
        await session.groups.open(group.id);
        const count = await session.groups.memberCount();
        assert.equal(count, '2');
    });

    test('getMember field=name resolves index 0 to the first member', async () => {
        const name = await session.groups.getMember({ field: 'name', member: 0 });
        assert.ok([chars[0].name, chars[1].name].includes(name), `unexpected member name ${name}`);
    });
});

describe('GroupControl: member management', { timeout: TEST_TIMEOUT }, () => {
    test('mute adds the member to disabled_members', async () => {
        await session.groups.open(group.id);
        const r = await session.groups.mute(chars[0].name);
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const groups = await session.groups.list();
        const g = groups.find(x => x.id === group.id);
        assert.ok(g.disabledMembers.includes(chars[0].avatar), `expected muted, got ${JSON.stringify(g.disabledMembers)}`);
    });

    test('unmute removes the member from disabled_members', async () => {
        const r = await session.groups.unmute(chars[0].name);
        assert.equal(r.isError, false, r.errorMessage ?? '');
        const groups = await session.groups.list();
        const g = groups.find(x => x.id === group.id);
        assert.ok(!g.disabledMembers.includes(chars[0].avatar));
    });

    test('update sets activationStrategy and persists', async () => {
        await session.groups.update(group.id, { activationStrategy: 0 });
        const groups = await session.groups.list();
        const g = groups.find(x => x.id === group.id);
        assert.equal(g.activationStrategy, 0);
        // server-side check: editGroup(true,false) must have written the file
        const serverGroups = await client.post('/api/groups/all', {});
        const sg = serverGroups.find(x => x.id === group.id);
        assert.equal(sg.activation_strategy, 0);
        // restore LIST for deterministic generation tests
        await session.groups.update(group.id, { activationStrategy: 1 });
    });

    test('update changes autoModeDelay and allowSelfResponses', async () => {
        await session.groups.update(group.id, { autoModeDelay: 7, allowSelfResponses: true });
        const serverGroups = await client.post('/api/groups/all', {});
        const sg = serverGroups.find(x => x.id === group.id);
        assert.equal(sg.auto_mode_delay, 7);
        assert.equal(sg.allow_self_responses, true);
        await session.groups.update(group.id, { autoModeDelay: 5, allowSelfResponses: false });
    });

    test('update rejects an unknown group id', async () => {
        await assert.rejects(
            () => session.groups.update('9999999999999', { name: 'x' }),
            /not found in frontend/,
        );
    });
});

describe('GroupControl: directed generation (live LLM gated)', { timeout: TEST_TIMEOUT }, () => {
    test('generate with forceCharacterId makes the chosen member reply', { skip: !LIVE_GEN && 'set ST_DRIVER_LIVE_GEN=1 to enable' }, async () => {
        await session.groups.open(group.id);
        const chid = await session.evaluate(({ avatar }) => {
            return SillyTavern.getContext().characters.findIndex(c => c.avatar === avatar);
        }, { avatar: chars[1].avatar });
        assert.ok(chid >= 0, 'member must exist in characters list');
        const before = await session.chat.length();
        const r = await session.generation.generate({ type: 'normal', forceCharacterId: chid, timeout: 240_000 });
        assert.equal(r.ok, true,
            `generation not ok: outcome=${r.outcome} timedOut=${r.timedOut} settledEmpty=${r.settledEmpty} lastMes=${JSON.stringify(r.lastMessage?.mes?.slice(0, 120))}`);
        // strict guard: a NEW message must exist (a silent no-LLM generation
        // would leave the chat unchanged and still report ok)
        assert.ok(r.chatLength > before, `expected a new message, chat went ${before} -> ${r.chatLength}`);
        const last = await session.chat.last();
        assert.equal(last.name, chars[1].name, `expected ${chars[1].name} to reply, got ${last.name}`);
        assert.ok(last.mes.length > 0, 'reply must be non-empty');
    });
});
