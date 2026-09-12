import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UiSession } from '../../src/ui/session.js';

// Live integration tests for the event subscription mechanism.
// Uses a custom (driver-owned) event name so no real ST event is emitted and
// no UI logic is triggered.
const BASE_URL = process.env.ST_URL ?? 'http://localhost:8000';
const TEST_TIMEOUT = 240_000;
const TEST_EVENT = '__drvtest_event__';

let session;

before(async () => {
    session = new UiSession({ baseUrl: BASE_URL, headless: true });
    await session.launch({ timeout: TEST_TIMEOUT });
});

after(async () => {
    await session?.close();
});

describe('Event subscriptions', { timeout: TEST_TIMEOUT }, () => {
    test('subscribe returns a numeric id', async () => {
        const id = await session.stscript.subscribe(TEST_EVENT);
        assert.equal(typeof id, 'number');
        assert.ok(id > 0);
        await session.stscript.unsubscribe(id);
    });

    test('emitted events are buffered and drained by pollEvents', async () => {
        const id = await session.stscript.subscribe(TEST_EVENT);
        // emit from the page side (EventEmitter.emit is async but fire-and-forget here)
        await session.evaluate(({ ev }) => {
            const ctx = SillyTavern.getContext();
            ctx.eventSource.emit(ev, { marker: 'one' });
            ctx.eventSource.emit(ev, { marker: 'two' });
        }, { ev: TEST_EVENT });
        // give the emitter a tick (ST's emit awaits listeners)
        await new Promise(r => setTimeout(r, 300));
        const events = await session.stscript.pollEvents(id);
        assert.equal(events.length, 2);
        assert.equal(events[0].detail.marker, 'one');
        assert.equal(events[1].detail.marker, 'two');
        assert.ok(events[0].at, 'events carry a timestamp');
        await session.stscript.unsubscribe(id);
    });

    test('pollEvents drains the buffer (second poll is empty)', async () => {
        const id = await session.stscript.subscribe(TEST_EVENT);
        await session.evaluate(({ ev }) => {
            SillyTavern.getContext().eventSource.emit(ev, { marker: 'drain' });
        }, { ev: TEST_EVENT });
        await new Promise(r => setTimeout(r, 300));
        const first = await session.stscript.pollEvents(id);
        assert.equal(first.length, 1);
        const second = await session.stscript.pollEvents(id);
        assert.equal(second.length, 0);
        await session.stscript.unsubscribe(id);
    });

    test('pollEvents on an unsubscribed id returns []', async () => {
        const id = await session.stscript.subscribe(TEST_EVENT);
        await session.stscript.unsubscribe(id);
        assert.deepEqual(await session.stscript.pollEvents(id), []);
    });

    test('two subscriptions receive the same event independently', async () => {
        const idA = await session.stscript.subscribe(TEST_EVENT);
        const idB = await session.stscript.subscribe(TEST_EVENT);
        await session.evaluate(({ ev }) => {
            SillyTavern.getContext().eventSource.emit(ev, { marker: 'both' });
        }, { ev: TEST_EVENT });
        await new Promise(r => setTimeout(r, 300));
        assert.equal((await session.stscript.pollEvents(idA)).length, 1);
        assert.equal((await session.stscript.pollEvents(idB)).length, 1);
        await session.stscript.unsubscribe(idA);
        await session.stscript.unsubscribe(idB);
    });

    test('real event types resolve through ctx.eventTypes (CHARACTER_MESSAGE_RENDERED exists)', async () => {
        const ok = await session.evaluate(() => {
            const ctx = SillyTavern.getContext();
            return typeof ctx.eventTypes.CHARACTER_MESSAGE_RENDERED === 'string'
                && typeof ctx.eventTypes.MESSAGE_RECEIVED === 'string'
                && typeof ctx.eventTypes.GENERATION_ENDED === 'string';
        });
        assert.equal(ok, true);
    });
});
