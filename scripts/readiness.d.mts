export declare const sleep: (ms: number) => Promise<void>;
export declare function waitFor(fn: () => unknown | Promise<unknown>, timeoutMs: number, label: string): Promise<void>;
