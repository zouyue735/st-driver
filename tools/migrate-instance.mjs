#!/usr/bin/env node
/**
 * Migrate a SillyTavern instance's configuration and content to a fresh install.
 *
 * Usage:
 *   node tools/migrate-instance.mjs --from <oldRoot> --to <newRoot> [--dry] [--with-backups]
 *
 * Copies (verified against ST 1.18.0 data layout):
 *   config.yaml                 server config (port, whitelist, CSRF, embedding model)
 *   data/cookie-secret.txt      MUST copy: session-cookie signing key; without it
 *                               every existing session/CSRF token is invalidated
 *   data/_css/                  user.css custom styles
 *   data/_errors/               error page templates
 *   data/_storage/              persisted key-value storage
 *   data/_uploads/              uploaded attachments cache
 *   data/_cache/                tokenizer models + HF embedding model
 *                               (Cohee/jina-embeddings-v2-base-en, 106M) - copied
 *                               because the ST process often cannot reach
 *                               HuggingFace directly, so it would not re-download
 *   data/default-user/**        ALL user content and settings:
 *                                 settings.json      <- model, sampling, reasoning
 *                                                       effort, max tokens, prompts
 *                                 secrets.json       <- API keys
 *                                 stats.json, image-metadata.json
 *                                 characters/ chats/ "group chats"/ groups/ worlds/
 *                                 backgrounds/ themes/ "User Avatars"/ user/
 *                                 context/ instruct/ sysprompt/ reasoning/
 *                                 movingUI/ QuickReplies/ extensions/ assets/
 *                                 KoboldAI/ NovelAI/ OpenAI/ TextGen/ group/ vectors/
 *
 * Deliberately NOT copied:
 *   data/default-user/backups/  365M of auto-generated chat backups (regenerable;
 *                               pass --with-backups to include)
 *   data/_webpack/              14M build cache (regenerated on first boot)
 *   data/default-user/thumbnails/ regenerated on demand
 *   node_modules/               run `npm install` in the target
 *
 * The target's data/ directory is created if absent. Existing files in the
 * target are overwritten (the target is expected to be a fresh install).
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
function flag(name) {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
}
const FROM = flag('from');
const TO = flag('to');
const DRY = argv.includes('--dry');
const WITH_BACKUPS = argv.includes('--with-backups');

if (!FROM || !TO) {
    console.error('Usage: node tools/migrate-instance.mjs --from <oldRoot> --to <newRoot> [--dry] [--with-backups]');
    process.exit(2);
}

const src = path.resolve(FROM);
const dst = path.resolve(TO);
if (!fs.existsSync(src)) {
    console.error(`source does not exist: ${src}`);
    process.exit(2);
}
if (src === dst) {
    console.error('source and destination are the same');
    process.exit(2);
}

/** Items to copy, relative to the instance root. */
const PLAN = [
    { rel: 'config.yaml', kind: 'file' },
    { rel: 'data/cookie-secret.txt', kind: 'file' },
    { rel: 'data/_css', kind: 'dir' },
    { rel: 'data/_errors', kind: 'dir' },
    { rel: 'data/_storage', kind: 'dir' },
    { rel: 'data/_uploads', kind: 'dir' },
    { rel: 'data/_cache', kind: 'dir' },
    { rel: 'data/default-user', kind: 'dir' },
];

/** Relative paths (under data/default-user) to exclude from the copy. */
const EXCLUDE = new Set([
    WITH_BACKUPS ? null : 'data/default-user/backups',
    'data/default-user/thumbnails',
].filter(Boolean));

const stats = { dirs: 0, files: 0, bytes: 0, skipped: 0, excluded: 0, missing: 0 };
const log = [];

/**
 * Recursively copy a directory, honouring the exclusion list.
 * @param {string} from absolute source dir
 * @param {string} to absolute destination dir
 * @param {string} relPath destination-relative path for exclusion matching
 */
function copyDir(from, to, relPath) {
    if (EXCLUDE.has(relPath.replace(/\\/g, '/'))) {
        stats.excluded++;
        log.push(`EXCLUDE ${relPath}`);
        return;
    }
    if (!DRY) fs.mkdirSync(to, { recursive: true });
    stats.dirs++;
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const childRel = `${relPath}/${entry.name}`.replace(/\\/g, '/');
        const srcPath = path.join(from, entry.name);
        const dstPath = path.join(to, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, dstPath, childRel);
        } else if (entry.isSymbolicLink()) {
            stats.skipped++;
            log.push(`SKIP symlink ${childRel}`);
        } else {
            const size = fs.statSync(srcPath).size;
            if (!DRY) fs.copyFileSync(srcPath, dstPath);
            stats.files++;
            stats.bytes += size;
        }
    }
}

for (const item of PLAN) {
    const srcPath = path.join(src, item.rel);
    const dstPath = path.join(dst, item.rel);
    if (!fs.existsSync(srcPath)) {
        stats.missing++;
        log.push(`MISSING ${item.rel} (not present in source)`);
        continue;
    }
    const norm = item.rel.replace(/\\/g, '/');
    if (EXCLUDE.has(norm)) {
        stats.excluded++;
        log.push(`EXCLUDE ${item.rel}`);
        continue;
    }
    if (item.kind === 'file') {
        const size = fs.statSync(srcPath).size;
        if (!DRY) {
            fs.mkdirSync(path.dirname(dstPath), { recursive: true });
            fs.copyFileSync(srcPath, dstPath);
        }
        stats.files++;
        stats.bytes += size;
        log.push(`FILE  ${item.rel} (${size}B)`);
    } else {
        log.push(`DIR   ${item.rel}`);
        copyDir(srcPath, dstPath, norm);
    }
}

console.log(log.join('\n'));
console.log('\n' + JSON.stringify({
    dryRun: DRY,
    from: src,
    to: dst,
    withBackups: WITH_BACKUPS,
    ...stats,
    sizeMB: Math.round(stats.bytes / 1024 / 1024),
}, null, 2));
