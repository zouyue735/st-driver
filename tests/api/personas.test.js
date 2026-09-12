/**
 * LIVE INTEGRATION tests for PersonasApi against a running SillyTavern.
 *
 * LOSSLESS PRINCIPLE (this is the user's daily instance):
 *  - All fixture personas/avatars are prefixed __drvtest_ and removed after
 *    their test; `after` re-removes them as a safety net.
 *  - settings.json is mutated by createPersona/updatePersona/deletePersona/
 *    setActivePersona; the full original settings object is captured in
 *    `before` and re-saved in `after` so power_user.personas,
 *    power_user.persona_descriptions and user_avatar are byte-restored.
 *  - The user's own personas (5 at capture time) are never modified.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PersonasApi } from '../../src/api/personas.js';
import { SettingsApi } from '../../src/api/settings.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, fixtureName, tinyPng } from '../helpers.js';

let client;
let api;
let settingsApi;
let originalSettings;
/** Avatar file names created during the run (cleanup safety net). */
const createdAvatars = new Set();

before(async () => {
    client = await newClient();
    api = new PersonasApi(client);
    settingsApi = new SettingsApi(client);
    originalSettings = await settingsApi.getSettings();
});

after(async () => {
    try {
        // 1. Remove any leftover fixture avatar files.
        const avatars = await api.list();
        for (const file of avatars) {
            if (String(file).startsWith('__drvtest') || createdAvatars.has(file)) {
                await api.delete(file).catch(() => {});
            }
        }
        // 2. Restore the exact settings captured before the run.
        const current = await settingsApi.getSettings();
        current.power_user.personas = originalSettings.power_user.personas;
        current.power_user.persona_descriptions = originalSettings.power_user.persona_descriptions;
        current.user_avatar = originalSettings.user_avatar;
        await settingsApi.save(current);
    } catch { /* server gone; nothing to restore */ }
    await client?.close();
});

/** Upload a fixture avatar and remember it for cleanup. */
async function uploadFixture(fileName) {
    const res = await api.upload(tinyPng(), { overwriteName: fileName });
    createdAvatars.add(res.path);
    return res;
}

describe('HTTP layer: list()', () => {
    test('list() returns an array of avatar file names', async () => {
        const res = await api.list();
        assert.ok(Array.isArray(res));
        assert.ok(res.length >= 1, 'user has personas, so list is non-empty');
        for (const file of res) {
            assert.equal(typeof file, 'string');
            assert.match(file, /\.png$/i);
        }
    });

    test('uploaded fixture appears in list() and user files are preserved', async () => {
        const before = await api.list();
        const file = `${fixtureName('avatar')}.png`;
        await uploadFixture(file);
        const after = await api.list();
        assert.ok(after.includes(file));
        for (const b of before) {
            assert.ok(after.includes(b), `pre-existing avatar ${b} must survive upload`);
        }
        await api.delete(file);
    });
});

describe('HTTP layer: upload()', () => {
    test('upload(buffer, {overwriteName}) returns {path} equal to the given name', async () => {
        const file = `${fixtureName('avatar')}.png`;
        const res = await uploadFixture(file);
        assert.deepEqual(res, { path: file });
        await api.delete(file);
    });

    test('upload without overwriteName stores a generated <timestamp>.png name', async () => {
        const res = await api.upload(tinyPng(), {});
        assert.equal(typeof res.path, 'string');
        assert.match(res.path, /^\d+\.png$/);
        createdAvatars.add(res.path);
        await api.delete(res.path);
    });

    test('upload with a crop object succeeds', async () => {
        const file = `${fixtureName('avatar')}.png`;
        const res = await api.upload(tinyPng(), {
            overwriteName: file,
            crop: { x: 0, y: 0, width: 1, height: 1, want_resize: false },
        });
        assert.deepEqual(res, { path: file });
        await api.delete(file);
    });

    test('upload of invalid image data 400s', async () => {
        await assert.rejects(
            () => api.upload(Buffer.from('not-an-image-at-all'), { overwriteName: `${fixtureName('bad')}.png` }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('HTTP layer: delete()', () => {
    test('delete(avatar) removes the file and answers {result:"ok"}', async () => {
        const file = `${fixtureName('avatar')}.png`;
        await uploadFixture(file);
        const res = await api.delete(file);
        assert.deepEqual(res, { result: 'ok' });
        const list = await api.list();
        assert.ok(!list.includes(file));
    });

    test('delete of a missing avatar 404s', async () => {
        await assert.rejects(
            () => api.delete(`${fixtureName('ghost')}.png`),
            err => err instanceof StApiError && err.status === 404,
        );
    });
});

describe('users/me', () => {
    test('me() returns the user view model', async () => {
        const me = await api.me();
        assert.equal(typeof me.handle, 'string');
        assert.equal(typeof me.name, 'string');
        assert.equal(typeof me.admin, 'boolean');
        assert.equal(typeof me.created, 'number');
        // avatar is a data URL or empty string in single-user mode
        assert.ok(typeof me.avatar === 'string');
    });
});

describe('settings layer: createPersona()', () => {
    test('createPersona uploads the avatar and writes both settings maps', async () => {
        const name = fixtureName('persona');
        const description = `__drvtest_ description ${Date.now()}`;
        const persona = await api.createPersona({ name, description, avatarBuffer: tinyPng() });
        createdAvatars.add(persona.avatarFile);
        assert.equal(persona.name, name);
        assert.match(persona.avatarFile, /^__drvtest_persona_.+\.png$/);

        const settings = await settingsApi.getSettings();
        assert.equal(settings.power_user.personas[persona.avatarFile], name);
        assert.equal(settings.power_user.persona_descriptions[persona.avatarFile], description);
        assert.ok((await api.list()).includes(persona.avatarFile));

        await api.deletePersona({ name });
    });

    test('createPersona attaches to an existing avatar file when avatarFile is given', async () => {
        const file = `${fixtureName('avatar')}.png`;
        await uploadFixture(file);
        const name = fixtureName('persona');
        const persona = await api.createPersona({ name, description: 'attached', avatarFile: file });
        assert.equal(persona.avatarFile, file);
        const settings = await settingsApi.getSettings();
        assert.equal(settings.power_user.personas[file], name);
        await api.deletePersona({ name, deleteAvatar: true });
    });

    test('createPersona without avatarBuffer or avatarFile throws TypeError', async () => {
        await assert.rejects(
            () => api.createPersona({ name: fixtureName('persona'), description: 'x' }),
            err => err instanceof TypeError,
        );
    });

    test('createPersona with a duplicate persona name throws', async () => {
        const name = fixtureName('persona');
        const persona = await api.createPersona({ name, description: 'first', avatarBuffer: tinyPng() });
        createdAvatars.add(persona.avatarFile);
        try {
            await assert.rejects(
                () => api.createPersona({ name, description: 'second', avatarBuffer: tinyPng() }),
                /already exists/,
            );
        } finally {
            await api.deletePersona({ name });
        }
    });

    test('createPersona leaves the user pre-existing personas intact', async () => {
        const name = fixtureName('persona');
        const persona = await api.createPersona({ name, description: 'd', avatarBuffer: tinyPng() });
        createdAvatars.add(persona.avatarFile);
        try {
            const settings = await settingsApi.getSettings();
            for (const [file, pName] of Object.entries(originalSettings.power_user.personas)) {
                assert.equal(settings.power_user.personas[file], pName);
            }
        } finally {
            await api.deletePersona({ name });
        }
    });
});

describe('settings layer: updatePersona()', () => {
    test('updatePersona changes the description', async () => {
        const name = fixtureName('persona');
        await api.createPersona({ name, description: 'old', avatarBuffer: tinyPng() });
        createdAvatars.add((await findAvatarByName(name)).avatarFile);
        try {
            await api.updatePersona({ name, description: 'new description' });
            const settings = await settingsApi.getSettings();
            const { avatarFile } = await findAvatarByName(name);
            assert.equal(settings.power_user.persona_descriptions[avatarFile], 'new description');
        } finally {
            await api.deletePersona({ name });
        }
    });

    test('updatePersona can rename the persona', async () => {
        const name = fixtureName('persona');
        const newName = `${name}_renamed`;
        const persona = await api.createPersona({ name, description: 'd', avatarBuffer: tinyPng() });
        createdAvatars.add(persona.avatarFile);
        try {
            await api.updatePersona({ name, newName });
            const settings = await settingsApi.getSettings();
            assert.equal(settings.power_user.personas[persona.avatarFile], newName);
        } finally {
            await api.deletePersona({ name: newName });
        }
    });

    test('updatePersona of an unknown persona throws', async () => {
        await assert.rejects(
            () => api.updatePersona({ name: fixtureName('ghost'), description: 'x' }),
            /not found/,
        );
    });
});

describe('settings layer: setActivePersona()', () => {
    test('setActivePersona writes settings.user_avatar and restores cleanly', async () => {
        const name = fixtureName('persona');
        const persona = await api.createPersona({ name, description: 'd', avatarBuffer: tinyPng() });
        createdAvatars.add(persona.avatarFile);
        try {
            await api.setActivePersona(name);
            let settings = await settingsApi.getSettings();
            assert.equal(settings.user_avatar, persona.avatarFile);
            // restore the user's original active persona
            await api.setActivePersona(null);
            settings = await settingsApi.getSettings();
            assert.equal(settings.user_avatar, '');
            settings.user_avatar = originalSettings.user_avatar;
            await settingsApi.save(settings);
            settings = await settingsApi.getSettings();
            assert.equal(settings.user_avatar, originalSettings.user_avatar);
        } finally {
            await api.deletePersona({ name });
        }
    });

    test('setActivePersona for an unknown persona name throws', async () => {
        await assert.rejects(
            () => api.setActivePersona(fixtureName('ghost')),
            /not found/,
        );
    });
});

describe('settings layer: deletePersona()', () => {
    test('deletePersona removes settings entries and the avatar file', async () => {
        const name = fixtureName('persona');
        const persona = await api.createPersona({ name, description: 'd', avatarBuffer: tinyPng() });
        createdAvatars.add(persona.avatarFile);
        await api.deletePersona({ name });
        const settings = await settingsApi.getSettings();
        assert.ok(!Object.hasOwn(settings.power_user.personas, persona.avatarFile));
        assert.ok(!Object.hasOwn(settings.power_user.persona_descriptions, persona.avatarFile));
        assert.ok(!(await api.list()).includes(persona.avatarFile));
    });

    test('deletePersona with deleteAvatar:false keeps the avatar file', async () => {
        const name = fixtureName('persona');
        const persona = await api.createPersona({ name, description: 'd', avatarBuffer: tinyPng() });
        createdAvatars.add(persona.avatarFile);
        await api.deletePersona({ name, deleteAvatar: false });
        const settings = await settingsApi.getSettings();
        assert.ok(!Object.hasOwn(settings.power_user.personas, persona.avatarFile));
        assert.ok((await api.list()).includes(persona.avatarFile), 'avatar file must survive');
        await api.delete(persona.avatarFile);
    });

    test('deletePersona of an unknown persona throws and changes nothing', async () => {
        const before = JSON.stringify(await settingsApi.getSettings());
        await assert.rejects(
            () => api.deletePersona({ name: fixtureName('ghost') }),
            /not found/,
        );
        const after = JSON.stringify(await settingsApi.getSettings());
        assert.equal(before, after);
    });
});

describe('settings layer: lookup helpers', () => {
    test('findAvatarByName resolves persona name -> avatar file', async () => {
        const entry = await findAvatarByName(Object.values(originalSettings.power_user.personas)[0]);
        assert.ok(entry);
        assert.equal(typeof entry.avatarFile, 'string');
    });

    test('findAvatarByName returns null for an unknown persona', async () => {
        const entry = await findAvatarByName(fixtureName('ghost'));
        assert.equal(entry, null);
    });

    test('listPersonas returns name/avatarFile/description triples', async () => {
        const personas = await api.listPersonas();
        assert.ok(Array.isArray(personas));
        assert.ok(personas.length >= Object.keys(originalSettings.power_user.personas).length);
        for (const p of personas) {
            assert.equal(typeof p.name, 'string');
            assert.equal(typeof p.avatarFile, 'string');
        }
        const names = Object.values(originalSettings.power_user.personas);
        for (const n of names) {
            assert.ok(personas.some(p => p.name === n), `user persona ${n} must be listed`);
        }
    });
});

/** Resolve a persona name to its settings entry via the API's own helper. */
async function findAvatarByName(name) {
    return await api.findAvatarByName(name);
}
