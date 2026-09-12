#!/usr/bin/env node
/**
 * Safety net: delete every __drvtest_-prefixed fixture from a live ST instance
 * (characters incl. chats, groups, worlds, backgrounds, personas/avatars, chat
 * backups) and - when ST_DATA_ROOT is set - filesystem-only residue that no
 * HTTP endpoint can remove (sprite dirs, image subfolders, movingUI presets).
 *
 * Usage:
 *   node tools/purge-fixtures.js [--url http://localhost:8000] [--dry]
 *   ST_DATA_ROOT=<root>/data/default-user node tools/purge-fixtures.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { STClient } from '../src/core/client.js';

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const BASE_URL = urlIdx >= 0 ? args[urlIdx + 1] : process.env.ST_URL ?? 'http://localhost:8000';
const DRY = args.includes('--dry');
const PREFIX = '__drvtest_';

const client = new STClient({ baseUrl: BASE_URL });
await client.connect();

const report = { characters: [], groups: [], worlds: [], backgrounds: [], avatars: [], backups: [], settingsMarker: false };

// characters (delete_chats: true removes their chat files too)
const chars = await client.post('/api/characters/all', {});
for (const c of chars ?? []) {
    if (String(c.name ?? '').startsWith(PREFIX) || String(c.avatar ?? '').startsWith(PREFIX)) {
        report.characters.push(c.avatar);
        if (!DRY) await client.post('/api/characters/delete', { avatar_url: c.avatar, delete_chats: true }).catch(e => console.error('char delete failed:', c.avatar, e.message));
    }
}

// groups (cascade-deletes group chats)
const groups = await client.post('/api/groups/all', {});
for (const g of groups ?? []) {
    if (String(g.name ?? '').startsWith(PREFIX)) {
        report.groups.push(g.name);
        if (!DRY) await client.post('/api/groups/delete', { id: g.id }).catch(e => console.error('group delete failed:', g.name, e.message));
    }
}

// world info books
const worlds = await client.post('/api/worldinfo/list', {});
for (const w of worlds ?? []) {
    if (String(w.name ?? '').startsWith(PREFIX)) {
        report.worlds.push(w.name);
        if (!DRY) await client.post('/api/worldinfo/delete', { name: w.name }).catch(e => console.error('world delete failed:', w.name, e.message));
    }
}

// backgrounds
const { images } = await client.post('/api/backgrounds/all', {});
for (const img of images ?? []) {
    if (String(img.filename ?? '').startsWith(PREFIX)) {
        report.backgrounds.push(img.filename);
        if (!DRY) await client.post('/api/backgrounds/delete', { bg: img.filename }).catch(e => console.error('bg delete failed:', img.filename, e.message));
    }
}

// chat backups ST auto-creates when tests save/delete chats
// (server prefixes them 'chat_'; fixtures carry the __drvtest_ marker inside)
try {
    const backups = await client.post('/api/backups/chat/get', {});
    for (const b of backups ?? []) {
        const name = String(b.file_name ?? b.name ?? '');
        if (name.includes('drvtest')) {
            report.backups.push(name);
            if (!DRY) {
                // the server checks fs.existsSync(<name>) - pass the FULL file name
                await client.post('/api/backups/chat/delete', { name })
                    .catch(e => console.error('backup delete failed:', name, e.message));
            }
        }
    }
} catch (e) {
    console.error('backups scan failed:', e.message);
}

// persona avatars + their settings metadata
// (avatar filenames are `<timestamp>-<sanitized persona name>.png`; sanitized
// fixture names keep the `drvtest` marker with underscores possibly stripped)
const avatars = await client.post('/api/avatars/get', {});
const fixtureAvatars = (avatars ?? []).filter(a => String(a).startsWith(PREFIX) || /-drvtest/i.test(String(a)));
const env = await client.post('/api/settings/get', {});
const settings = JSON.parse(env.settings);
let settingsDirty = false;
for (const a of fixtureAvatars) {
    report.avatars.push(a);
    if (!DRY) {
        await client.post('/api/avatars/delete', { avatar: a }).catch(e => console.error('avatar delete failed:', a, e.message));
        if (settings.power_user?.personas?.[a] !== undefined) {
            delete settings.power_user.personas[a];
            delete settings.power_user?.persona_descriptions?.[a];
            settingsDirty = true;
        }
    }
}
// Filesystem-only residue that no HTTP endpoint can remove:
//   characters/<name>/   sprite directories created by sprites upload tests
//   user/images/<dir>/   image subfolders created by images tests (images/list
//                        even creates the folder as a side effect)
//   movingUI/<name>.json movingUI presets have NO delete endpoint (404)
// Requires ST_DATA_ROOT to point at the server's data/default-user directory.
const dataRoot = (process.env.ST_DATA_ROOT ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
if (dataRoot && fs.existsSync(dataRoot)) {
    const fsTargets = [
        { rel: 'characters', kind: 'dir' },
        { rel: 'user/images', kind: 'dir' },
        { rel: 'movingUI', kind: 'file', ext: '.json' },
        { rel: 'sprites', kind: 'dir' },
    ];
    for (const target of fsTargets) {
        const dir = path.join(dataRoot, target.rel);
        if (!fs.existsSync(dir)) continue;
        for (const entry of fs.readdirSync(dir)) {
            if (!entry.includes('drvtest')) continue;
            if (target.kind === 'file' && !entry.endsWith(target.ext ?? '')) continue;
            report.fs = report.fs ?? [];
            report.fs.push(`${target.rel}/${entry}`);
            if (!DRY) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        }
    }
}

// stray settings markers
if ('__drvtest_marker' in settings) {
    report.settingsMarker = true;
    if (!DRY) { delete settings.__drvtest_marker; settingsDirty = true; }
}
if (settingsDirty) {
    await client.post('/api/settings/save', settings);
}

console.log(JSON.stringify({ dryRun: DRY, baseUrl: BASE_URL, removed: report }, null, 2));
await client.close();
