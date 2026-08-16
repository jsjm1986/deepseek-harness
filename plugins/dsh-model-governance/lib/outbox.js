import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** Crash-safe local outbox; each record is committed by same-directory rename. */
export class UsageOutbox {
    dir;
    url;
    token;
    pumping = Promise.resolve();
    timer;
    closed = false;
    constructor(dir, url, token) {
        this.dir = dir;
        this.url = url;
        this.token = token;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.timer = setInterval(() => this.kick(), 5_000);
        this.timer.unref();
        this.kick();
    }
    /**
     * Replace the intake destination used by future delivery attempts.
     * @param url - loopback intake URL from the validated policy.
     * @param token - bearer token from the validated policy.
     */
    setEndpoint(url, token) {
        if (this.closed)
            return;
        this.url = url;
        this.token = token;
    }
    enqueue(record) {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const target = join(this.dir, `${record.eventId}.json`);
        const temp = `${target}.${randomBytes(5).toString('hex')}.tmp`;
        const fd = openSync(temp, 'wx', 0o600);
        try {
            writeFileSync(fd, JSON.stringify(record));
            closeSync(fd);
            renameSync(temp, target);
        }
        catch (error) {
            try {
                closeSync(fd);
            }
            catch { /* already closed */ }
            rmSync(temp, { force: true });
            throw error;
        }
        this.kick();
    }
    kick() {
        if (this.closed)
            return;
        this.pumping = this.pumping.then(() => this.drain(), () => this.drain());
    }
    async drain() {
        for (const name of readdirSync(this.dir).filter(name => name.endsWith('.json')).sort()) {
            if (this.closed)
                return;
            const path = join(this.dir, name);
            let response;
            try {
                response = await fetch(this.url, {
                    method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
                    body: await import('node:fs/promises').then(fs => fs.readFile(path, 'utf8')),
                    signal: AbortSignal.timeout(5_000),
                });
            }
            catch {
                return;
            }
            if (!response.ok)
                return;
            rmSync(path, { force: true });
        }
    }
    async close() {
        this.closed = true;
        clearInterval(this.timer);
        await this.pumping;
    }
}
