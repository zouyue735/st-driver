/**
 * LIVE integration tests for CharactersApi (src/api/characters.js).
 *
 * These tests talk to a real, running SillyTavern server (default
 * http://localhost:8000, override with ST_URL). They create fixture
 * characters (all names prefixed with __drvtest_), exercise every endpoint
 * and parameter, and delete everything again in after().
 *
 * Behaviors verified against the live server that deviate from naive
 * expectations (all recorded here and in the module JSDoc):
 * - POST /api/characters/create accepts an application/json body (global
 *   bodyParser.json) even though it is also multipart-capable. JSON is the
 *   only transport that preserves arrays (alternate_greetings/tags) and
 *   numbers (talkativeness, depth_prompt_depth) exactly; the frontend
 *   /char-create slash command uses JSON too.
 * - The server responds to create with PLAIN TEXT: "<name>.png".
 * - get()/all()/export() cards report spec 'chara_card_v3' / spec_version
 *   '3.0' on ST 1.18.0: the PNG writer emits both 'chara' (v2) and 'ccv3'
 *   chunks and the reader prefers ccv3. The structure is still the v2 shape
 *   (top-level v1 mirrors + nested data.* v2 object).
 * - edit / edit-attribute / edit-avatar / delete / merge-attributes (single)
 *   answer with plain text 'OK' (Express sendStatus(200) body).
 * - importCard returns { file_name } WITHOUT the .png extension.
 * - merge-attributes on a nonexistent avatar fails with 500 (ENOENT), not 404.
 * - /api/characters/chats answers 200 { error: true } when the character's
 *   chat directory does not exist.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CharactersApi, UNSET_SENTINEL } from '../../src/api/characters.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, fixtureName, tinyPng, purgeFixtures, FIXTURE_PREFIX } from '../helpers.js';

let client;
let api;
/** @type {string[]} avatar file names created during the run, deleted in after() */
const created = [];

before(async () => {
    client = await newClient();
    api = new CharactersApi(client);
});

after(async () => {
    for (const avatar of created) {
        await api.delete(avatar, { deleteChats: true }).catch(() => {});
    }
    await purgeFixtures(client);
    const remaining = (await api.all()).filter(c => String(c.avatar).startsWith(FIXTURE_PREFIX));
    assert.deepEqual(remaining.map(c => c.avatar), [], 'all character fixtures must be cleaned up');
    await client?.close();
});

/**
 * Create a fixture character and track it for cleanup.
 * @param {object} [fields] extra create() fields
 * @param {string} [scope] fixture name scope
 * @returns {Promise<{chName: string, avatar: string}>}
 */
async function createFixture(fields = {}, scope = 'c') {
    const chName = fields.ch_name ?? fixtureName(scope);
    const avatar = await api.create({ ...fields, ch_name: chName });
    created.push(avatar);
    return { chName, avatar };
}

/** createFixture + read the card back via get(). */
async function createAndRead(fields = {}, scope = 'c') {
    const fixture = await createFixture(fields, scope);
    const card = await api.get(fixture.avatar);
    return { ...fixture, card };
}

describe('CharactersApi.create field round-trips (POST /api/characters/create + /get)', () => {
    test('ch_name (required) is stored as name and data.name', async () => {
        const { chName, card } = await createAndRead({}, 'name');
        assert.equal(card.name, chName);
        assert.equal(card.data.name, chName);
    });

    test('description is written and read back from data.description', async () => {
        const { card } = await createAndRead({ description: 'desc-value-123' });
        assert.equal(card.data.description, 'desc-value-123');
        assert.equal(card.description, 'desc-value-123');
    });

    test('personality is written and read back from data.personality', async () => {
        const { card } = await createAndRead({ personality: 'pers-value-123' });
        assert.equal(card.data.personality, 'pers-value-123');
    });

    test('scenario is written and read back from data.scenario', async () => {
        const { card } = await createAndRead({ scenario: 'scen-value-123' });
        assert.equal(card.data.scenario, 'scen-value-123');
    });

    test('first_mes is written and read back from data.first_mes', async () => {
        const { card } = await createAndRead({ first_mes: 'hello *waves*' });
        assert.equal(card.data.first_mes, 'hello *waves*');
    });

    test('mes_example is written and read back from data.mes_example', async () => {
        const { card } = await createAndRead({ mes_example: '<START>\n{{user}}: hi\n{{char}}: yo' });
        assert.equal(card.data.mes_example, '<START>\n{{user}}: hi\n{{char}}: yo');
    });

    test('creator_notes is written and read back from data.creator_notes', async () => {
        const { card } = await createAndRead({ creator_notes: 'notes-value-123' });
        assert.equal(card.data.creator_notes, 'notes-value-123');
        assert.equal(card.creatorcomment, 'notes-value-123'); // v1 mirror
    });

    test('system_prompt is written and read back from data.system_prompt', async () => {
        const { card } = await createAndRead({ system_prompt: 'sys-prompt-123' });
        assert.equal(card.data.system_prompt, 'sys-prompt-123');
    });

    test('post_history_instructions is written and read back from data.post_history_instructions', async () => {
        const { card } = await createAndRead({ post_history_instructions: 'phi-123' });
        assert.equal(card.data.post_history_instructions, 'phi-123');
    });

    test('alternate_greetings array is written and read back verbatim from data.alternate_greetings', async () => {
        const greetings = ['alt-greeting-one', 'alt-greeting-two', 'alt-greeting-three'];
        const { card } = await createAndRead({ alternate_greetings: greetings });
        assert.deepEqual(card.data.alternate_greetings, greetings);
    });

    test('tags array is written and read back from data.tags and top-level tags', async () => {
        const { card } = await createAndRead({ tags: ['tag-a', 'tag-b'] });
        assert.deepEqual(card.data.tags, ['tag-a', 'tag-b']);
        assert.deepEqual(card.tags, ['tag-a', 'tag-b']);
    });

    test('talkativeness number is written and read back from data.extensions.talkativeness as a number', async () => {
        const { card } = await createAndRead({ talkativeness: 0.75 });
        assert.equal(card.data.extensions.talkativeness, 0.75);
        assert.equal(typeof card.data.extensions.talkativeness, 'number');
    });

    test('talkativeness defaults to 0.5 when omitted', async () => {
        const { card } = await createAndRead({});
        assert.equal(card.data.extensions.talkativeness, 0.5);
    });

    test("fav 'true' string is written and read back as boolean true in data.extensions.fav", async () => {
        const { card } = await createAndRead({ fav: 'true' });
        assert.equal(card.data.extensions.fav, true);
        assert.equal(card.fav, true);
    });

    test("fav 'false' string is written and read back as boolean false", async () => {
        const { card } = await createAndRead({ fav: 'false' });
        assert.equal(card.data.extensions.fav, false);
    });

    test('fav boolean true is accepted as a convenience and coerced to the "true" string', async () => {
        const { card } = await createAndRead({ fav: true });
        assert.equal(card.data.extensions.fav, true);
    });

    test('creator is written and read back from data.creator', async () => {
        const { card } = await createAndRead({ creator: 'creator-123' });
        assert.equal(card.data.creator, 'creator-123');
    });

    test('character_version is written and read back from data.character_version', async () => {
        const { card } = await createAndRead({ character_version: '9.9.9' });
        assert.equal(card.data.character_version, '9.9.9');
    });

    test('depth_prompt_prompt is written and read back from data.extensions.depth_prompt.prompt', async () => {
        const { card } = await createAndRead({ depth_prompt_prompt: 'deep-prompt-123' });
        assert.equal(card.data.extensions.depth_prompt.prompt, 'deep-prompt-123');
    });

    test('depth_prompt_depth is written and read back from data.extensions.depth_prompt.depth as a number', async () => {
        const { card } = await createAndRead({ depth_prompt_depth: 7 });
        assert.equal(card.data.extensions.depth_prompt.depth, 7);
    });

    test('depth_prompt_role is written and read back from data.extensions.depth_prompt.role', async () => {
        const { card } = await createAndRead({ depth_prompt_role: 'assistant' });
        assert.equal(card.data.extensions.depth_prompt.role, 'assistant');
    });

    test("depth_prompt defaults are prompt '', depth 4, role 'system' when omitted", async () => {
        const { card } = await createAndRead({});
        assert.deepEqual(card.data.extensions.depth_prompt, { prompt: '', depth: 4, role: 'system' });
    });

    test('world is written and read back from data.extensions.world (missing world file only logs a warning)', async () => {
        const worldName = fixtureName('w');
        const { card } = await createAndRead({ world: worldName });
        assert.equal(card.data.extensions.world, worldName);
    });

    test('extensions JSON-string is deep-merged into data.extensions', async () => {
        const { card } = await createAndRead({ extensions: '{"drvtest_flag": 42}' });
        assert.equal(card.data.extensions.drvtest_flag, 42);
    });
});

describe('CharactersApi.create behaviors', () => {
    test('create returns the avatar file name as plain text ending in .png', async () => {
        const chName = fixtureName('ret');
        const avatar = await api.create({ ch_name: chName });
        created.push(avatar);
        assert.equal(typeof avatar, 'string');
        assert.ok(avatar.endsWith('.png'), `expected .png suffix, got ${avatar}`);
        assert.ok(avatar.startsWith(chName), `expected avatar to start with ch_name, got ${avatar}`);
    });

    test('create without any optional fields defaults text fields to empty strings', async () => {
        const { card } = await createAndRead({});
        assert.equal(card.data.description, '');
        assert.equal(card.data.personality, '');
        assert.equal(card.data.scenario, '');
        assert.equal(card.data.first_mes, '');
        assert.equal(card.data.mes_example, '');
        assert.deepEqual(card.data.alternate_greetings, []);
        assert.deepEqual(card.data.tags, []);
    });

    test('create honors an explicit file_name (internal name)', async () => {
        const chName = fixtureName('fn');
        const avatar = await api.create({ ch_name: chName, file_name: `${chName}_custom` });
        created.push(avatar);
        assert.equal(avatar, `${chName}_custom.png`);
    });

    test('create with a duplicate ch_name gets a unique avatar file name suffix', async () => {
        const chName = fixtureName('dup');
        const first = await api.create({ ch_name: chName });
        const second = await api.create({ ch_name: chName });
        created.push(first, second);
        assert.notEqual(first, second);
        assert.ok(second.startsWith(chName));
    });

    test("create rejects file_name containing '/' with StApiError 400 (validateFileName middleware)", async () => {
        await assert.rejects(
            () => api.create({ ch_name: fixtureName('bad'), file_name: 'bad/name' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('created character appears in all() with avatar, name and data', async () => {
        const { chName, avatar } = await createFixture({}, 'listed');
        const all = await api.all();
        const found = all.find(c => c.avatar === avatar);
        assert.ok(found, 'fixture must be listed by /all');
        assert.equal(found.name, chName);
        assert.ok(found.data && typeof found.data === 'object');
    });
});

describe('CharactersApi.all / get (POST /api/characters/all, /api/characters/get)', () => {
    test('all() returns an array of character objects with v1 mirrors and nested v2 data', async () => {
        const all = await api.all();
        assert.ok(Array.isArray(all));
        for (const c of all) {
            assert.equal(typeof c.avatar, 'string');
            assert.equal(typeof c.name, 'string');
        }
    });

    test('get(avatarUrl) returns the full card including json_data, chat and create_date', async () => {
        const { avatar } = await createFixture({ description: 'get-shape' });
        const card = await api.get(avatar);
        assert.equal(card.avatar, avatar);
        assert.equal(typeof card.json_data, 'string');
        assert.equal(typeof card.chat, 'string');
        assert.equal(typeof card.create_date, 'string');
        assert.equal(typeof card.date_added, 'number');
        // ST 1.18.0 quirk: cards are read back as v3 (ccv3 PNG chunk takes
        // precedence) even though the create form data is formatted as v2.
        assert.equal(card.spec, 'chara_card_v3');
        assert.equal(card.spec_version, '3.0');
        assert.equal(JSON.parse(card.json_data).data.description, 'get-shape');
    });

    test('get() on a nonexistent avatar throws StApiError 404', async () => {
        await assert.rejects(
            () => api.get(`${fixtureName('ghost')}.png`),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test("get() with '/' inside avatar_url throws StApiError 400 (validateFileName middleware)", async () => {
        await assert.rejects(
            () => api.get('bad/name.png'),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('CharactersApi.edit (POST /api/characters/edit)', () => {
    test('edit updates description and answers with plain text OK', async () => {
        const { chName, avatar } = await createFixture({ description: 'before' });
        const res = await api.edit({ avatar_url: avatar, ch_name: chName, description: 'after-edit' });
        assert.equal(res, 'OK');
        const card = await api.get(avatar);
        assert.equal(card.data.description, 'after-edit');
    });

    test('edit updates personality, scenario, first_mes and mes_example together', async () => {
        const { chName, avatar } = await createFixture();
        await api.edit({
            avatar_url: avatar, ch_name: chName,
            personality: 'p2', scenario: 's2', first_mes: 'f2', mes_example: 'm2',
        });
        const card = await api.get(avatar);
        assert.equal(card.data.personality, 'p2');
        assert.equal(card.data.scenario, 's2');
        assert.equal(card.data.first_mes, 'f2');
        assert.equal(card.data.mes_example, 'm2');
    });

    test('edit updates creator_notes, system_prompt and post_history_instructions', async () => {
        const { chName, avatar } = await createFixture();
        await api.edit({
            avatar_url: avatar, ch_name: chName,
            creator_notes: 'cn2', system_prompt: 'sp2', post_history_instructions: 'phi2',
        });
        const card = await api.get(avatar);
        assert.equal(card.data.creator_notes, 'cn2');
        assert.equal(card.data.system_prompt, 'sp2');
        assert.equal(card.data.post_history_instructions, 'phi2');
    });

    test('edit replaces the whole alternate_greetings array', async () => {
        const { chName, avatar } = await createFixture({ alternate_greetings: ['old-1', 'old-2'] });
        await api.edit({ avatar_url: avatar, ch_name: chName, alternate_greetings: ['new-1'] });
        const card = await api.get(avatar);
        assert.deepEqual(card.data.alternate_greetings, ['new-1']);
    });

    test('edit replaces tags and updates talkativeness (number) and fav (string)', async () => {
        const { chName, avatar } = await createFixture({ tags: ['old'], talkativeness: 0.5, fav: 'false' });
        await api.edit({ avatar_url: avatar, ch_name: chName, tags: ['x', 'y'], talkativeness: 0.9, fav: 'true' });
        const card = await api.get(avatar);
        assert.deepEqual(card.data.tags, ['x', 'y']);
        assert.equal(card.data.extensions.talkativeness, 0.9);
        assert.equal(card.data.extensions.fav, true);
    });

    test('edit updates creator, character_version and the depth_prompt_* trio', async () => {
        const { chName, avatar } = await createFixture();
        await api.edit({
            avatar_url: avatar, ch_name: chName,
            creator: 'c2', character_version: '2.2.2',
            depth_prompt_prompt: 'dp2', depth_prompt_depth: 3, depth_prompt_role: 'user',
        });
        const card = await api.get(avatar);
        assert.equal(card.data.creator, 'c2');
        assert.equal(card.data.character_version, '2.2.2');
        assert.deepEqual(card.data.extensions.depth_prompt, { prompt: 'dp2', depth: 3, role: 'user' });
    });

    test('edit without ch_name throws StApiError 400', async () => {
        const { avatar } = await createFixture();
        await assert.rejects(
            () => api.edit({ avatar_url: avatar, description: 'nope' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('CharactersApi.editAttribute (POST /api/characters/edit-attribute)', () => {
    test('editAttribute(description) updates both the v1 mirror and data.description', async () => {
        const { chName, avatar } = await createFixture({ description: 'attr-before' });
        const res = await api.editAttribute(avatar, chName, 'description', 'attr-after');
        assert.equal(res, 'OK');
        const card = await api.get(avatar);
        assert.equal(card.data.description, 'attr-after');
        assert.equal(card.description, 'attr-after');
    });

    test('editAttribute(alternate_greetings) accepts an array value', async () => {
        const { chName, avatar } = await createFixture();
        await api.editAttribute(avatar, chName, 'alternate_greetings', ['g1', 'g2']);
        const card = await api.get(avatar);
        assert.deepEqual(card.data.alternate_greetings, ['g1', 'g2']);
    });

    test("editAttribute note: talkativeness lives in data.extensions.talkativeness, editing the v1 mirror 'talkativeness' does not survive a re-read", async () => {
        // Verified live: edit-attribute writes char[field] and char.data[field]
        // only. get() re-hoists char.talkativeness from data.extensions.talkativeness,
        // so the mirrored write is invisible afterwards. Use mergeAttributes for
        // extension fields instead.
        const { chName, avatar } = await createFixture({ talkativeness: 0.5 });
        await api.editAttribute(avatar, chName, 'talkativeness', 0.9);
        const card = await api.get(avatar);
        assert.equal(card.data.extensions.talkativeness, 0.5, 'extensions value is authoritative on read');
    });

    test('editAttribute with an unknown field throws StApiError 400', async () => {
        const { chName, avatar } = await createFixture();
        await assert.rejects(
            () => api.editAttribute(avatar, chName, 'no_such_field_xyz', 'v'),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test("editAttribute refuses to edit the 'json_data' field with StApiError 400", async () => {
        const { chName, avatar } = await createFixture();
        await assert.rejects(
            () => api.editAttribute(avatar, chName, 'json_data', 'v'),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('editAttribute without ch_name throws StApiError 400', async () => {
        const { avatar } = await createFixture();
        await assert.rejects(
            () => api.editAttribute(avatar, '', 'description', 'v'),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('CharactersApi.editAvatar (POST /api/characters/edit-avatar)', () => {
    test('editAvatar replaces the PNG image while keeping the card data intact', async () => {
        const { avatar } = await createFixture({ description: 'keep-me' });
        const res = await api.editAvatar(avatar, tinyPng());
        assert.equal(res, 'OK');
        const card = await api.get(avatar);
        assert.equal(card.data.description, 'keep-me');
        const png = await api.export(avatar, 'png');
        assert.equal(png.subarray(1, 4).toString(), 'PNG');
        assert.ok(png.length < 10_000, `expected the tiny 1x1 avatar, got ${png.length} bytes`);
    });
});

describe('CharactersApi.mergeAttributes single mode (POST /api/characters/merge-attributes)', () => {
    test('mergeAttributes merges a nested data.* patch and answers plain text OK', async () => {
        const { avatar } = await createFixture();
        const res = await api.mergeAttributes(avatar, { data: { creator: 'merged-creator', personality: 'merged-pers' } });
        assert.equal(res, 'OK');
        const card = await api.get(avatar);
        assert.equal(card.data.creator, 'merged-creator');
        assert.equal(card.data.personality, 'merged-pers');
        assert.equal(card.personality, 'merged-pers', 'v1 mirror is hoisted from data on read');
    });

    test(`mergeAttributes with the sentinel ${UNSET_SENTINEL} deletes the key from the card`, async () => {
        const { avatar } = await createFixture({ personality: 'to-be-removed' });
        await api.mergeAttributes(avatar, { data: { personality: UNSET_SENTINEL } });
        const card = await api.get(avatar);
        assert.equal('personality' in card.data, false, 'data.personality must be unset');
    });

    test('mergeAttributes deep-merges into data.extensions without clobbering siblings', async () => {
        const { avatar } = await createFixture({ talkativeness: 0.75 });
        await api.mergeAttributes(avatar, { data: { extensions: { drvtest_marker: 'yes' } } });
        const card = await api.get(avatar);
        assert.equal(card.data.extensions.drvtest_marker, 'yes');
        assert.equal(card.data.extensions.talkativeness, 0.75);
    });

    test('mergeAttributes on a nonexistent avatar throws StApiError 500 (server-side ENOENT, not 404)', async () => {
        await assert.rejects(
            () => api.mergeAttributes(`${fixtureName('ghost')}.png`, { data: { creator: 'x' } }),
            err => err instanceof StApiError && err.status === 500,
        );
    });
});

describe('CharactersApi.mergeAttributes bulk mode (POST /api/characters/merge-attributes)', () => {
    test('bulk mode with an explicit avatars list updates all of them and reports {updated, skipped, failed}', async () => {
        const a = await createFixture({}, 'bulk1');
        const b = await createFixture({}, 'bulk2');
        const res = await api.mergeAttributes([a.avatar, b.avatar], { data: { creator: 'bulk-creator' } });
        assert.deepEqual(res.updated.sort(), [a.avatar, b.avatar].sort());
        assert.deepEqual(res.skipped, []);
        assert.deepEqual(res.failed, []);
        assert.equal((await api.get(a.avatar)).data.creator, 'bulk-creator');
        assert.equal((await api.get(b.avatar)).data.creator, 'bulk-creator');
    });

    test('bulk mode filter.path skips characters where the path is undefined', async () => {
        const marked = await createFixture({}, 'mark');
        const plain = await createFixture({}, 'plain');
        await api.mergeAttributes(marked.avatar, { data: { extensions: { drvtest_marker: 'yes' } } });
        const res = await api.mergeAttributes(
            [marked.avatar, plain.avatar],
            { data: { creator: 'filtered-creator' } },
            { filter: { path: 'data.extensions.drvtest_marker' } },
        );
        assert.deepEqual(res.updated, [marked.avatar]);
        assert.deepEqual(res.skipped, [plain.avatar]);
        assert.deepEqual(res.failed, []);
        assert.equal((await api.get(marked.avatar)).data.creator, 'filtered-creator');
        assert.equal((await api.get(plain.avatar)).data.creator, '');
    });

    test('bulk mode with the sentinel deletes keys on every targeted card', async () => {
        const a = await createFixture({ personality: 'gone-a' }, 'bsent1');
        const b = await createFixture({ personality: 'gone-b' }, 'bsent2');
        await api.mergeAttributes([a.avatar, b.avatar], { data: { personality: UNSET_SENTINEL } });
        assert.equal('personality' in (await api.get(a.avatar)).data, false);
        assert.equal('personality' in (await api.get(b.avatar)).data, false);
    });

    test('bulk mode with a non-.png avatar entry throws StApiError 400', async () => {
        await assert.rejects(
            () => api.mergeAttributes(['bad_name.txt'], { data: { creator: 'x' } }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('bulk mode without update data throws StApiError 400', async () => {
        const { avatar } = await createFixture({}, 'nodata');
        await assert.rejects(
            () => api.mergeAttributes([avatar], undefined),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('CharactersApi.rename / duplicate / delete', () => {
    test('rename(avatarUrl, newName) returns {avatar} and moves the card and its chats', async () => {
        const { avatar } = await createFixture({}, 'rn');
        const newName = fixtureName('rn2');
        const res = await api.rename(avatar, newName);
        assert.equal(typeof res.avatar, 'string');
        assert.ok(res.avatar.endsWith('.png'));
        created.push(res.avatar);
        const card = await api.get(res.avatar);
        assert.equal(card.data.name, newName);
        await assert.rejects(
            () => api.get(avatar),
            err => err instanceof StApiError && err.status === 404,
            'the old avatar must be gone',
        );
    });

    test('rename without new_name throws StApiError 400', async () => {
        const { avatar } = await createFixture({}, 'rnbad');
        await assert.rejects(
            () => api.rename(avatar, ''),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('duplicate(avatarUrl) returns {path} of the copy with an incremented suffix', async () => {
        const { avatar } = await createFixture({ description: 'dupe-me' }, 'dp');
        const res = await api.duplicate(avatar);
        assert.equal(typeof res.path, 'string');
        assert.notEqual(res.path, avatar);
        assert.ok(res.path.endsWith('.png'));
        created.push(res.path);
        const copy = await api.get(res.path);
        assert.equal(copy.data.description, 'dupe-me');
    });

    test('duplicate on a nonexistent avatar throws StApiError 404', async () => {
        await assert.rejects(
            () => api.duplicate(`${fixtureName('ghost')}.png`),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('delete(avatarUrl, {deleteChats: true}) removes the card AND its chat directory', async () => {
        const { chName, avatar } = await createFixture({}, 'del');
        const chatFile = `${chName} - chatdoomed`;
        await client.post('/api/chats/save', {
            avatar_url: avatar,
            file_name: chatFile,
            chat: [{ chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
                { name: 'U', is_user: true, send_date: new Date().toISOString(), mes: 'bye', extra: {} }],
        });
        const listed = await api.chats(avatar);
        assert.ok(Array.isArray(listed) && listed.length === 1, 'chat must exist before delete');
        const res = await api.delete(avatar, { deleteChats: true });
        assert.equal(res, 'OK');
        await assert.rejects(() => api.get(avatar), err => err instanceof StApiError && err.status === 404);
        // chat directory was removed with the character
        assert.deepEqual(await api.chats(avatar), { error: true });
    });

    test('delete(avatarUrl) without deleteChats keeps the chat directory (chats still listed)', async () => {
        const { chName, avatar } = await createFixture({}, 'keepchats');
        const base = avatar.replace(/\.png$/, '');
        await client.post('/api/chats/save', {
            avatar_url: avatar,
            file_name: `${chName} - survivor`,
            chat: [{ chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
                { name: 'U', is_user: true, send_date: new Date().toISOString(), mes: 'still here', extra: {} }],
        });
        assert.equal(await api.delete(avatar), 'OK');
        const listed = await api.chats(avatar);
        assert.ok(Array.isArray(listed), 'chat directory must survive the delete');
        assert.equal(listed.length, 1);
        // Recreate a character under the same internal name so after() can
        // cascade-delete the leftover chat directory.
        const again = await api.create({ ch_name: chName, file_name: base });
        created.push(again);
        assert.equal(again, avatar);
    });

    test('delete on a nonexistent avatar throws StApiError 400', async () => {
        await assert.rejects(
            () => api.delete(`${fixtureName('ghost')}.png`),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('CharactersApi.chats (POST /api/characters/chats)', () => {
    test('chats() on a fresh character returns [] (chat dir is created by /create but empty)', async () => {
        const { avatar } = await createFixture({}, 'chats0');
        assert.deepEqual(await api.chats(avatar), []);
    });

    test('chats() default mode lists chat files with file_id, file_name, chat_items, mes and last_mes', async () => {
        const { avatar } = await createFixture({}, 'chats1');
        const sendDate = new Date().toISOString();
        await client.post('/api/chats/save', {
            avatar_url: avatar,
            file_name: 'listing-test',
            chat: [{ chat_metadata: { drvtest: 1 }, user_name: 'unused', character_name: 'unused' },
                { name: 'U', is_user: true, send_date: sendDate, mes: 'ping', extra: {} }],
        });
        const list = await api.chats(avatar);
        assert.ok(Array.isArray(list) && list.length === 1);
        assert.equal(list[0].file_name, 'listing-test.jsonl');
        assert.equal(list[0].file_id, 'listing-test');
        assert.equal(list[0].chat_items, 1);
        assert.equal(list[0].mes, 'ping');
        assert.equal(list[0].last_mes, sendDate);
        assert.equal(list[0].chat_metadata, undefined, 'metadata only with {metadata: true}');
    });

    test('chats(avatarUrl, {simple: true}) lists only file_name and file_id', async () => {
        const { avatar } = await createFixture({}, 'chats2');
        await client.post('/api/chats/save', {
            avatar_url: avatar,
            file_name: 'simple-test',
            chat: [{ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }],
        });
        const list = await api.chats(avatar, { simple: true });
        assert.deepEqual(list, [{ file_name: 'simple-test.jsonl', file_id: 'simple-test' }]);
    });

    test('chats(avatarUrl, {metadata: true}) includes the chat_metadata of each file', async () => {
        const { avatar } = await createFixture({}, 'chats3');
        await client.post('/api/chats/save', {
            avatar_url: avatar,
            file_name: 'meta-test',
            chat: [{ chat_metadata: { drvtest_flag: 'yes' }, user_name: 'unused', character_name: 'unused' }],
        });
        const list = await api.chats(avatar, { metadata: true });
        assert.equal(list.length, 1);
        assert.deepEqual(list[0].chat_metadata, { drvtest_flag: 'yes' });
    });

    test('chats() for a character without a chat directory returns {error: true} (200, not an HTTP error)', async () => {
        assert.deepEqual(await api.chats(`${fixtureName('nochatdir')}.png`), { error: true });
    });
});

describe('CharactersApi.export / importCard (POST /api/characters/export, /api/characters/import)', () => {
    test("export(avatarUrl, 'json') returns the card object with private fields stripped", async () => {
        const { chName, avatar } = await createFixture({ description: 'export-me', fav: 'true' }, 'exp');
        const card = await api.export(avatar, 'json');
        assert.equal(typeof card, 'object');
        assert.equal(card.data.name, chName);
        assert.equal(card.data.description, 'export-me');
        assert.equal(card.data.extensions.fav, false, 'fav is private and must be exported as false');
        assert.equal(card.fav, false);
        assert.equal('chat' in card, false, 'chat is private and must be stripped');
        assert.equal(card.json_data, undefined, 'json_data must not be exported');
    });

    test("export(avatarUrl, 'png') returns a PNG buffer (re-importable card image)", async () => {
        const { avatar } = await createFixture({}, 'exppng');
        const png = await api.export(avatar, 'png');
        assert.ok(Buffer.isBuffer(png));
        assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic bytes');
    });

    test('export with an unsupported format throws StApiError 400', async () => {
        const { avatar } = await createFixture({}, 'expbad');
        await assert.rejects(
            () => api.export(avatar, 'xml'),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('export of a nonexistent avatar throws StApiError 404', async () => {
        await assert.rejects(
            () => api.export(`${fixtureName('ghost')}.png`, 'json'),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test("importCard(jsonBuffer, 'json') imports a v2 card and returns {file_name} WITHOUT the .png extension", async () => {
        const name = fixtureName('imp');
        const card = {
            name,
            description: 'imported-json-desc',
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name,
                description: 'imported-json-desc',
                creator_notes: '', tags: [], creator: '', character_version: '',
                alternate_greetings: [], extensions: {},
                first_mes: '', mes_example: '', personality: '', scenario: '',
                system_prompt: '', post_history_instructions: '',
            },
        };
        const res = await api.importCard(Buffer.from(JSON.stringify(card), 'utf8'), 'json');
        assert.equal(typeof res.file_name, 'string');
        assert.equal(res.file_name.endsWith('.png'), false, 'ST quirk: file_name has no extension');
        const avatar = `${res.file_name}.png`;
        created.push(avatar);
        const imported = await api.get(avatar);
        assert.equal(imported.data.name, name);
        assert.equal(imported.data.description, 'imported-json-desc');
    });

    test('importCard with preservedName overwrites the existing character file in place', async () => {
        const { avatar } = await createFixture({ description: 'v1' }, 'pres');
        const exported = await api.export(avatar, 'json');
        exported.data.description = 'v2-overwritten';
        const res = await api.importCard(
            Buffer.from(JSON.stringify(exported), 'utf8'),
            'json',
            { preservedName: avatar },
        );
        assert.equal(res.file_name, avatar.replace(/\.png$/, ''));
        const card = await api.get(avatar);
        assert.equal(card.data.description, 'v2-overwritten');
    });

    test("importCard(pngBuffer, 'png') round-trips an exported PNG card", async () => {
        const { chName, avatar } = await createFixture({ description: 'png-roundtrip', first_mes: 'yo' }, 'pngrt');
        const png = await api.export(avatar, 'png');
        const res = await api.importCard(png, 'png');
        const newAvatar = `${res.file_name}.png`;
        created.push(newAvatar);
        assert.notEqual(newAvatar, avatar, 'a new unique file name is assigned');
        const imported = await api.get(newAvatar);
        assert.equal(imported.data.name, chName);
        assert.equal(imported.data.description, 'png-roundtrip');
        assert.equal(imported.data.first_mes, 'yo');
    });

    test('importCard with an unsupported file_type returns {error: true} (HTTP 200)', async () => {
        const res = await api.importCard(Buffer.from('{}'), 'xyz');
        assert.deepEqual(res, { error: true });
    });

    test("importCard with malformed JSON content for file_type 'json' returns {error: true} (HTTP 200)", async () => {
        const res = await api.importCard(Buffer.from('this is not json'), 'json');
        assert.deepEqual(res, { error: true });
    });
});
