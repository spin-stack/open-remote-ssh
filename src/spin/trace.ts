// A connection is one trace: the resolver hands the spin CLI a W3C traceparent of its own for each
// resolve, which `spin code`, `spin ssh-session` and `spin tunnel` join with --traceparent and
// export their spans under, so Admin → Traces shows what opening the workspace did under one id.
// The resolver exports no spans of its own; the Spinbox extension does the same for its commands.

import { randomBytes } from 'crypto';

/** Version 00, a random trace-id and parent-id, sampled. An id of all zeros is invalid, so drawn again. */
export function newTraceparent(): string {
    return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

/** The trace-id of a traceparent: what a trace is found by. */
export function traceIdOf(traceparent: string): string {
    return traceparent.split('-')[1] ?? '';
}

function randomHex(bytes: number): string {
    for (;;) {
        const hex = randomBytes(bytes).toString('hex');
        if (!/^0+$/.test(hex)) {
            return hex;
        }
    }
}
