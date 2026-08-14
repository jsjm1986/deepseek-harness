/** Message used when a live policy reload has left the provider fail-closed. */
export const POLICY_UNAVAILABLE_REASON = 'Model authorization is temporarily unavailable; requests are blocked until a valid policy is loaded.';
/**
 * Stable model-access service whose immutable decision snapshot can be replaced
 * without replacing the Cordis service object consumed by other plugins.
 */
export class ReloadableModelAccess {
    snapshot;
    /**
     * @param policy - the policy that was validated during plugin activation.
     */
    constructor(policy) {
        this.snapshot = createSnapshot(policy);
    }
    /**
     * Replace the whole decision snapshot after a validated policy reload.
     * @param policy - the newly validated policy.
     */
    replace(policy) {
        this.snapshot = createSnapshot(policy);
    }
    /** Enter fail-closed mode until a valid policy is published. */
    unavailable() {
        this.snapshot = {
            defaultAllowed: false,
            routes: new Map(),
            unavailable: true,
        };
    }
    /**
     * Decide whether a provider/model route is currently authorized.
     * @param target - provider and model route to check.
     * @returns an allow or deny decision for the current immutable snapshot.
     */
    decide(target) {
        const snapshot = this.snapshot;
        if (snapshot.unavailable)
            return { allowed: false, reason: POLICY_UNAVAILABLE_REASON };
        const allowed = snapshot.routes.get(`${target.provider}\0${target.model}`) ?? snapshot.defaultAllowed;
        return allowed ? { allowed: true } : {
            allowed: false,
            reason: `Model "${target.provider}/${target.model}" is not authorized for this account.`,
        };
    }
}
function createSnapshot(policy) {
    return {
        defaultAllowed: policy.defaultAllowed,
        routes: new Map(policy.models.map(entry => [`${entry.provider}\0${entry.model}`, entry.allowed])),
        unavailable: false,
    };
}
