/**
 * Bulk content cleaner: wipe characters, group chats, world info and chat logs
 * from a running SillyTavern instance.
 *
 * THIS IS DESTRUCTIVE AND IRREVERSIBLE. Safety design:
 *   - `plan()` never deletes anything; it only reports what WOULD be deleted.
 *   - `clean()` refuses to run unless `confirm === true`.
 *   - `protect` excludes entries by exact name or prefix. Protecting a character
 *     protects its chat logs too: "keep this card" that silently wipes its
 *     conversations would be a footgun. To keep every card but wipe all logs,
 *     use `scope:{characters:false}` with no protect list.
 *   - Deletion goes through the HTTP API (not the filesystem) so ST keeps its
 *     caches, thumbnails and tag maps consistent.
 *   - `clean()` executes the plan produced by `plan()` rather than re-deriving
 *     targets, so the preview and the action can never drift apart.
 *
 * Deletion order matters and is deliberate:
 *   1. groups      - deletes each group AND its group-chat files (cascade)
 *   2. characters  - with deleteChats:true also removes that character's chats
 *   3. chat logs   - only for characters that survive (protected / kept cards);
 *                    deleting the card already cascades its own logs
 *   4. world info  - independent, deleted last
 *
 * Note on dangling references: settings.json keeps `active_character`,
 * `active_group`, `tags` and `tag_map` entries pointing at deleted content. ST
 * tolerates those (it falls back on next load); this cleaner deliberately does
 * NOT rewrite settings.json, because guessing at user settings is riskier than
 * leaving a stale pointer. Use `scope.settings` (opt-in) only if you want the
 * active pointers cleared.
 */
import { CharactersApi } from '../api/characters.js';
import { GroupsApi } from '../api/groups.js';
import { WorldInfoApi } from '../api/worldinfo.js';
import { ChatsApi } from '../api/chats.js';

/** @typedef {'characters'|'groups'|'worldinfo'|'chats'|'settings'} CleanScopeKey */

/** Every scope enabled by default. */
export const DEFAULT_SCOPE = Object.freeze({
    characters: true,
    groups: true,
    worldinfo: true,
    chats: true,
    settings: false, // opt-in: clearing active_* pointers touches settings.json
});

/**
 * @typedef {object} CleanItem
 * @property {'group'|'character'|'chat'|'worldinfo'} kind
 * @property {string} id
 * @property {string} name
 * @property {string} [detail]
 * @property {'card'|'cascade'|'direct'} [via] how a `chat` gets removed:
 *   `card` = cascaded by deleting its character, `cascade` = by deleting its
 *   group, `direct` = a separate /api/chats/delete call
 *
 * @typedef {object} CleanReport
 * @property {boolean} dryRun
 * @property {boolean} confirmed
 * @property {{characters:number, groups:number, worldinfo:number, chats:number}} planned
 * @property {CleanItem[]} items
 * @property {{characters:number, groups:number, worldinfo:number, chats:number, settings:number}} deleted
 * @property {Array<{kind:string, id:string, name:string, error:string}>} failures
 * @property {string[]} protected_ entries skipped due to `protect`
 * @property {string[]} notes
 */

export class Cleaner {
    /**
     * @param {object} options
     * @param {import('./client.js').STClient} options.client a connected STClient
     * @param {object} [options.apis] pre-built API objects (for tests/injection)
     */
    constructor({ client, apis = {} }) {
        if (!client) throw new TypeError('Cleaner: a connected STClient is required');
        this.client = client;
        this.characters = apis.characters ?? new CharactersApi(client);
        this.groups = apis.groups ?? new GroupsApi(client);
        this.worldinfo = apis.worldinfo ?? new WorldInfoApi(client);
        this.chats = apis.chats ?? new ChatsApi(client);
    }

    /**
     * Match an entry name against the protect list (exact or prefix).
     * @param {string} name
     * @param {string[]} protect
     * @returns {string|null} the matching rule, or null
     */
    static isProtected(name, protect) {
        if (!Array.isArray(protect) || !protect.length) return null;
        const n = String(name ?? '');
        for (const rule of protect) {
            const r = String(rule);
            if (!r) continue;
            if (n === r || n.startsWith(r)) return r;
        }
        return null;
    }

    /**
     * Enumerate everything that WOULD be deleted, without deleting.
     *
     * Chat logs are listed even when they will be removed as a side effect of
     * deleting their character card (`via:'card'`) or group (`via:'cascade'`),
     * so `planned.chats` reflects the total volume of logs being destroyed rather
     * than only the subset needing a direct call.
     *
     * @param {object} [options]
     * @param {Partial<Record<CleanScopeKey,boolean>>} [options.scope] defaults to all
     *   content scopes on, `settings` off
     * @param {string[]} [options.protect] names/prefixes to exclude
     * @returns {Promise<CleanReport>}
     */
    async plan(options = {}) {
        const scope = { ...DEFAULT_SCOPE, ...(options.scope ?? {}) };
        const protect = options.protect ?? [];
        /** @type {CleanReport} */
        const report = {
            dryRun: true,
            confirmed: false,
            planned: { characters: 0, groups: 0, worldinfo: 0, chats: 0 },
            items: [],
            deleted: { characters: 0, groups: 0, worldinfo: 0, chats: 0, settings: 0 },
            failures: [],
            protected_: [],
            notes: [],
        };

        // --- groups (cascade-deletes their group chats) ---
        /** @type {Array<{id:string, name:string, protected_:boolean}>} */
        const groups = [];
        if (scope.groups) {
            for (const g of (await this.groups.all().catch(e => {
                report.notes.push(`groups.all() failed: ${e?.message ?? e}`);
                return [];
            })) ?? []) {
                const id = String(g.id ?? '');
                const name = String(g.name ?? id);
                if (!id) continue;
                const rule = Cleaner.isProtected(name, protect) ?? Cleaner.isProtected(id, protect);
                if (rule) {
                    report.protected_.push(`group:${name} (matched '${rule}')`);
                    groups.push({ id, name, protected_: true });
                    continue;
                }
                groups.push({ id, name, protected_: false });
                report.planned.groups++;
                report.items.push({
                    kind: 'group', id, name,
                    detail: `${(g.members ?? []).length} members, ${(g.chats ?? []).length} chats (cascade)`,
                });
            }
        }

        // --- characters ---
        // `keptBy` distinguishes WHY a card survives, because the two cases mean
        // opposite things for its chats:
        //   'protect' - the user asked to keep this card, so keep its logs too
        //   'scope'   - cards are out of scope but chats are in, so wipe the logs
        /** @type {Array<{avatar:string, name:string, deleting:boolean, keptBy:'protect'|'scope'|null}>} */
        const characters = [];
        if (scope.characters || scope.chats) {
            for (const c of (await this.characters.all().catch(e => {
                report.notes.push(`characters.all() failed: ${e?.message ?? e}`);
                return [];
            })) ?? []) {
                const avatar = String(c.avatar ?? '');
                const name = String(c.name ?? avatar);
                if (!avatar) continue;
                const rule = Cleaner.isProtected(name, protect) ?? Cleaner.isProtected(avatar, protect);
                if (rule) {
                    report.protected_.push(`character:${name} (matched '${rule}')`);
                    characters.push({ avatar, name, deleting: false, keptBy: 'protect' });
                    continue;
                }
                const deleting = scope.characters === true;
                characters.push({ avatar, name, deleting, keptBy: deleting ? null : 'scope' });
                if (deleting) {
                    report.planned.characters++;
                    report.items.push({
                        kind: 'character', id: avatar, name,
                        detail: scope.chats ? 'incl. its chat files (deleteChats)' : 'card only (chats kept)',
                    });
                }
            }
        }

        // --- chat logs ---
        // Listed for every character, whether or not the card itself goes. Chats
        // belonging to a card we delete come out as via:'card' (counted, not
        // separately deleted); chats of surviving-but-in-scope cards are
        // via:'direct'. Protected characters' logs are never listed.
        if (scope.chats) {
            for (const c of characters) {
                if (c.keptBy === 'protect') continue;
                const via = c.deleting ? 'card' : 'direct';
                let list = [];
                try {
                    list = await this.characters.chats(c.avatar, { simple: true }) ?? [];
                } catch (e) {
                    // "Nothing here" is NOT an error case and never throws: a card
                    // with no chat dir answers an empty array, and a missing card
                    // answers {error:true} at HTTP 200. Both are handled below. So
                    // any throw is a genuine failure - report it rather than
                    // filtering on the message text (a loose /error|404/ match
                    // silently swallowed real 500s).
                    report.notes.push(`chats of ${c.name} failed: ${e?.message ?? e}`);
                    continue;
                }
                if (!Array.isArray(list) || list.error) continue;
                for (const chat of list) {
                    const fileName = chat.file_name ?? chat.fileName;
                    if (!fileName) continue;
                    report.planned.chats++;
                    report.items.push({
                        kind: 'chat', id: `${c.avatar}::${fileName}`, via,
                        name: `${c.name} / ${fileName}`,
                        detail: `${chat.chat_items ?? '?'} messages` +
                            (via === 'card' ? ' (removed with its card)' : ''),
                    });
                }
            }
        }

        // --- world info ---
        if (scope.worldinfo) {
            for (const w of (await this.worldinfo.list().catch(e => {
                report.notes.push(`worldinfo.list() failed: ${e?.message ?? e}`);
                return [];
            })) ?? []) {
                // `||` not `??`: ST answers an EMPTY name for a book whose JSON has
                // no name field, and `'' ?? x` yields '' rather than falling back.
                const name = String(w.name || w.file_id || '');
                if (!name) continue;
                const rule = Cleaner.isProtected(name, protect);
                if (rule) { report.protected_.push(`worldinfo:${name} (matched '${rule}')`); continue; }
                report.planned.worldinfo++;
                report.items.push({ kind: 'worldinfo', id: name, name });
            }
        }

        if (scope.settings) {
            report.notes.push('scope.settings is ON: active_character/active_group/tag_map references will be cleared');
        }

        return report;
    }

    /**
     * Delete content. Refuses unless `confirm === true`.
     *
     * Executes the plan from `plan()`, so the report's `planned` counts are the
     * same numbers you saw in the dry run.
     *
     * @param {object} [options]
     * @param {boolean} [options.confirm=false] MUST be true to actually delete
     * @param {Partial<Record<CleanScopeKey,boolean>>} [options.scope]
     * @param {string[]} [options.protect]
     * @param {string} [options.requirePrefix] fail-closed guardrail: every target
     *   name/id MUST start with this prefix or `clean()` throws BEFORE deleting
     *   anything. Independent of `protect`, so a bug in the protect logic cannot
     *   turn into data loss while this is set. Intended for test runs against an
     *   instance that also holds real user content.
     * @param {(progress:{phase:string, done:number, total:number, name:string})=>void} [options.onProgress]
     * @returns {Promise<CleanReport>}
     * @throws {Error} when confirm is not true, or when `requirePrefix` is set and
     *   some planned target does not match it
     */
    async clean(options = {}) {
        const plan = await this.plan(options);

        if (options.confirm !== true) {
            return {
                ...plan,
                dryRun: true,
                confirmed: false,
                notes: [
                    'NOTHING WAS DELETED: pass confirm:true to execute.',
                    ...plan.notes,
                ],
            };
        }

        // Guardrail check happens BEFORE any deletion, and aborts the whole run
        // rather than skipping the offender - a silent skip would hide the very
        // bug this guard exists to catch.
        const requirePrefix = options.requirePrefix;
        if (requirePrefix) {
            const offenders = plan.items.filter(i =>
                !String(i.name).startsWith(requirePrefix) && !String(i.id).startsWith(requirePrefix));
            if (offenders.length) {
                const err = new Error(
                    `Cleaner: refusing to delete ${offenders.length} target(s) that do not start with ` +
                    `'${requirePrefix}': ${offenders.slice(0, 5).map(i => `${i.kind}:${i.name}`).join(', ')}` +
                    (offenders.length > 5 ? ', ...' : ''),
                );
                err.code = 'E_CLEAN_PREFIX_VIOLATION';
                err.offenders = offenders;
                throw err;
            }
        }

        const scope = { ...DEFAULT_SCOPE, ...(options.scope ?? {}) };
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
        /** @type {CleanReport} */
        const report = {
            ...plan,
            dryRun: false,
            confirmed: true,
            deleted: { characters: 0, groups: 0, worldinfo: 0, chats: 0, settings: 0 },
            failures: [],
            notes: [...plan.notes],
        };

        /** Emit progress for one deletion step. */
        const step = (phase, done, total, name) => onProgress({ phase, done, total, name });

        // 1) groups first: deleting a group also removes its group-chat files.
        const groupTargets = plan.items.filter(i => i.kind === 'group');
        for (const g of groupTargets) {
            try {
                await this.groups.delete(g.id);
                report.deleted.groups++;
                step('groups', report.deleted.groups, groupTargets.length, g.name);
            } catch (e) {
                report.failures.push({ kind: 'group', id: g.id, name: g.name, error: String(e?.message ?? e) });
            }
        }

        // 2) characters, with their own chats cascading when scope.chats is on.
        //    A cascade still destroys those logs, so they count towards
        //    deleted.chats - otherwise the report would claim `planned.chats`
        //    were never removed.
        const charTargets = plan.items.filter(i => i.kind === 'character');
        for (const c of charTargets) {
            try {
                await this.characters.delete(c.id, { deleteChats: scope.chats !== false });
                report.deleted.characters++;
                report.deleted.chats += plan.items.filter(i =>
                    i.kind === 'chat' && i.via === 'card' && i.id.startsWith(`${c.id}::`)).length;
                step('characters', report.deleted.characters, charTargets.length, c.name);
            } catch (e) {
                report.failures.push({ kind: 'character', id: c.id, name: c.name, error: String(e?.message ?? e) });
            }
        }

        // 3) chat logs of characters that survived the card deletion.
        const chatTargets = plan.items.filter(i => i.kind === 'chat' && i.via === 'direct');
        for (const t of chatTargets) {
            const [avatarUrl, chatFile] = [t.id.slice(0, t.id.indexOf('::')), t.id.slice(t.id.indexOf('::') + 2)];
            try {
                await this.chats.delete({ avatarUrl, chatFile });
                report.deleted.chats++;
                step('chats', report.deleted.chats, chatTargets.length, chatFile);
            } catch (e) {
                report.failures.push({ kind: 'chat', id: t.id, name: t.name, error: String(e?.message ?? e) });
            }
        }

        // 4) world info books.
        const worldTargets = plan.items.filter(i => i.kind === 'worldinfo');
        for (const w of worldTargets) {
            try {
                await this.worldinfo.delete(w.id);
                report.deleted.worldinfo++;
                step('worldinfo', report.deleted.worldinfo, worldTargets.length, w.name);
            } catch (e) {
                // ST answers 500 when the file is already gone; report it, don't hide it.
                report.failures.push({ kind: 'worldinfo', id: w.id, name: w.name, error: String(e?.message ?? e) });
            }
        }

        // 5) optional: clear dangling pointers in settings.json
        if (scope.settings) {
            try {
                const settings = await this.#clearActivePointers();
                report.deleted.settings = settings ? 1 : 0;
                if (settings) report.notes.push('settings.json active_character/active_group/tag_map cleared');
            } catch (e) {
                report.failures.push({ kind: 'settings', id: 'settings.json', name: 'settings', error: String(e?.message ?? e) });
            }
        }

        return report;
    }

    /**
     * Clear active_character / active_group and prune tag_map entries that no
     * longer resolve. Only used when scope.settings is explicitly enabled.
     * @returns {Promise<boolean>} true when settings were rewritten
     */
    async #clearActivePointers() {
        const envelope = await this.client.post('/api/settings/get', {});
        const settings = JSON.parse(envelope.settings);
        let changed = false;

        if (settings.active_character) { settings.active_character = null; changed = true; }
        if (settings.active_group && Object.keys(settings.active_group).length) {
            settings.active_group = {}; changed = true;
        }
        // tag_map: { avatarUrl -> [tagIds] }; drop keys whose card is gone.
        if (settings.tag_map && typeof settings.tag_map === 'object') {
            const remaining = new Set(((await this.characters.all().catch(() => [])) ?? []).map(c => String(c.avatar)));
            const before = Object.keys(settings.tag_map).length;
            for (const key of Object.keys(settings.tag_map)) {
                if (!remaining.has(key)) { delete settings.tag_map[key]; }
            }
            if (Object.keys(settings.tag_map).length !== before) changed = true;
        }
        // NOTE: personas, user_avatar and power_user.* are deliberately untouched -
        // they are not content this cleaner is asked to wipe.

        if (!changed) return false;
        await this.client.post('/api/settings/save', settings);
        return true;
    }
}
