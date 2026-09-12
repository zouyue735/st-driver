/**
 * LIVE integration tests for VectorsApi (src/api/vectors.js), backed by
 * /api/vector/* on ST 1.18.0.
 *
 * Everything runs inside throwaway `__drvtest_vec_*` collections that are
 * purged in after(). purgeAll() is implemented but NEVER called here: it
 * deletes EVERY vector store of the user (all sources, all collections).
 *
 * Embedding backend: source 'transformers' (local ONNX model, configured via
 * config.yaml `extensions.models.embedding`; 'Cohee/jina-embeddings-v2-base-en'
 * on this instance). The FIRST embedding call after a server start loads the
 * model (~10s); later calls are ~1s. Tests use generous timeouts. If the model
 * is not in data/_cache and the server cannot reach huggingface.co, every
 * embedding call 500s after ~11s with no useful message (fetch failed).
 *
 * Live quirks verified against ST 1.18.0:
 * - Missing/invalid parameters answer 400 in this module (unlike many other
 *   ST endpoints that 500 on missing fields).
 * - query(): `hashes` holds ALL topK results (threshold NOT applied), while
 *   `metadata` only holds results with score >= threshold - so
 *   hashes.length >= metadata.length. queryMulti() applies the threshold to
 *   BOTH arrays (they are built from the same filtered result set).
 * - query()/queryMulti()/list() on an UNKNOWN collectionId silently CREATE an
 *   empty vectra index directory on disk (getIndex auto-creates) instead of
 *   404ing. Tests therefore purge every collection id they merely touched.
 * - purge() of an unknown collection is a 200 no-op (it only rm -rf's
 *   existing per-source directories).
 * - insert() item `hash` values must be NUMBERS: the server stores them
 *   verbatim in vectra metadata, list() coerces with Number(), and delete()
 *   matches with a strict $in against Number(x) - a string hash would insert
 *   and list fine but never delete. Any distinct numbers work (the frontend
 *   uses cyrb128 of the message text, but the server does not care).
 * - queryMulti() OMITS collections with no surviving results from the
 *   response object entirely (no empty {hashes:[],metadata:[]} entry).
 * - Similarity scores with jina-embeddings-v2 (no query prefix support in the
 *   ST endpoint): an exact-text query scores >= 0.99, but loose paraphrases
 *   rank poorly. Semantic assertions therefore use the exact stored text.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VectorsApi } from '../../src/api/vectors.js';
import { StApiError } from '../../src/core/client.js';
import { newClient, fixtureName } from '../helpers.js';

let client;
let api;

/** Main fixture collection: 3 semantically distinct texts. */
let col;
/** Second collection for queryMulti (holds a copy of the cat text). */
let colB;
/** Every collection id the tests touched (even via failed/list-only calls). */
const touched = new Set();

const ITEMS = [
    { hash: 101, text: 'The cat sat on the mat and purred softly', index: 0 },
    { hash: 102, text: 'Quantum physics explains particle entanglement and wave functions', index: 1 },
    { hash: 103, text: 'Baking bread requires flour yeast water and salt', index: 2 },
];
const CAT_TEXT = ITEMS[0].text;

/** Track a collection id so after() purges it. */
function useCol(id) {
    touched.add(id);
    return id;
}

before(async () => {
    client = await newClient();
    api = new VectorsApi(client);
    col = useCol(fixtureName('vec'));
    colB = useCol(`${col}_b`);
    // Warm up the pipeline + populate the main collection once for the
    // read-only list/query tests.
    await api.insert({ collectionId: col, items: ITEMS });
});

after(async () => {
    // Purge every collection the tests created OR merely referenced (list/
    // query silently create empty index directories for unknown ids).
    for (const id of touched) {
        await api.purge({ collectionId: id }).catch(() => {});
    }
    await client?.close();
});

describe('VectorsApi.insert (POST /api/vector/insert)', () => {
    test("insert 3 items answers the 'OK' status text (200)", async t => {
        t.timeout = 180_000;
        const c = useCol(`${col}_ins`);
        const res = await api.insert({ collectionId: c, items: ITEMS });
        assert.equal(res, 'OK', 'sendStatus(200) answers the plain text "OK"');
    });

    test('insert stores arbitrary numeric hashes verbatim (no server-side hash generation)', async t => {
        t.timeout = 180_000;
        const c = useCol(`${col}_hash`);
        await api.insert({
            collectionId: c,
            items: [
                { hash: 1, text: 'first tiny text', index: 0 },
                { hash: 987654321, text: 'second tiny text', index: 1 },
                { hash: -42, text: 'third tiny text', index: 2 },
            ],
        });
        const hashes = await api.list({ collectionId: c });
        assert.deepEqual(hashes.sort((a, b) => a - b), [-42, 1, 987654321]);
    });

    test('insert with an explicit source transformers behaves like the default', async t => {
        t.timeout = 180_000;
        const c = useCol(`${col}_src`);
        const res = await api.insert({ collectionId: c, items: [{ hash: 7, text: 'explicit source text', index: 0 }], source: 'transformers' });
        assert.equal(res, 'OK');
        assert.deepEqual(await api.list({ collectionId: c }), [7]);
    });

    test('insert without items throws StApiError 400', async () => {
        await assert.rejects(
            () => api.insert({ collectionId: col }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('insert without collectionId throws StApiError 400', async () => {
        await assert.rejects(
            () => api.insert({ items: ITEMS }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('VectorsApi.list (POST /api/vector/list)', () => {
    test('list returns exactly the 3 inserted numeric hashes', async () => {
        const hashes = await api.list({ collectionId: col });
        assert.ok(Array.isArray(hashes));
        assert.deepEqual([...hashes].sort((a, b) => a - b), [101, 102, 103]);
        assert.ok(hashes.every(h => typeof h === 'number'));
    });

    test('list of an unknown collection returns [] (quirk: it also creates an empty index on disk)', async () => {
        const ghost = useCol(`${col}_ghostlist`);
        assert.deepEqual(await api.list({ collectionId: ghost }), []);
    });

    test('list without collectionId throws StApiError 400', async () => {
        await assert.rejects(
            () => api.list({}),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('VectorsApi.query (POST /api/vector/query)', () => {
    test('query with the exact stored text ranks its hash first and returns all topK hashes', async t => {
        t.timeout = 180_000;
        const res = await api.query({ collectionId: col, searchText: CAT_TEXT });
        assert.ok(Array.isArray(res.hashes));
        assert.ok(Array.isArray(res.metadata));
        assert.equal(res.hashes[0], 101, 'the semantically identical text must rank first');
        assert.equal(res.hashes.length, 3, 'default topK (10) covers the whole collection');
        assert.deepEqual(res.metadata[0], { hash: 101, text: CAT_TEXT, index: 0 });
    });

    test('query applies threshold to metadata only - hashes stay unfiltered (quirk)', async t => {
        t.timeout = 180_000;
        // Exact-text similarity with jina-v2 measures >= 0.99 (verified live);
        // everything else scores far below 0.5.
        const res = await api.query({ collectionId: col, searchText: CAT_TEXT, threshold: 0.9 });
        assert.deepEqual(res.metadata.map(m => m.hash), [101]);
        assert.equal(res.hashes.length, 3, 'hashes ignores the threshold');
        assert.equal(res.hashes[0], 101);
    });

    test('query respects topK', async t => {
        t.timeout = 180_000;
        const res = await api.query({ collectionId: col, searchText: CAT_TEXT, topK: 1 });
        assert.deepEqual(res.hashes, [101]);
        assert.equal(res.metadata.length, 1);
    });

    test('query with an explicit source matches the default', async t => {
        t.timeout = 180_000;
        const res = await api.query({ collectionId: col, searchText: CAT_TEXT, topK: 1, source: 'transformers' });
        assert.deepEqual(res.hashes, [101]);
    });

    test('query without searchText throws StApiError 400', async () => {
        await assert.rejects(
            () => api.query({ collectionId: col }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('query without collectionId throws StApiError 400', async () => {
        await assert.rejects(
            () => api.query({ searchText: 'anything' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('VectorsApi.queryMulti (POST /api/vector/query-multi)', () => {
    test('queryMulti searches several collections at once and groups results by collectionId', async t => {
        t.timeout = 180_000;
        await api.insert({
            collectionId: colB,
            items: [
                { hash: 201, text: CAT_TEXT, index: 0 },
                { hash: 202, text: 'A completely unrelated sentence about orbital mechanics', index: 1 },
            ],
        });
        const res = await api.queryMulti({
            collectionIds: [col, colB],
            searchText: CAT_TEXT,
            topK: 10,
            threshold: 0.9,
        });
        assert.equal(typeof res, 'object');
        assert.ok(res[col], `results for ${col} must be present`);
        assert.ok(res[colB], `results for ${colB} must be present`);
        // In queryMulti the threshold filters BOTH hashes and metadata.
        assert.deepEqual(res[col].hashes, [101]);
        assert.deepEqual(res[colB].hashes, [201]);
        assert.deepEqual(res[colB].metadata.map(m => m.hash), [201]);
    });

    test('queryMulti omits collections with no surviving results and answers {} for an unknown collection', async t => {
        t.timeout = 180_000;
        const ghost = useCol(`${col}_multighost`);
        const res = await api.queryMulti({ collectionIds: [ghost], searchText: CAT_TEXT });
        assert.deepEqual(res, {}, 'unknown/empty collections contribute no key');
    });

    test('queryMulti without collectionIds throws StApiError 400', async () => {
        await assert.rejects(
            () => api.queryMulti({ searchText: 'anything' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('queryMulti with a non-array collectionIds throws StApiError 400', async () => {
        await assert.rejects(
            () => api.queryMulti({ collectionIds: col, searchText: 'anything' }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('queryMulti without searchText throws StApiError 400', async () => {
        await assert.rejects(
            () => api.queryMulti({ collectionIds: [col] }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('VectorsApi.delete (POST /api/vector/delete)', () => {
    test('delete removes only the items whose numeric hashes were given', async t => {
        t.timeout = 180_000;
        const c = useCol(`${col}_del`);
        await api.insert({ collectionId: c, items: ITEMS });
        const res = await api.delete({ collectionId: c, hashes: [102] });
        assert.equal(res, 'OK');
        const remaining = await api.list({ collectionId: c });
        assert.deepEqual([...remaining].sort((a, b) => a - b), [101, 103]);
    });

    test('delete of several hashes at once removes all of them', async t => {
        t.timeout = 180_000;
        const c = useCol(`${col}_del2`);
        await api.insert({ collectionId: c, items: ITEMS });
        await api.delete({ collectionId: c, hashes: [101, 103] });
        assert.deepEqual(await api.list({ collectionId: c }), [102]);
    });

    test('delete of an unknown hash is a silent no-op (200, collection unchanged)', async t => {
        t.timeout = 180_000;
        const c = useCol(`${col}_del3`);
        await api.insert({ collectionId: c, items: [ITEMS[0]] });
        assert.equal(await api.delete({ collectionId: c, hashes: [999999] }), 'OK');
        assert.deepEqual(await api.list({ collectionId: c }), [101]);
    });

    test('delete without hashes throws StApiError 400', async () => {
        await assert.rejects(
            () => api.delete({ collectionId: col }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('delete with a non-array hashes throws StApiError 400', async () => {
        await assert.rejects(
            () => api.delete({ collectionId: col, hashes: 101 }),
            err => err instanceof StApiError && err.status === 400,
        );
    });

    test('delete without collectionId throws StApiError 400', async () => {
        await assert.rejects(
            () => api.delete({ hashes: [101] }),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('VectorsApi.purge (POST /api/vector/purge)', () => {
    test('purge empties the collection across all sources (list afterwards is [])', async t => {
        t.timeout = 180_000;
        const c = useCol(`${col}_purge`);
        await api.insert({ collectionId: c, items: [ITEMS[0]] });
        assert.deepEqual(await api.list({ collectionId: c }), [101]);
        const res = await api.purge({ collectionId: c });
        assert.equal(res, 'OK');
        // NOTE: this list call recreates an empty index dir for c (quirk);
        // after() purges it again.
        assert.deepEqual(await api.list({ collectionId: c }), []);
    });

    test("purge of an unknown collection is a 200 no-op ('OK')", async () => {
        const ghost = useCol(`${col}_purgeghost`);
        assert.equal(await api.purge({ collectionId: ghost }), 'OK');
    });

    test('purge without collectionId throws StApiError 400', async () => {
        await assert.rejects(
            () => api.purge({}),
            err => err instanceof StApiError && err.status === 400,
        );
    });
});

describe('VectorsApi.purgeAll (POST /api/vector/purge-all)', () => {
    // Implemented, but NEVER run live: it rm -rf's every vector store of the
    // user across ALL embedding sources (the whole vectors/ directory tree),
    // destroying real chat/lorebook embeddings that would have to be rebuilt.
    test("purgeAll deletes every vector store of every source ('OK')", { skip: 'destroys ALL user vector stores' }, async () => {
        const res = await api.purgeAll();
        assert.equal(res, 'OK');
    });
});

describe('VectorsApi end-to-end lifecycle', () => {
    test('insert -> list -> query -> queryMulti -> delete -> purge leaves the collection empty', async t => {
        t.timeout = 300_000;
        const c = useCol(`${col}_e2e`);
        await api.insert({ collectionId: c, items: ITEMS });
        assert.deepEqual([...(await api.list({ collectionId: c }))].sort((a, b) => a - b), [101, 102, 103]);

        const q = await api.query({ collectionId: c, searchText: CAT_TEXT, topK: 3 });
        assert.equal(q.hashes[0], 101);

        const multi = await api.queryMulti({ collectionIds: [c], searchText: CAT_TEXT, topK: 3, threshold: 0.9 });
        assert.deepEqual(multi[c].hashes, [101]);

        await api.delete({ collectionId: c, hashes: [101, 102] });
        assert.deepEqual(await api.list({ collectionId: c }), [103]);

        assert.equal(await api.purge({ collectionId: c }), 'OK');
        assert.deepEqual(await api.list({ collectionId: c }), []);
    });
});
