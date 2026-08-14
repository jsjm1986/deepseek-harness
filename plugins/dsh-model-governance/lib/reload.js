import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { loadPolicy } from "./policy.js";
/**
 * Reloads an atomically replaced policy file and drains all queued work before
 * disposal. The parent directory is watched so rename-based replacement keeps
 * working after the policy inode changes.
 */
export class PolicyReloader {
    filename;
    target;
    onValid;
    onInvalid;
    onWatcherError;
    watcher;
    operations = Promise.resolve();
    reloadQueued = false;
    closed = false;
    /**
     * @param options - policy path, lifecycle callbacks, and optional watcher factory.
     */
    constructor(options) {
        this.filename = options.filename;
        this.target = basename(options.filename);
        this.onValid = options.onValid;
        this.onInvalid = options.onInvalid;
        this.onWatcherError = options.onWatcherError;
        const watchDirectory = options.watchDirectory ?? watch;
        this.watcher = watchDirectory(dirname(options.filename), { persistent: false }, (_eventType, filename) => {
            if (filename === null || filename === undefined || String(filename) === this.target)
                this.queueReload();
        });
        this.watcher.on('error', this.onWatcherError);
        // Reconcile once after watcher setup closes the race between the initial
        // boot read and the directory watcher becoming active.
        queueMicrotask(() => { this.queueReload(); });
    }
    /**
     * Close the watcher and wait for every already-queued reload to settle.
     * @returns completion after no reload callback can publish again.
     */
    async close() {
        this.closed = true;
        this.watcher.close();
        await this.operations;
    }
    queueReload() {
        if (this.closed || this.reloadQueued)
            return;
        this.reloadQueued = true;
        const task = this.operations.then(() => {
            this.reloadQueued = false;
            return this.reload();
        });
        this.operations = task.then(() => undefined, () => undefined);
        void task.catch(error => { this.onWatcherError(error); });
    }
    reload() {
        if (this.closed)
            return;
        try {
            this.onValid(loadPolicy(this.filename));
        }
        catch (error) {
            this.onInvalid(error);
        }
    }
}
