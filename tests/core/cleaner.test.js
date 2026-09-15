/**
 * Tests for Cleaner (src/core/cleaner.js) - bulk deletion of characters,
 * groups, world info and chat logs.
 *
 * Two layers, because this module is destructive:
 *
 *   1. Fake-API tests (`new Cleaner({client, apis})`) exercise planning, protect
 *      semantics, the requirePrefix guardrail, deletion order and failure
 *      recording WITHOUT any live write. The fake "user" characters stand in for
 *      real content, so a guardrail bug shows up as an assertion failure instead
 *      of data loss.
 *   2. Live tests create real `__drvtest_` fixtures and delete them, always with
 *      BOTH `protect` (keeping every non-fixture) and `requirePrefix` (aborting
 *      if anything non-fixture ever reached the delete list).
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { STClient, Cleaner, DEFAULT_SCOPE } from '../../src/index.js';
import { CharactersApi } from '../../src/api/characters.js';
import { ChatsApi } from '../../src/api/chats.js';
import { GroupsApi } from '../../src/api/groups.js';
import { WorldInfoApi } from '../../src/api/worldinfo.js';
import { BASE_URL, FIXTURE_PREFIX, fixtureName, newClient, purgeFixtures } from '../helpers.js';

// ---------------------------------------------------------------------------
// Fake API layer
// ---------------------------------------------------------------------------

/**
 * Build in-memory fakes that record every mutating call.
 * @param {object} seed {characters, groups, worlds, chats}
 */
function fakeApis(seed = {}) {
    const calls = [];
    const state = {
        characters: (seed.characters ?? []).map(c => ({ ...c })),
        groups: (seed.groups ?? []).map(g => ({ ...g })),
        worlds: (seed.worlds ?? []).map(w => ({ ...w })),
        chats: new Map(Object.entries(seed.chats ?? {})), // avatar -> [{file_name}]
    };
    /** When set, the matching delete call throws (failure-path tests). */
    const failOn = seed.failOn ?? {};

    return {
        calls,
        state,
        characters: {
            async all() { calls.push(['characters.all']); return state.characters; },
            async chats(avatar) {
                calls.push(['characters.chats', avatar]);
                return state.chats.get(avatar) ?? [];
            },
            async delete(avatar, opts = {}) {
                calls.push(['characters.delete', avatar, opts]);
                if (failOn.character === avatar) throw new Error(`boom ${avatar}`);
                state.characters = state.characters.filter(c => c.avatar !== avatar);
                if (opts.deleteChats) state.chats.delete(avatar);
                return 'OK';
            },
        },
        groups: {
            async all() { calls.push(['groups.all']); return state.groups; },
            async delete(id) {
                calls.push(['groups.delete', id]);
                if (failOn.group === id) throw new Error(`boom ${id}`);
                state.groups = state.groups.filter(g => String(g.id) !== String(id));
                return { ok: true };
            },
        },
        worldinfo: {
            async list() { calls.push(['worldinfo.list']); return state.worlds; },
            async delete(name) {
                calls.push(['worldinfo.delete', name]);
                if (failOn.worldinfo === name) throw new Error(`boom ${name}`);
                state.worlds = state.worlds.filter(w => w.name !== name);
                return null;
            },
        },
        chats: {
            async delete({ avatarUrl, chatFile }) {
                calls.push(['chats.delete', avatarUrl, chatFile]);
                if (failOn.chat === chatFile) throw new Error(`boom ${chatFile}`);
                const list = state.chats.get(avatarUrl) ?? [];
                state.chats.set(avatarUrl, list.filter(c => c.file_name !== chatFile));
                return 'OK';
            },
        },
    };
}

/** A dummy client: only /api/settings/* is used, via the real settings paths. */
function fakeClientForSettings(initial) {
    let settings = { ...initial };
    return {
        saved: null,
        async post(path, body) {
            if (path === '/api/settings/get') return { settings: JSON.stringify(settings) };
            if (path === '/api/settings/save') { settings = { ...body }; this.saved = settings; return 'OK'; }
            throw new Error(`unexpected POST ${path}`);
        },
    };
}

// ---------------------------------------------------------------------------
// Layer 1: fake-API tests (no live writes)
// ---------------------------------------------------------------------------

describe('Cleaner.isProtected', () => {
    test('matches an exact name', () => {
        assert.equal(Cleaner.isProtected('Foo', ['Foo']), 'Foo');
    });
    test('matches a prefix', () => {
        assert.equal(Cleaner.isProtected('Foo Bar', ['Foo']), 'Foo');
    });
    test('returns null when nothing matches', () => {
        assert.equal(Cleaner.isProtected('Foo', ['Bar', 'Baz']), null);
    });
    test('returns null for an empty or missing protect list', () => {
        assert.equal(Cleaner.isProtected('Foo', []), null);
        assert.equal(Cleaner.isProtected('Foo'), null);
    });
    test('a non-array protect list is treated as "protect nothing"', () => {
        assert.equal(Cleaner.isProtected('Foo', 'Foo'), null);
        assert.equal(Cleaner.isProtected('Foo', null), null);
    });
    test('empty-string rules never match (would otherwise match everything)', () => {
        assert.equal(Cleaner.isProtected('Foo', ['']), null);
        assert.equal(Cleaner.isProtected('Foo', ['', 'F']), 'F');
    });
    test('a null/undefined name does not throw', () => {
        assert.equal(Cleaner.isProtected(null, ['F']), null);
        assert.equal(Cleaner.isProtected(undefined, ['F']), null);
    });
    test('returns the FIRST matching rule', () => {
        assert.equal(Cleaner.isProtected('abcdef', ['abc', 'ab']), 'abc');
    });
});

describe('Cleaner constructor', () => {
    test('requires a client', () => {
        assert.throws(() => new Cleaner({}), TypeError);
        assert.throws(() => new Cleaner(), TypeError);
    });
    test('accepts injected api objects', () => {
        const fake = fakeApis();
        const c = new Cleaner({ client: {}, apis: fake });
        assert.equal(c.characters, fake.characters);
        assert.equal(c.groups, fake.groups);
        assert.equal(c.worldinfo, fake.worldinfo);
        assert.equal(c.chats, fake.chats);
    });
});

describe('Cleaner.DEFAULT_SCOPE', () => {
    test('all content scopes default on, settings off', () => {
        assert.deepEqual(DEFAULT_SCOPE, {
            characters: true, groups: true, worldinfo: true, chats: true, settings: false,
        });
    });
    test('is frozen', () => {
        assert.equal(Object.isFrozen(DEFAULT_SCOPE), true);
    });
});

describe('Cleaner.plan (fake apis)', () => {
    const seed = () => ({
        characters: [
            { avatar: 'UserCard.png', name: 'UserCard' },
            { avatar: `${FIXTURE_PREFIX}A.png`, name: `${FIXTURE_PREFIX}A` },
        ],
        groups: [
            { id: 'g-user', name: 'UserGroup', members: ['UserCard.png'], chats: ['c1'] },
            { id: 'g-fix', name: `${FIXTURE_PREFIX}group`, members: [], chats: ['c2', 'c3'] },
        ],
        worlds: [{ name: 'UserWorld' }, { name: `${FIXTURE_PREFIX}world` }],
        chats: {
            'UserCard.png': [{ file_name: 'UserCard - 2026-01-01.jsonl', chat_items: 4 }],
            [`${FIXTURE_PREFIX}A.png`]: [
                { file_name: `${FIXTURE_PREFIX}A - 1.jsonl`, chat_items: 2 },
                { file_name: `${FIXTURE_PREFIX}A - 2.jsonl`, chat_items: 3 },
            ],
        },
    });

    test('never issues a mutating call', async () => {
        const fake = fakeApis(seed());
        await new Cleaner({ client: {}, apis: fake }).plan();
        const mutating = fake.calls.filter(c => /\.delete$/.test(c[0]) || /\.save/.test(c[0]));
        assert.deepEqual(mutating, [], 'plan() must be read-only');
    });

    test('counts every kind and reports dryRun/confirmed', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).plan({ protect: ['User'] });
        assert.equal(r.dryRun, true);
        assert.equal(r.confirmed, false);
        assert.deepEqual(r.planned, { characters: 1, groups: 1, worldinfo: 1, chats: 2 });
        assert.deepEqual(r.deleted, { characters: 0, groups: 0, worldinfo: 0, chats: 0, settings: 0 });
    });

    test('protected entries are listed in protected_ and excluded from planned', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).plan({ protect: ['User'] });
        assert.ok(r.protected_.some(s => s.startsWith('character:UserCard')));
        assert.ok(r.protected_.some(s => s.startsWith('group:UserGroup')));
        assert.ok(r.protected_.some(s => s.startsWith('worldinfo:UserWorld')));
        assert.ok(!r.items.some(i => String(i.name).includes('User')));
    });

    test('scope.characters=false keeps cards but still counts their chats', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).plan({ scope: { characters: false } });
        assert.equal(r.planned.characters, 0);
        assert.equal(r.planned.chats, 3, 'UserCard(1) + fixtureA(2) logs all in scope');
        assert.ok(r.items.filter(i => i.kind === 'chat').every(i => i.via === 'direct'));
    });

    test('scope.chats=false omits chat enumeration entirely', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).plan({ scope: { chats: false } });
        assert.equal(r.planned.chats, 0);
        assert.ok(!r.items.some(i => i.kind === 'chat'));
        assert.ok(!fake.calls.some(c => c[0] === 'characters.chats'), 'must not enumerate chats');
    });

    test('chats of a card being deleted are via:card, not via:direct', async () => {
        const fake = fakeApis(seed());
        // Protecting UserCard protects its LOGS too, so the only chats in scope
        // are the fixture card's, and they arrive with its card (via:card).
        const r = await new Cleaner({ client: {}, apis: fake }).plan({ protect: ['UserCard'] });
        const fixtureChats = r.items.filter(i => i.kind === 'chat' && i.name.startsWith(`${FIXTURE_PREFIX}A`));
        assert.equal(fixtureChats.length, 2);
        assert.ok(fixtureChats.every(i => i.via === 'card'));
        assert.equal(r.items.filter(i => i.kind === 'chat' && i.name.startsWith('UserCard')).length, 0,
            'a protected card must not have its logs queued for deletion');
    });

    test('a card kept only by scope (not protect) gets via:direct', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).plan({ scope: { characters: false } });
        const userChats = r.items.filter(i => i.kind === 'chat' && i.name.startsWith('UserCard'));
        assert.equal(userChats.length, 1);
        assert.equal(userChats[0].via, 'direct');
    });

    test('protecting a character also protects its chat logs', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).plan({
            protect: ['UserCard', `${FIXTURE_PREFIX}A`],
        });
        assert.equal(r.planned.chats, 0, 'both cards protected -> no logs in scope');
        assert.equal(r.planned.characters, 0);
    });

    test('scope.groups=false skips group enumeration', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).plan({ scope: { groups: false } });
        assert.equal(r.planned.groups, 0);
        assert.ok(!fake.calls.some(c => c[0] === 'groups.all'));
    });

    test('scope.worldinfo=false skips world enumeration', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).plan({ scope: { worldinfo: false } });
        assert.equal(r.planned.worldinfo, 0);
        assert.ok(!fake.calls.some(c => c[0] === 'worldinfo.list'));
    });

    test('scope.settings=true adds an explanatory note', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).plan({ scope: { settings: true } });
        assert.ok(r.notes.some(n => n.includes('scope.settings is ON')));
    });

    test('protect matches a character by avatar filename too', async () => {
        const fake = fakeApis({ characters: [{ avatar: 'abc.png', name: 'Different Name' }] });
        const r = await new Cleaner({ client: {}, apis: fake }).plan({ protect: ['abc'] });
        assert.equal(r.planned.characters, 0);
        assert.ok(r.protected_.some(s => s.includes('Different Name')));
    });

    test('protect matches a group by id too', async () => {
        const fake = fakeApis({ groups: [{ id: 'grp-123', name: 'Named differently', members: [], chats: [] }] });
        const r = await new Cleaner({ client: {}, apis: fake }).plan({ protect: ['grp-123'] });
        assert.equal(r.planned.groups, 0);
    });

    test('a characters.all() failure is reported, not thrown', async () => {
        const fake = fakeApis(seed());
        fake.characters.all = async () => { throw new Error('network down'); };
        const r = await new Cleaner({ client: {}, apis: fake }).plan();
        assert.equal(r.planned.characters, 0);
        assert.ok(r.notes.some(n => n.includes('characters.all() failed')));
        assert.ok(r.notes.some(n => n.includes('network down')));
    });

    test('a groups.all() failure is reported, not thrown', async () => {
        const fake = fakeApis(seed());
        fake.groups.all = async () => { throw new Error('boom'); };
        const r = await new Cleaner({ client: {}, apis: fake }).plan();
        assert.ok(r.notes.some(n => n.includes('groups.all() failed')));
    });

    test('a worldinfo.list() failure is reported, not thrown', async () => {
        const fake = fakeApis(seed());
        fake.worldinfo.list = async () => { throw new Error('boom'); };
        const r = await new Cleaner({ client: {}, apis: fake }).plan();
        assert.ok(r.notes.some(n => n.includes('worldinfo.list() failed')));
    });

    test('a thrown chats() failure is always reported (no message filtering)', async () => {
        // Real ST never THROWS for "no chat dir" - it answers [] or {error:true}
        // at HTTP 200 (see the live probe). So any throw is a genuine failure and
        // must surface, including ones whose message merely contains "error".
        const fake = fakeApis(seed());
        fake.characters.chats = async () => { throw new Error('500 server error'); };
        const r = await new Cleaner({ client: {}, apis: fake }).plan({ protect: ['User'] });
        assert.ok(r.notes.some(n => n.includes('500 server error')));
    });

    test('a {error:true} chats() payload means "no chat dir" and is silent', async () => {
        const fake = fakeApis(seed());
        fake.characters.chats = async () => ({ error: true });
        const r = await new Cleaner({ client: {}, apis: fake }).plan({ protect: ['User'] });
        assert.equal(r.planned.chats, 0);
        assert.deepEqual(r.notes, [], 'a 200 {error:true} is not a failure');
    });

    test('an empty chats() array is silent', async () => {
        const fake = fakeApis(seed());
        fake.characters.chats = async () => [];
        const r = await new Cleaner({ client: {}, apis: fake }).plan();
        assert.deepEqual(r.notes, []);
    });

    test('chat entries without a file name are skipped', async () => {
        const fake = fakeApis({
            characters: [{ avatar: `${FIXTURE_PREFIX}A.png`, name: `${FIXTURE_PREFIX}A` }],
            chats: { [`${FIXTURE_PREFIX}A.png`]: [{ chat_items: 1 }, { file_name: 'ok.jsonl', chat_items: 2 }] },
        });
        const r = await new Cleaner({ client: {}, apis: fake }).plan();
        assert.equal(r.planned.chats, 1);
    });

    test('camelCase fileName is accepted too', async () => {
        const fake = fakeApis({
            characters: [{ avatar: `${FIXTURE_PREFIX}A.png`, name: `${FIXTURE_PREFIX}A` }],
            chats: { [`${FIXTURE_PREFIX}A.png`]: [{ fileName: 'x.jsonl', chat_items: 1 }] },
        });
        const r = await new Cleaner({ client: {}, apis: fake }).plan();
        assert.equal(r.planned.chats, 1);
    });

    test('an empty instance plans nothing and reports all zeros', async () => {
        const fake = fakeApis({});
        const r = await new Cleaner({ client: {}, apis: fake }).plan();
        assert.deepEqual(r.planned, { characters: 0, groups: 0, worldinfo: 0, chats: 0 });
        assert.deepEqual(r.items, []);
        assert.deepEqual(r.protected_, []);
    });

    test('characters without an avatar are skipped', async () => {
        const fake = fakeApis({ characters: [{ avatar: '', name: 'ghost' }, { name: 'no-avatar' }] });
        const r = await new Cleaner({ client: {}, apis: fake }).plan();
        assert.equal(r.planned.characters, 0);
    });

    test('a character with no name falls back to its avatar', async () => {
        const fake = fakeApis({ characters: [{ avatar: `${FIXTURE_PREFIX}A.png` }] });
        const r = await new Cleaner({ client: {}, apis: fake }).plan();
        assert.equal(r.items[0].name, `${FIXTURE_PREFIX}A.png`);
    });

    test('world entries fall back to file_id when name is absent', async () => {
        const fake = fakeApis({ worlds: [{ file_id: 'w-raw', name: '' }] });
        const r = await new Cleaner({ client: {}, apis: fake }).plan();
        assert.equal(r.planned.worldinfo, 1);
        assert.equal(r.items[0].name, 'w-raw');
    });

    test('group detail reports member and chat counts', async () => {
        const fake = fakeApis({
            groups: [{ id: 'g1', name: `${FIXTURE_PREFIX}g`, members: ['a', 'b', 'c'], chats: ['x', 'y'] }],
        });
        const r = await new Cleaner({ client: {}, apis: fake }).plan();
        assert.equal(r.items[0].detail, '3 members, 2 chats (cascade)');
    });
});

describe('Cleaner.clean without confirm (fake apis)', () => {
    const seed = () => ({
        characters: [{ avatar: `${FIXTURE_PREFIX}A.png`, name: `${FIXTURE_PREFIX}A` }],
        groups: [{ id: 'g1', name: `${FIXTURE_PREFIX}g`, members: [], chats: [] }],
        worlds: [{ name: `${FIXTURE_PREFIX}w` }],
    });

    test('confirm omitted -> nothing deleted, dryRun report returned', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).clean();
        assert.equal(r.dryRun, true);
        assert.equal(r.confirmed, false);
        assert.deepEqual(r.deleted, { characters: 0, groups: 0, worldinfo: 0, chats: 0, settings: 0 });
        assert.ok(r.notes[0].includes('NOTHING WAS DELETED'));
        assert.ok(!fake.calls.some(c => /\.delete$/.test(c[0])));
    });

    test('confirm:false behaves the same', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).clean({ confirm: false });
        assert.equal(r.dryRun, true);
        assert.ok(!fake.calls.some(c => /\.delete$/.test(c[0])));
    });

    test('a truthy-but-not-true confirm still refuses', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).clean({ confirm: 'yes' });
        assert.equal(r.dryRun, true);
        assert.ok(!fake.calls.some(c => /\.delete$/.test(c[0])));
    });

    test('dry-run planned equals what a confirmed run would plan', async () => {
        const fake = fakeApis(seed());
        const c = new Cleaner({ client: {}, apis: fake });
        const dry = await c.clean({ confirm: false });
        assert.deepEqual(dry.planned, { characters: 1, groups: 1, worldinfo: 1, chats: 0 });
    });
});

describe('Cleaner.clean requirePrefix guardrail (fake apis)', () => {
    const seed = () => ({
        characters: [
            { avatar: 'UserCard.png', name: 'UserCard' },
            { avatar: `${FIXTURE_PREFIX}A.png`, name: `${FIXTURE_PREFIX}A` },
        ],
        groups: [{ id: 'g-user', name: 'UserGroup', members: [], chats: [] }],
        worlds: [{ name: 'UserWorld' }],
    });

    test('throws when a non-matching target is in the plan', async () => {
        const fake = fakeApis(seed());
        const c = new Cleaner({ client: {}, apis: fake });
        await assert.rejects(
            () => c.clean({ confirm: true, requirePrefix: FIXTURE_PREFIX }),
            err => {
                assert.equal(err.code, 'E_CLEAN_PREFIX_VIOLATION');
                assert.ok(err.message.includes(FIXTURE_PREFIX));
                assert.ok(err.offenders.length >= 3);
                return true;
            },
        );
    });

    test('the throw happens BEFORE any deletion (fail-closed)', async () => {
        const fake = fakeApis(seed());
        const c = new Cleaner({ client: {}, apis: fake });
        await assert.rejects(() => c.clean({ confirm: true, requirePrefix: FIXTURE_PREFIX }));
        assert.deepEqual(fake.calls.filter(x => /\.delete$/.test(x[0])), []);
        assert.equal(fake.state.characters.length, 2, 'user card must still exist');
        assert.equal(fake.state.groups.length, 1);
        assert.equal(fake.state.worlds.length, 1);
    });

    test('passes when every target matches', async () => {
        const fake = fakeApis({
            characters: [{ avatar: `${FIXTURE_PREFIX}A.png`, name: `${FIXTURE_PREFIX}A` }],
            groups: [{ id: 'g1', name: `${FIXTURE_PREFIX}g`, members: [], chats: [] }],
            worlds: [{ name: `${FIXTURE_PREFIX}w` }],
        });
        const r = await new Cleaner({ client: {}, apis: fake })
            .clean({ confirm: true, requirePrefix: FIXTURE_PREFIX });
        assert.equal(r.confirmed, true);
        assert.deepEqual(r.deleted, { characters: 1, groups: 1, worldinfo: 1, chats: 0, settings: 0 });
    });

    test('chat items are checked by their "Card / file" name too', async () => {
        const fake = fakeApis({
            characters: [{ avatar: `${FIXTURE_PREFIX}A.png`, name: `${FIXTURE_PREFIX}A` }],
            chats: { [`${FIXTURE_PREFIX}A.png`]: [{ file_name: 'UserLog.jsonl', chat_items: 1 }] },
        });
        // the card matches, and the chat item's name starts with the prefix
        // ("__drvtest_A / UserLog.jsonl") so the guard lets it through
        const r = await new Cleaner({ client: {}, apis: fake })
            .clean({ confirm: true, requirePrefix: FIXTURE_PREFIX });
        assert.equal(r.deleted.chats, 1);
    });

    test('an empty requirePrefix string disables the guard', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).clean({ confirm: true, requirePrefix: '' });
        assert.equal(r.deleted.characters, 2);
    });

    test('the guard also protects against a broken protect list', async () => {
        // protect matches nothing, but requirePrefix still aborts
        const fake = fakeApis(seed());
        const c = new Cleaner({ client: {}, apis: fake });
        await assert.rejects(() => c.clean({
            confirm: true, protect: ['NoSuchThing'], requirePrefix: FIXTURE_PREFIX,
        }));
        assert.equal(fake.state.characters.length, 2);
    });
});

describe('Cleaner.clean deletion order and counting (fake apis)', () => {
    const seed = () => ({
        characters: [
            { avatar: `${FIXTURE_PREFIX}A.png`, name: `${FIXTURE_PREFIX}A` },
            { avatar: `${FIXTURE_PREFIX}B.png`, name: `${FIXTURE_PREFIX}B` },
        ],
        groups: [{ id: 'g1', name: `${FIXTURE_PREFIX}g`, members: [], chats: ['gc1'] }],
        worlds: [{ name: `${FIXTURE_PREFIX}w` }],
        chats: {
            [`${FIXTURE_PREFIX}A.png`]: [{ file_name: 'a1.jsonl', chat_items: 1 }, { file_name: 'a2.jsonl', chat_items: 1 }],
            [`${FIXTURE_PREFIX}B.png`]: [{ file_name: 'b1.jsonl', chat_items: 1 }],
        },
    });

    test('groups are deleted before characters', async () => {
        const fake = fakeApis(seed());
        await new Cleaner({ client: {}, apis: fake }).clean({ confirm: true });
        const order = fake.calls.filter(c => /\.delete$/.test(c[0])).map(c => c[0]);
        assert.equal(order[0], 'groups.delete');
        assert.ok(order.indexOf('characters.delete') > order.indexOf('groups.delete'));
    });

    test('worldinfo is deleted last', async () => {
        const fake = fakeApis(seed());
        await new Cleaner({ client: {}, apis: fake }).clean({ confirm: true });
        const order = fake.calls.filter(c => /\.delete$/.test(c[0])).map(c => c[0]);
        assert.equal(order[order.length - 1], 'worldinfo.delete');
    });

    test('character deletion cascades chats (deleteChats:true)', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).clean({ confirm: true });
        const del = fake.calls.filter(c => c[0] === 'characters.delete');
        assert.equal(del.length, 2);
        assert.ok(del.every(c => c[2].deleteChats === true));
        assert.deepEqual(fake.calls.filter(c => c[0] === 'chats.delete'), [], 'no separate chat calls needed');
        assert.equal(r.deleted.chats, 3, 'cascaded logs still count towards deleted.chats');
    });

    test('scope.chats=false passes deleteChats:false and counts no chats', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).clean({ confirm: true, scope: { chats: false } });
        const del = fake.calls.filter(c => c[0] === 'characters.delete');
        assert.ok(del.every(c => c[2].deleteChats === false));
        assert.equal(r.deleted.chats, 0);
        assert.equal(r.planned.chats, 0);
    });

    test('scope.characters=false deletes logs directly via chats.delete', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).clean({ confirm: true, scope: { characters: false } });
        const direct = fake.calls.filter(c => c[0] === 'chats.delete');
        assert.equal(direct.length, 3);
        assert.equal(r.deleted.chats, 3);
        assert.equal(r.deleted.characters, 0);
        assert.equal(fake.state.characters.length, 2, 'cards survive');
        assert.deepEqual(direct[0].slice(1), [`${FIXTURE_PREFIX}A.png`, 'a1.jsonl']);
    });

    test('onProgress reports phase/done/total/name', async () => {
        const fake = fakeApis(seed());
        const seen = [];
        await new Cleaner({ client: {}, apis: fake })
            .clean({ confirm: true, onProgress: p => seen.push(p) });
        assert.ok(seen.some(p => p.phase === 'groups' && p.done === 1 && p.total === 1));
        assert.ok(seen.some(p => p.phase === 'characters' && p.done === 1 && p.total === 2));
        assert.ok(seen.some(p => p.phase === 'characters' && p.done === 2 && p.total === 2));
        assert.ok(seen.some(p => p.phase === 'worldinfo' && p.done === 1 && p.total === 1));
        assert.ok(seen.every(p => typeof p.name === 'string'));
    });

    test('a non-function onProgress is tolerated', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).clean({ confirm: true, onProgress: 'nope' });
        assert.equal(r.deleted.characters, 2);
    });

    test('a failing character delete is recorded, the run continues', async () => {
        const fake = fakeApis({ ...seed(), failOn: { character: `${FIXTURE_PREFIX}A.png` } });
        const r = await new Cleaner({ client: {}, apis: fake }).clean({ confirm: true });
        assert.equal(r.deleted.characters, 1);
        assert.equal(r.failures.length, 1);
        assert.equal(r.failures[0].kind, 'character');
        assert.equal(r.failures[0].id, `${FIXTURE_PREFIX}A.png`);
        assert.ok(r.failures[0].error.includes('boom'));
    });

    test('a failing group delete is recorded', async () => {
        const fake = fakeApis({ ...seed(), failOn: { group: 'g1' } });
        const r = await new Cleaner({ client: {}, apis: fake }).clean({ confirm: true });
        assert.equal(r.deleted.groups, 0);
        assert.equal(r.failures[0].kind, 'group');
    });

    test('a failing worldinfo delete is recorded', async () => {
        const fake = fakeApis({ ...seed(), failOn: { worldinfo: `${FIXTURE_PREFIX}w` } });
        const r = await new Cleaner({ client: {}, apis: fake }).clean({ confirm: true });
        assert.equal(r.deleted.worldinfo, 0);
        assert.equal(r.failures[0].kind, 'worldinfo');
    });

    test('a failing direct chat delete is recorded', async () => {
        const fake = fakeApis({ ...seed(), failOn: { chat: 'a1.jsonl' } });
        const r = await new Cleaner({ client: {}, apis: fake })
            .clean({ confirm: true, scope: { characters: false } });
        assert.equal(r.deleted.chats, 2);
        assert.equal(r.failures.length, 1);
        assert.equal(r.failures[0].kind, 'chat');
    });

    test('confirmed report carries dryRun:false and confirmed:true', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake }).clean({ confirm: true });
        assert.equal(r.dryRun, false);
        assert.equal(r.confirmed, true);
        assert.ok(!r.notes.some(n => n.includes('NOTHING WAS DELETED')));
    });

    test('items list matches the plan it executed', async () => {
        const fake = fakeApis(seed());
        const c = new Cleaner({ client: {}, apis: fake });
        const plan = await c.plan();
        const r = await c.clean({ confirm: true });
        assert.equal(r.items.length, plan.items.length);
    });

    test('a second run is an idempotent no-op', async () => {
        const fake = fakeApis(seed());
        const c = new Cleaner({ client: {}, apis: fake });
        await c.clean({ confirm: true });
        const r2 = await c.clean({ confirm: true });
        assert.deepEqual(r2.deleted, { characters: 0, groups: 0, worldinfo: 0, chats: 0, settings: 0 });
        assert.equal(r2.failures.length, 0);
    });

    test('protected cards are kept while unprotected ones go', async () => {
        const fake = fakeApis(seed());
        const r = await new Cleaner({ client: {}, apis: fake })
            .clean({ confirm: true, protect: [`${FIXTURE_PREFIX}A`] });
        assert.equal(r.deleted.characters, 1);
        assert.deepEqual(fake.state.characters.map(c => c.avatar), [`${FIXTURE_PREFIX}A.png`]);
    });
});

describe('Cleaner scope.settings (fake client)', () => {
    // tag_map holds one key for a card that still exists (Live.png) and one for a
    // card that is gone (Ghost.png); only the latter may be pruned.
    const base = () => ({
        active_character: 'OldCard.png',
        active_group: { 'g1': 1 },
        tag_map: { 'Live.png': ['t1'], 'Ghost.png': ['t2'] },
        user_avatar: 'user-default.png',
        power_user: { some_flag: true },
        main_api: 'openai',
    });

    test('clears active_character, active_group and prunes tag_map', async () => {
        const client = fakeClientForSettings(base());
        const fake = fakeApis({ characters: [{ avatar: 'Live.png', name: 'Live' }] });
        const c = new Cleaner({ client, apis: fake });
        const r = await c.clean({ confirm: true, scope: { settings: true, characters: false, groups: false, worldinfo: false } });
        assert.equal(r.deleted.settings, 1);
        assert.equal(client.saved.active_character, null);
        assert.deepEqual(client.saved.active_group, {});
        assert.deepEqual(client.saved.tag_map, { 'Live.png': ['t1'] }, 'Ghost.png pruned, Live.png kept');
    });

    test('leaves every other settings field untouched', async () => {
        const client = fakeClientForSettings(base());
        const fake = fakeApis({ characters: [{ avatar: 'Live.png', name: 'Live' }] });
        await new Cleaner({ client, apis: fake })
            .clean({ confirm: true, scope: { settings: true, characters: false, groups: false, worldinfo: false } });
        const before = base();
        for (const key of ['user_avatar', 'power_user', 'main_api']) {
            assert.deepEqual(client.saved[key], before[key], `${key} must not change`);
        }
    });

    test('records deleted.settings 0 and skips the write when nothing changed', async () => {
        const client = fakeClientForSettings({ active_character: null, active_group: {}, tag_map: {} });
        const fake = fakeApis({ characters: [] });
        const r = await new Cleaner({ client, apis: fake })
            .clean({ confirm: true, scope: { settings: true, characters: false, groups: false, worldinfo: false } });
        assert.equal(r.deleted.settings, 0);
        assert.equal(client.saved, null, 'no save call when there is nothing to clear');
    });

    test('a settings failure is recorded, not thrown', async () => {
        const client = {
            async post(p) {
                if (p === '/api/settings/get') throw new Error('settings unavailable');
                throw new Error(`unexpected ${p}`);
            },
        };
        const fake = fakeApis({ characters: [] });
        const r = await new Cleaner({ client, apis: fake })
            .clean({ confirm: true, scope: { settings: true, characters: false, groups: false, worldinfo: false } });
        assert.equal(r.failures.length, 1);
        assert.equal(r.failures[0].kind, 'settings');
        assert.ok(r.failures[0].error.includes('settings unavailable'));
    });

    test('settings is NOT touched by default', async () => {
        const client = fakeClientForSettings(base());
        const fake = fakeApis({ characters: [] });
        const r = await new Cleaner({ client, apis: fake }).clean({ confirm: true });
        assert.equal(r.deleted.settings, 0);
        assert.equal(client.saved, null);
    });

    test('an empty active_group is left alone', async () => {
        const client = fakeClientForSettings({ active_character: null, active_group: {}, tag_map: {} });
        const fake = fakeApis({ characters: [] });
        const r = await new Cleaner({ client, apis: fake })
            .clean({ confirm: true, scope: { settings: true, characters: false, groups: false, worldinfo: false } });
        assert.equal(r.deleted.settings, 0);
        assert.equal(client.saved, null);
    });

    test('a non-empty active_group is cleared even with no active_character', async () => {
        const client = fakeClientForSettings({ active_character: null, active_group: { 'g9': 3 }, tag_map: {} });
        const fake = fakeApis({ characters: [] });
        const r = await new Cleaner({ client, apis: fake })
            .clean({ confirm: true, scope: { settings: true, characters: false, groups: false, worldinfo: false } });
        assert.equal(r.deleted.settings, 1);
        assert.deepEqual(client.saved.active_group, {});
    });

    test('a missing active_group key does not throw', async () => {
        const client = fakeClientForSettings({ active_character: 'X.png', tag_map: {} });
        const fake = fakeApis({ characters: [] });
        const r = await new Cleaner({ client, apis: fake })
            .clean({ confirm: true, scope: { settings: true, characters: false, groups: false, worldinfo: false } });
        assert.equal(r.deleted.settings, 1);
        assert.equal(client.saved.active_character, null);
    });

    test('a non-object tag_map is left alone', async () => {
        const client = fakeClientForSettings({ active_character: null, active_group: {}, tag_map: 'corrupt' });
        const fake = fakeApis({ characters: [] });
        const r = await new Cleaner({ client, apis: fake })
            .clean({ confirm: true, scope: { settings: true, characters: false, groups: false, worldinfo: false } });
        assert.equal(r.deleted.settings, 0);
        assert.equal(client.saved, null);
    });
});

// ---------------------------------------------------------------------------
// Layer 2: live tests against the running instance
// ---------------------------------------------------------------------------

describe('Cleaner (live)', { timeout: 180_000 }, () => {
    let client;
    let chars;
    let chats;
    let groups;
    let worlds;
    let cleaner;
    /** Non-fixture content that must survive every live test. */
    let keepers = [];
    let keeperWorlds = [];
    let keeperGroups = [];
    /** protect list covering all pre-existing content. */
    let protect = [];
    const created = [];

    before(async () => {
        client = await newClient();
        chars = new CharactersApi(client);
        chats = new ChatsApi(client);
        groups = new GroupsApi(client);
        worlds = new WorldInfoApi(client);
        cleaner = new Cleaner({ client });

        keepers = (await chars.all()).map(c => String(c.avatar)).filter(a => a && !a.startsWith(FIXTURE_PREFIX));
        keeperWorlds = (await worlds.list()).map(w => String(w.name ?? w.file_id)).filter(n => n && !n.startsWith(FIXTURE_PREFIX));
        // Groups need BOTH name and id: a real group can have a name unrelated to
        // its members, and Cleaner matches either. Forgetting the id alone is not
        // enough and forgetting the name is not enough - an earlier revision of
        // this file protected only characters and worlds, and the requirePrefix
        // guard had to abort a real group deletion to stop it.
        keeperGroups = (await groups.all()).filter(g => {
            const name = String(g.name ?? '');
            const id = String(g.id ?? '');
            return (name || id) && !name.startsWith(FIXTURE_PREFIX);
        });
        // Protect every pre-existing entry by both avatar and display name, plus
        // every pre-existing world and group. requirePrefix is the second,
        // independent guard.
        protect = [
            ...keepers,
            ...keepers.map(n => n.replace(/\.png$/, '')),
            ...keeperWorlds,
            ...keeperGroups.flatMap(g => [String(g.name ?? ''), String(g.id ?? '')].filter(Boolean)),
        ];
    });

    after(async () => {
        // Safety net: never leave fixtures behind even if an assertion threw.
        await purgeFixtures(client).catch(() => {});
        await client?.close();
    });

    test('plan() against a live instance deletes nothing', async () => {
        const before = (await chars.all()).map(c => String(c.avatar));
        const r = await cleaner.plan();
        const after = (await chars.all()).map(c => String(c.avatar));
        assert.deepEqual(after, before);
        assert.equal(r.dryRun, true);
        assert.deepEqual(r.deleted, { characters: 0, groups: 0, worldinfo: 0, chats: 0, settings: 0 });
    });

    test('planned counts match the items it lists', async () => {
        const r = await cleaner.plan();
        assert.equal(r.planned.characters, r.items.filter(i => i.kind === 'character').length);
        assert.equal(r.planned.groups, r.items.filter(i => i.kind === 'group').length);
        assert.equal(r.planned.worldinfo, r.items.filter(i => i.kind === 'worldinfo').length);
        assert.equal(r.planned.chats, r.items.filter(i => i.kind === 'chat').length);
    });

    test('live protect list excludes all pre-existing content', async () => {
        const r = await cleaner.plan({ protect });
        // No carve-outs: every planned target must be a fixture, by name or id.
        for (const item of r.items) {
            assert.ok(
                String(item.name).startsWith(FIXTURE_PREFIX) || String(item.id).startsWith(FIXTURE_PREFIX),
                `plan leaked non-fixture ${item.kind}:${item.name} (id ${item.id})`,
            );
        }
        assert.ok(
            r.protected_.length >= keepers.length + keeperWorlds.length + keeperGroups.length,
            `expected all pre-existing content protected, got ${r.protected_.length}`,
        );
    });

    test('live: the guard would fire if the protect list forgot a group', async () => {
        // Regression guard for the bug this suite found on a real instance: a
        // protect list covering characters+worlds but NOT groups leaves a real
        // group (and its group chats) on the delete list. requirePrefix must
        // abort instead of deleting it.
        if (!keeperGroups.length) return; // nothing to prove on an empty instance
        const g = keeperGroups[0];
        const partial = [
            ...keepers,
            ...keepers.map(n => n.replace(/\.png$/, '')),
            ...keeperWorlds,
        ];
        const r = await cleaner.plan({ protect: partial });
        assert.ok(
            r.items.some(i => i.kind === 'group' && String(i.id) === String(g.id)),
            'sanity: the unprotected group must appear in the plan',
        );
        await assert.rejects(
            () => cleaner.clean({ confirm: true, protect: partial, requirePrefix: FIXTURE_PREFIX }),
            err => err.code === 'E_CLEAN_PREFIX_VIOLATION',
        );
        // and it must still be there afterwards
        assert.ok((await groups.all()).some(x => String(x.id) === String(g.id)), 'group survived the abort');
    });

    test('live: deletes a fixture card together with its chat logs', async () => {
        const name = fixtureName('cleanCard');
        const avatar = String(await chars.create({ ch_name: name, description: 'd', first_mes: 'hi' })).trim();
        created.push(avatar);
        await chats.save({
            avatarUrl: avatar, fileName: `${name} - 1`,
            chat: [{ user_name: 'You', character_name: name }, { name: 'You', is_user: true, mes: 'a' }],
        });
        await chats.save({
            avatarUrl: avatar, fileName: `${name} - 2`,
            chat: [{ user_name: 'You', character_name: name }, { name: 'You', is_user: true, mes: 'b' }],
        });
        assert.equal((await chars.chats(avatar, { simple: true })).length, 2);

        const r = await cleaner.clean({ confirm: true, protect, requirePrefix: FIXTURE_PREFIX });
        assert.equal(r.deleted.characters, 1);
        assert.equal(r.deleted.chats, 2, 'cascaded logs are counted');
        assert.equal(r.failures.length, 0, JSON.stringify(r.failures));

        const remaining = (await chars.all()).map(c => String(c.avatar));
        assert.ok(!remaining.includes(avatar), 'fixture card gone');
        for (const k of keepers) assert.ok(remaining.includes(k), `keeper ${k} must survive`);
    });

    test('live: deletes a fixture group and cascades its group chats', async () => {
        const name = fixtureName('cleanGroup');
        const a = String(await chars.create({ ch_name: fixtureName('m'), description: 'd', first_mes: 'x' })).trim();
        created.push(a);
        const g = await groups.create({ name, members: [a] });
        const gid = String(g.id);
        await groups.saveChat(gid, [
            { user_name: 'You', character_name: name },
            { name: 'You', is_user: true, mes: 'hi' },
        ], true);

        const r = await cleaner.clean({ confirm: true, protect, requirePrefix: FIXTURE_PREFIX });
        assert.equal(r.deleted.groups, 1);
        assert.equal(r.failures.length, 0, JSON.stringify(r.failures));
        assert.ok(!(await groups.all()).some(x => String(x.id) === gid), 'fixture group gone');
        // member card was also a fixture, so it goes too - keepers must not
        for (const k of keepers) {
            assert.ok((await chars.all()).some(c => String(c.avatar) === k), `keeper ${k} must survive`);
        }
    });

    test('live: deletes a fixture world book', async () => {
        const name = fixtureName('cleanWorld');
        await worlds.edit(name, { name, entries: { 0: { comment: 'e', content: 'c' } } });
        assert.ok((await worlds.list()).some(w => String(w.name ?? w.file_id) === name));

        const r = await cleaner.clean({ confirm: true, protect, requirePrefix: FIXTURE_PREFIX });
        assert.equal(r.deleted.worldinfo, 1);
        assert.equal(r.failures.length, 0, JSON.stringify(r.failures));
        const left = (await worlds.list()).map(w => String(w.name ?? w.file_id));
        assert.ok(!left.includes(name));
        for (const k of keeperWorlds) assert.ok(left.includes(k), `keeper world ${k} must survive`);
    });

    test('live: scope.characters=false removes logs but keeps the card', async () => {
        const name = fixtureName('keepCard');
        const avatar = String(await chars.create({ ch_name: name, description: 'd', first_mes: 'hi' })).trim();
        created.push(avatar);
        for (const i of [1, 2, 3]) {
            await chats.save({
                avatarUrl: avatar, fileName: `${name} - ${i}`,
                chat: [{ user_name: 'You', character_name: name }, { name: 'You', is_user: true, mes: 'm' }],
            });
        }
        const r = await cleaner.clean({
            confirm: true, protect, requirePrefix: FIXTURE_PREFIX, scope: { characters: false, groups: false, worldinfo: false },
        });
        assert.equal(r.deleted.chats, 3);
        assert.equal(r.deleted.characters, 0);
        assert.equal(r.failures.length, 0, JSON.stringify(r.failures));
        const list = await chars.chats(avatar, { simple: true });
        assert.ok(!Array.isArray(list) || list.length === 0 || list.error, 'logs must be gone');
        assert.ok((await chars.all()).some(c => String(c.avatar) === avatar), 'card must survive');
        await chars.delete(avatar, { deleteChats: true });
    });

    test('live: protecting a card keeps its logs too', async () => {
        const name = fixtureName('protCard');
        const avatar = String(await chars.create({ ch_name: name, description: 'd', first_mes: 'hi' })).trim();
        created.push(avatar);
        await chats.save({
            avatarUrl: avatar, fileName: `${name} - 1`,
            chat: [{ user_name: 'You', character_name: name }, { name: 'You', is_user: true, mes: 'm' }],
        });
        const r = await cleaner.clean({
            confirm: true, protect: [...protect, name], requirePrefix: FIXTURE_PREFIX,
        });
        assert.equal(r.deleted.characters, 0);
        assert.equal(r.deleted.chats, 0);
        assert.ok(r.protected_.some(s => s.includes(name)));
        assert.equal((await chars.chats(avatar, { simple: true })).length, 1, 'log must survive');
        await chars.delete(avatar, { deleteChats: true });
    });

    test('live: requirePrefix aborts before deleting anything real', async () => {
        // With NO protect list, every pre-existing entry is a candidate, so on an
        // instance that holds real content the guard must reject the whole run.
        const hasRealContent = keepers.length + keeperGroups.length + keeperWorlds.length > 0;
        if (hasRealContent) {
            await assert.rejects(
                () => cleaner.clean({ confirm: true, requirePrefix: FIXTURE_PREFIX }),
                err => {
                    assert.equal(err.code, 'E_CLEAN_PREFIX_VIOLATION');
                    assert.ok(err.offenders.length > 0);
                    return true;
                },
            );
        }
        const after = (await chars.all()).map(c => String(c.avatar));
        const afterGroups = (await groups.all()).map(g => String(g.id));
        const afterWorlds = (await worlds.list()).map(w => String(w.name ?? w.file_id));
        for (const k of keepers) assert.ok(after.includes(k), `keeper ${k} must survive the guard test`);
        for (const g of keeperGroups) assert.ok(afterGroups.includes(String(g.id)), `keeper group ${g.id} must survive`);
        for (const w of keeperWorlds) assert.ok(afterWorlds.includes(w), `keeper world ${w} must survive`);
    });

    test('live: clean is idempotent on an already-clean instance', async () => {
        await purgeFixtures(client);
        const r = await cleaner.clean({ confirm: true, protect, requirePrefix: FIXTURE_PREFIX });
        assert.deepEqual(r.deleted, { characters: 0, groups: 0, worldinfo: 0, chats: 0, settings: 0 });
        assert.equal(r.failures.length, 0);
    });
});
