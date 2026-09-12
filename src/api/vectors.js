/**
 * Vector storage API wrapper for the SillyTavern server (ST 1.18.0).
 *
 * Routes live under /api/vector/* (all POST). Backed by vectra LocalIndex
 * stores under <user>/vectors/<source>/<collectionId>/<model>/. Verified
 * against the server source (src/endpoints/vectors.js) AND a live server.
 *
 * Model: a collection holds items { vector, metadata: { hash, text, index } }.
 * The `hash` is an arbitrary NUMBER chosen by the caller (the ST frontend uses
 * cyrb128 of the message text, but the server stores whatever number it is
 * given). insert() embeds each item's text with the configured embedding
 * source (default 'transformers' = local ONNX model from config.yaml
 * extensions.models.embedding).
 *
 * Live quirks (all verified against ST 1.18.0):
 * - Missing parameters answer 400 here (other ST modules often 500).
 * - The wrapper ALWAYS sends an explicit `source`. The server computes
 *   String(req.body.source) || 'transformers', so a truly omitted source
 *   becomes the literal string 'undefined': inserts then fail with 500
 *   ('Unknown vector source undefined') after creating a junk
 *   vectors/undefined/ directory, while list/query silently operate on that
 *   junk store. Sending 'transformers' explicitly avoids all of this.
 * - list()/query()/queryMulti() on an UNKNOWN collectionId answer 200 with
 *   []/empty results AND create an empty index directory on disk (getIndex
 *   auto-creates). purge() such a collection afterwards to remove the dir.
 * - query(): `hashes` contains ALL topK results (threshold NOT applied),
 *   `metadata` only those with score >= threshold, so hashes.length >=
 *   metadata.length. queryMulti() applies the threshold to BOTH arrays.
 * - queryMulti() omits collections with zero surviving results from the
 *   response object entirely.
 * - delete() of unknown hashes is a silent no-op (200).
 * - purge() removes the collection directory under EVERY source; purging an
 *   unknown collection is a 200 no-op. purgeAll() wipes every source store of
 *   the user - catastrophic on a live instance.
 * - First embedding call after a server start loads the ONNX model (seconds);
 *   if the model is missing from data/_cache and huggingface.co is
 *   unreachable, every embedding call 500s after ~11s ('fetch failed' is
 *   swallowed into a bare 500).
 */

const VEC_BASE = '/api/vector';

/**
 * Wrapper around the SillyTavern vector (embedding) endpoints.
 */
export class VectorsApi {
    /**
     * @param {import('../core/client.js').STClient} client connected ST client
     */
    constructor(client) {
        this.client = client;
    }

    /**
     * Embed and insert items into a collection (creating it on first use).
     * Items with an already-present hash are upserted (replaced).
     * Endpoint: POST /api/vector/insert { collectionId, items, source? }.
     *
     * @param {object} params
     * @param {string} params.collectionId collection name (any string; the
     * server sanitizes it into a directory name)
     * @param {{hash: number, text: string, index: number}[]} params.items
     * items to embed; `hash` MUST be a number (list/delete match numerically)
     * @param {string} [params.source='transformers'] embedding source (one of
     * the server's SOURCES: transformers, openai, ollama, ...); always sent
     * explicitly - see the module header for the String(undefined) quirk
     * @returns {Promise<string>} the plain-text 'OK' status body
     * @throws {import('../core/client.js').StApiError} 400 when items is not
     * an array or collectionId is missing; 500 when embedding fails (unknown
     * source, missing model, unreachable provider)
     */
    async insert({ collectionId, items, source = 'transformers' } = {}) {
        return await this.client.postRaw(`${VEC_BASE}/insert`, { collectionId, items, source });
    }

    /**
     * List the hashes of all items stored in a collection.
     * Endpoint: POST /api/vector/list { collectionId, source? }.
     *
     * @param {object} params
     * @param {string} params.collectionId
     * @param {string} [params.source='transformers']
     * @returns {Promise<number[]>} stored hashes (order is vectra's internal
     * item order, not insertion order); [] for an empty or unknown collection
     * (an unknown one is created empty on disk as a side effect)
     * @throws {import('../core/client.js').StApiError} 400 when collectionId
     * is missing; 500 on a corrupted index the server could not regenerate
     */
    async list({ collectionId, source = 'transformers' } = {}) {
        return await this.client.post(`${VEC_BASE}/list`, { collectionId, source });
    }

    /**
     * Embed searchText and query one collection for the nearest items.
     * Endpoint: POST /api/vector/query { collectionId, searchText, topK?,
     * threshold?, source? }.
     *
     * @param {object} params
     * @param {string} params.collectionId
     * @param {string} params.searchText query text to embed
     * @param {number} [params.topK=10] maximum number of results
     * @param {number} [params.threshold=0] minimum cosine similarity for the
     * metadata list (NOT applied to hashes - see module header)
     * @param {string} [params.source='transformers']
     * @returns {Promise<{hashes: number[], metadata: {hash: number, text: string,
     * index: number}[]}>} hashes: topK by descending score (unfiltered);
     * metadata: only items with score >= threshold
     * @throws {import('../core/client.js').StApiError} 400 when collectionId
     * or searchText is missing; 500 when embedding the query fails
     */
    async query({ collectionId, searchText, topK, threshold, source = 'transformers' } = {}) {
        const body = { collectionId, searchText, source };
        if (topK !== undefined) body.topK = topK;
        if (threshold !== undefined) body.threshold = threshold;
        return await this.client.post(`${VEC_BASE}/query`, body);
    }

    /**
     * Query several collections at once with a single embedded searchText.
     * The server merges all per-collection topK results, sorts by descending
     * score, applies the threshold and keeps the overall topK, then regroups
     * them by collection.
     * Endpoint: POST /api/vector/query-multi { collectionIds, searchText,
     * topK?, threshold?, source? }.
     *
     * @param {object} params
     * @param {string[]} params.collectionIds collections to search
     * @param {string} params.searchText query text to embed
     * @param {number} [params.topK=10] maximum number of results OVERALL
     * @param {number} [params.threshold=0] minimum score (applied to hashes
     * AND metadata here, unlike query())
     * @param {string} [params.source='transformers']
     * @returns {Promise<Record<string, {hashes: number[], metadata: object[]}>>}
     * results keyed by collectionId; collections with no surviving result are
     * omitted entirely
     * @throws {import('../core/client.js').StApiError} 400 when collectionIds
     * is not an array or searchText is missing; 500 when embedding fails
     */
    async queryMulti({ collectionIds, searchText, topK, threshold, source = 'transformers' } = {}) {
        const body = { collectionIds, searchText, source };
        if (topK !== undefined) body.topK = topK;
        if (threshold !== undefined) body.threshold = threshold;
        return await this.client.post(`${VEC_BASE}/query-multi`, body);
    }

    /**
     * Delete items from a collection by hash. Unknown hashes are skipped
     * silently.
     * Endpoint: POST /api/vector/delete { collectionId, hashes, source? }.
     *
     * @param {object} params
     * @param {string} params.collectionId
     * @param {number[]} params.hashes item hashes to remove (matched as
     * numbers via a strict $in filter - insert them as numbers too)
     * @param {string} [params.source='transformers']
     * @returns {Promise<string>} the plain-text 'OK' status body
     * @throws {import('../core/client.js').StApiError} 400 when hashes is not
     * an array or collectionId is missing
     */
    async delete({ collectionId, hashes, source = 'transformers' } = {}) {
        return await this.client.postRaw(`${VEC_BASE}/delete`, { collectionId, hashes, source });
    }

    /**
     * Delete one collection under EVERY embedding source (removes the
     * directory tree <source>/<collectionId>/ for all sources). Purging an
     * unknown collection is a 200 no-op.
     * Endpoint: POST /api/vector/purge { collectionId }.
     *
     * @param {object} params
     * @param {string} params.collectionId
     * @returns {Promise<string>} the plain-text 'OK' status body
     * @throws {import('../core/client.js').StApiError} 400 when collectionId
     * is missing; 500 when a directory could not be removed
     */
    async purge({ collectionId } = {}) {
        return await this.client.postRaw(`${VEC_BASE}/purge`, { collectionId });
    }

    /**
     * Delete EVERY vector store of the user across ALL embedding sources
     * (the whole vectors/ tree). DESTRUCTIVE: all chat/lorebook embeddings
     * must be rebuilt afterwards. There is no confirmation and no undo.
     * Endpoint: POST /api/vector/purge-all (no body).
     *
     * @returns {Promise<string>} the plain-text 'OK' status body
     * @throws {import('../core/client.js').StApiError} 500 when a directory
     * could not be removed
     */
    async purgeAll() {
        return await this.client.postRaw(`${VEC_BASE}/purge-all`, {});
    }
}
