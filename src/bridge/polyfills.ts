/**
 * 必须最先执行。
 *
 * server/util/index.js 在**模块初始化时**就读 process.env.platform 决定 appid/clientver，
 * 所以这些全局必须在任何 server/ 代码被 import 之前挂好 —— 也就是 polyfills 要是
 * main.ts 的第一个 import，且桥接层内部也要再 import 一次兜底。
 */
import { Buffer } from 'buffer';

type Mutable = Record<string, unknown>;
const g = globalThis as unknown as Mutable;

if (!g.Buffer) g.Buffer = Buffer;
if (!g.global) g.global = globalThis;

const proc = (g.process as Mutable | undefined) ?? {};
const env = (proc.env as Record<string, string> | undefined) ?? {};

// 概念版：桌面端在 src/main/server.ts 里同样写死 'lite'
env.platform = env.platform ?? 'lite';
env.NODE_ENV = env.NODE_ENV ?? 'production';

proc.env = env;
proc.argv = (proc.argv as string[] | undefined) ?? [];
proc.platform = proc.platform ?? 'browser';
proc.nextTick =
  (proc.nextTick as unknown) ??
  ((fn: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(() => fn(...args), 0));

g.process = proc;
