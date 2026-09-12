/**
 * LIVE integration tests for ExtensionsApi (src/api/extensions.js),
 * backed by /api/extensions/* on ST 1.18.0.
 *
 * Safety policy (this runs against the user's daily instance):
 * - discover() and version() are read-only (version shells out to `git fetch`
 *   on the extension repo, which is still non-mutating).
 * - branches()/update()/switch()/move()/delete() are implemented but their
 *   live SUCCESS tests are SKIPPED: branches unshallows/fetches the repo,
 *   update pulls from origin, switch checks out another branch, move relocates
 *   the folder between user/global - every one of them changes the user's
 *   extension install. Only their harmless 404/400 error paths on a
 *   nonexistent __drvtest_ extension name are exercised live (verified: the
 *   server rejects those before any git or filesystem mutation).
 *
 * Live quirks verified against ST 1.18.0:
 * - discover() is GET (the only GET route in this module); every other route
 *   is POST.
 * - discover() lists SYSTEM extensions by bare folder name ('regex',
 *   'quick-reply', ...) but third-party ones prefixed with 'third-party/'.
 * - version()/branches()/update()/switch()/delete() resolve `extensionName`
 *   ONLY inside the user's third-party directory (or the global one with
 *   {global: true}). Passing a system extension name like 'regex' therefore
 *   answers 404 'Directory does not exist at data\default-user\extensions\regex'
 *   - system extensions are NOT supported by /version (confirmed by reading
 *   src/endpoints/extensions.js: basePath is always a third-party directory).
 * - Error bodies are plain text, not JSON.
 * - The whole router 404s when `extensions.enabled` is false in config.yaml
 *   (feature guard); not observed on the test instance.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionsApi } from '../../src/api/extensions.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, fixtureName } from '../helpers.js';

let client;
let api;
/** A guaranteed-nonexistent extension name for error-path tests. */
let ghost;

before(async () => {
    client = await newClient();
    api = new ExtensionsApi(client);
    ghost = fixtureName('ext');
});

after(async () => {
    await client?.close();
});

describe('ExtensionsApi.discover (GET /api/extensions/discover)', () => {
    test('discover returns an array of {type, name} entries', async () => {
        const res = await api.discover();
        assert.ok(Array.isArray(res));
        assert.ok(res.length > 0, 'a stock ST install ships system extensions');
        for (const entry of res) {
            assert.equal(typeof entry.name, 'string');
            assert.ok(['system', 'local', 'global'].includes(entry.type), `unexpected type ${entry.type}`);
        }
    });

    test('discover lists the built-in system extensions regex and quick-reply by bare folder name', async () => {
        const res = await api.discover();
        const systemNames = res.filter(e => e.type === 'system').map(e => e.name);
        assert.ok(systemNames.includes('regex'), `regex missing from ${JSON.stringify(systemNames)}`);
        assert.ok(systemNames.includes('quick-reply'), `quick-reply missing from ${JSON.stringify(systemNames)}`);
        // More stock entries that must be present on any 1.18.x install.
        for (const name of ['caption', 'expressions', 'stable-diffusion', 'token-counter', 'translate', 'tts', 'vectors']) {
            assert.ok(systemNames.includes(name), `${name} missing from system extensions`);
        }
        // 'third-party' itself is excluded from the listing (verified in source).
        assert.equal(systemNames.includes('third-party'), false);
    });

    test('discover tags third-party installs with type local/global and a "third-party/" name prefix', async () => {
        const res = await api.discover();
        for (const entry of res.filter(e => e.type !== 'system')) {
            assert.ok(entry.name.startsWith('third-party/'), `non-system entry ${entry.name} must carry the prefix`);
        }
    });
});

describe('ExtensionsApi.version (POST /api/extensions/version)', () => {
    test('version of a system extension name (regex) throws StApiError 404 (only third-party dirs are searched)', async () => {
        // Read src/endpoints/extensions.js: basePath is the user's (or global)
        // third-party directory - system extensions can never be versioned.
        await assert.rejects(
            () => api.version({ extensionName: 'regex' }),
            err => err instanceof StApiError && err.status === 404 && /Directory does not exist/.test(String(err.body)),
        );
    });

    test('version of another system extension name (quick-reply) also throws StApiError 404', async () => {
        await assert.rejects(
            () => api.version({ extensionName: 'quick-reply' }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('version of a nonexistent extension name throws StApiError 404', async () => {
        await assert.rejects(
            () => api.version({ extensionName: ghost }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('version without extensionName throws StApiError 400', async () => {
        await assert.rejects(
            () => api.version({}),
            err => err instanceof StApiError && err.status === 400 && /valid extensionName/.test(String(err.body)),
        );
    });

    // Happy path for a REAL third-party git extension (shape:
    // {currentBranchName, currentCommitHash, isUpToDate, remoteUrl}). Skipped:
    // this instance has no third-party extension installed and installing one
    // would mutate the user's setup; /install additionally clones from the
    // network. Non-git folders answer with empty-string fields + isUpToDate.
    test('version of an installed third-party git extension returns branch/commit/remote info', { skip: 'no third-party extension fixture without mutating user install' }, async () => {
        const res = await api.version({ extensionName: 'some-installed-extension' });
        assert.equal(typeof res.currentBranchName, 'string');
        assert.equal(typeof res.currentCommitHash, 'string');
        assert.equal(typeof res.isUpToDate, 'boolean');
        assert.equal(typeof res.remoteUrl, 'string');
    });
});

describe('ExtensionsApi.branches (POST /api/extensions/branches)', () => {
    test('branches of a nonexistent extension name throws StApiError 404', async () => {
        // Verified: the 404 check runs before any git command, so this probe
        // cannot mutate anything.
        await assert.rejects(
            () => api.branches({ extensionName: ghost }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('branches without extensionName throws StApiError 400', async () => {
        await assert.rejects(
            () => api.branches({}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    // Live success test SKIPPED: /branches unshallows the repo (fetch
    // --unshallow) and rewrites the origin fetch refspec on the user's
    // extension - a real mutation of the install.
    test('branches of an installed extension lists local and remote branches', { skip: 'unshallows/mutates the user extension git repo' }, async () => {
        const res = await api.branches({ extensionName: 'some-installed-extension' });
        assert.ok(Array.isArray(res));
        for (const branch of res) {
            assert.equal(typeof branch.name, 'string');
            assert.equal(typeof branch.commit, 'string');
            assert.equal(typeof branch.current, 'boolean');
            assert.equal(typeof branch.label, 'string');
        }
    });
});

describe('ExtensionsApi.update (POST /api/extensions/update)', () => {
    test('update of a nonexistent extension name throws StApiError 404', async () => {
        await assert.rejects(
            () => api.update({ extensionName: ghost }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('update without extensionName throws StApiError 400', async () => {
        await assert.rejects(
            () => api.update({}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    // Live success test SKIPPED: /update runs `git pull origin <branch>` on
    // the user's extension - a real mutation (code changes under a running
    // server).
    test('update of an installed extension pulls from origin and reports the new commit', { skip: 'git pull mutates the user extension install' }, async () => {
        const res = await api.update({ extensionName: 'some-installed-extension' });
        assert.equal(typeof res.shortCommitHash, 'string');
        assert.equal(res.shortCommitHash.length, 7);
        assert.equal(typeof res.isUpToDate, 'boolean');
        assert.equal(typeof res.remoteUrl, 'string');
    });
});

describe('ExtensionsApi.switch (POST /api/extensions/switch)', () => {
    test('switch of a nonexistent extension name throws StApiError 404', async () => {
        await assert.rejects(
            () => api.switch({ extensionName: ghost, branch: 'main' }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('switch without branch throws StApiError 400', async () => {
        await assert.rejects(
            () => api.switch({ extensionName: ghost }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('switch without extensionName throws StApiError 400', async () => {
        await assert.rejects(
            () => api.switch({ branch: 'main' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    // Live success test SKIPPED: /switch checks out another branch in the
    // user's extension working tree - a real mutation.
    test('switch checks out an existing local branch and answers 204 (null)', { skip: 'git checkout mutates the user extension install' }, async () => {
        const res = await api.switch({ extensionName: 'some-installed-extension', branch: 'main' });
        assert.equal(res, null, '204 No Content maps to null');
    });
});

describe('ExtensionsApi.move (POST /api/extensions/move)', () => {
    test('move of a nonexistent extension name throws StApiError 404', async () => {
        await assert.rejects(
            () => api.move({ extensionName: ghost, source: 'user', destination: 'global' }),
            err => err instanceof StApiError && err.status === 404 && /Source directory does not exist/.test(String(err.body)),
        );
    });

    test('move without source or destination throws StApiError 400', async () => {
        await assert.rejects(
            () => api.move({ extensionName: ghost }),
            err => err instanceof StApiError && err.status === 400,
        );
        await assert.rejects(
            () => api.move({ extensionName: ghost, source: 'user' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    // Live success test SKIPPED: /move copies+deletes the extension folder
    // between user and global directories (requires admin) - a real mutation.
    test('move relocates an extension between user and global scope and answers 204 (null)', { skip: 'relocates the user extension folder (admin-only mutation)' }, async () => {
        const res = await api.move({ extensionName: 'some-installed-extension', source: 'user', destination: 'global' });
        assert.equal(res, null, '204 No Content maps to null');
    });
});

describe('ExtensionsApi.delete (POST /api/extensions/delete)', () => {
    test('delete of a nonexistent extension name throws StApiError 404', async () => {
        // Verified: the existsSync guard runs before fs.rm, so probing a
        // __drvtest_ name cannot delete anything.
        await assert.rejects(
            () => api.delete({ extensionName: ghost }),
            err => err instanceof StApiError && err.status === 404,
        );
    });

    test('delete without extensionName throws StApiError 400', async () => {
        await assert.rejects(
            () => api.delete({}),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    // Live success test SKIPPED: /delete recursively removes the extension
    // directory - destructive on any real install. Only ever run it against a
    // throwaway clone created by /install in the same test.
    test('delete removes an installed extension folder', { skip: 'destructive: rm -rf on the user extension folder' }, async () => {
        const res = await api.delete({ extensionName: 'some-installed-extension' });
        assert.ok(String(res).includes('has been deleted'), 'success body is a plain-text confirmation');
    });
});
