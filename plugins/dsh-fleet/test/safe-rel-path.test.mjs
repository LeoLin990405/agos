// 审计 2026-08-20:fleet_ws / /api/fleet/ws 路径闸 —— 拒绝绝对路径/~/../控制字符,只放行工作区内相对路径
import { readFileSync } from "node:fs"; import { fileURLToPath } from "node:url"; import { dirname, join } from "node:path"; import assert from "node:assert/strict";
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "index.js"), "utf8");
const i = src.indexOf("const safeRelPath ="); const j = src.indexOf("const shq =", i); const k = src.indexOf("\n", j);
const seg = src.slice(i, k);  // 到 shq 那一整行结束
const { safeRelPath, shq } = new Function(seg + "\nreturn { safeRelPath, shq };")();
const ok = (x, want) => assert.equal(safeRelPath(x), want, `safeRelPath(${JSON.stringify(x)})`);
// 放行
ok("a.txt", "a.txt"); ok("./a.txt", "a.txt"); ok("dir/sub/f.md", "dir/sub/f.md"); ok("a..b", "a..b"); ok("it's.txt", "it's.txt");
// 拒绝
for (const bad of ["/etc/passwd", "~/.ssh/id_rsa", "~", "../x", "a/../../etc/passwd", "", "   ", "a\nb", "a\0b", "C:\\x", "D:/x", "..", "./..", ".", "./"]) assert.equal(safeRelPath(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
// shq:单引号安全包裹
assert.equal(shq("it's"), "'it'\\''s'"); assert.equal(shq("a b"), "'a b'");
console.log("✓ safeRelPath/shq 全部通过 (5 放行 / 15 拒绝 / 2 shq)");
