/**
 * 工作树摘要:**脏了摘要就必须变**。
 *
 * 这条性质是整条证据链的地基。它不成立的话,「这个结论对哪棵树成立」就只剩 HEAD 一个维度,
 * 而集成层几乎总是跑在有未提交改动的树上 —— 五个代理并行改同一个工作区时尤其如此。
 *
 * 全部在 `mkdtemp` 出来的**临时 git 仓**里做,不碰本仓,也不碰继承的 HOME / CODEX_HOME。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitHead, porcelainEntries, trackedWorktreeDigest, worktreeDigest } from '../lib/worktree.mjs'
import { worktreeDigest as linuxWorktreeDigest } from '../linux/lib/evidence.mjs'
import { tempRoot } from './helpers.mjs'

/** 临时仓的 git 调用带上仓库级身份,不读也不改操作者的全局 git 配置。 */
function git(cwd, argv) {
	const res = spawnSync('git', argv, { cwd, encoding: 'utf8' })
	assert.equal(res.status, 0, `git ${argv.join(' ')} 失败: ${res.stderr}`)
	return String(res.stdout ?? '')
}

function makeRepo(tag) {
	const dir = tempRoot(tag)
	git(dir, ['init', '-q', '-b', 'main'])
	git(dir, ['config', 'user.email', 'acceptance@example.invalid'])
	git(dir, ['config', 'user.name', 'acceptance'])
	git(dir, ['config', 'commit.gpgsign', 'false'])
	mkdirSync(join(dir, 'src'), { recursive: true })
	writeFileSync(join(dir, 'src', 'a.txt'), 'alpha\n')
	writeFileSync(join(dir, 'src', 'b.txt'), 'beta\n')
	writeFileSync(join(dir, '.gitignore'), 'ignored/\n')
	git(dir, ['add', '-A'])
	git(dir, ['commit', '-q', '-m', 'init'])
	return dir
}

test('W1 干净树上重复计算得到同一个摘要', () => {
	const dir = makeRepo('w1')
	const a = worktreeDigest(dir)
	const b = worktreeDigest(dir)
	assert.equal(a.available, true)
	assert.equal(a.digest, b.digest)
	assert.equal(a.dirtyFiles, 0)
	assert.match(a.digest, /^[0-9a-f]{64}$/)
})

test('W2 改一个已跟踪文件的内容 → 摘要必须变(HEAD 一个字没动)', () => {
	const dir = makeRepo('w2')
	const clean = worktreeDigest(dir)
	writeFileSync(join(dir, 'src', 'a.txt'), 'alpha changed\n')
	const dirty = worktreeDigest(dir)
	assert.equal(dirty.head, clean.head, 'HEAD 必须相同 —— 否则这条测的是提交变了,不是工作树变了')
	assert.notEqual(dirty.digest, clean.digest)
	assert.equal(dirty.dirtyFiles, 1)
})

test('W3 改回去 → 摘要回到干净值(不是单调漂移的时间戳)', () => {
	const dir = makeRepo('w3')
	const clean = worktreeDigest(dir).digest
	writeFileSync(join(dir, 'src', 'a.txt'), 'alpha changed\n')
	assert.notEqual(worktreeDigest(dir).digest, clean)
	writeFileSync(join(dir, 'src', 'a.txt'), 'alpha\n')
	assert.equal(worktreeDigest(dir).digest, clean)
})

test('W4 新增未跟踪文件 → 摘要必须变', () => {
	const dir = makeRepo('w4')
	const clean = worktreeDigest(dir).digest
	writeFileSync(join(dir, 'src', 'c.txt'), 'gamma\n')
	assert.notEqual(worktreeDigest(dir).digest, clean)
})

test('W5 未跟踪**目录**里再塞一个文件 → 摘要仍必须变(-uall 的作用)', () => {
	const dir = makeRepo('w5')
	mkdirSync(join(dir, 'newdir'), { recursive: true })
	writeFileSync(join(dir, 'newdir', 'one.txt'), '1\n')
	const one = worktreeDigest(dir)
	writeFileSync(join(dir, 'newdir', 'two.txt'), '2\n')
	const two = worktreeDigest(dir)
	assert.notEqual(one.digest, two.digest,
		'默认的 -unormal 会把整个目录折叠成一条 ?? newdir/,于是往里加文件不改变摘要 —— 那是让脏树伪装成上一次状态的口子')
	// 顺带钉住 porcelain 解析确实逐文件展开。
	const paths = porcelainEntries(dir).map((e) => e.path)
	assert.ok(paths.includes('newdir/one.txt') && paths.includes('newdir/two.txt'), paths.join(','))
})

test('W6 删掉一个已跟踪文件 → 摘要必须变', () => {
	const dir = makeRepo('w6')
	const clean = worktreeDigest(dir).digest
	rmSync(join(dir, 'src', 'b.txt'))
	assert.notEqual(worktreeDigest(dir).digest, clean)
})

test('W7 暂存(git add)不影响"内容变了摘要就变"这条性质', () => {
	const dir = makeRepo('w7')
	const clean = worktreeDigest(dir).digest
	writeFileSync(join(dir, 'src', 'a.txt'), 'staged change\n')
	const unstaged = worktreeDigest(dir).digest
	git(dir, ['add', 'src/a.txt'])
	const staged = worktreeDigest(dir).digest
	assert.notEqual(unstaged, clean)
	assert.notEqual(staged, clean)
})

test('W8 被 .gitignore 忽略的产物不进摘要(否则每跑一次日志都会让摘要漂移)', () => {
	const dir = makeRepo('w8')
	const clean = worktreeDigest(dir).digest
	mkdirSync(join(dir, 'ignored'), { recursive: true })
	writeFileSync(join(dir, 'ignored', 'run.log'), 'noise\n')
	assert.equal(worktreeDigest(dir).digest, clean)
})

test('W9 符号链接改指向 → 摘要必须变(不按目标内容,按链接本身)', () => {
	const dir = makeRepo('w9')
	symlinkSync('src/a.txt', join(dir, 'link'))
	const first = worktreeDigest(dir).digest
	rmSync(join(dir, 'link'))
	symlinkSync('src/b.txt', join(dir, 'link'))
	assert.notEqual(worktreeDigest(dir).digest, first)
})

test('W10 两个内容不同的仓不会撞出同一个摘要', () => {
	const a = makeRepo('w10a')
	const b = makeRepo('w10b')
	writeFileSync(join(a, 'src', 'a.txt'), 'X\n')
	writeFileSync(join(b, 'src', 'a.txt'), 'Y\n')
	assert.notEqual(worktreeDigest(a).digest, worktreeDigest(b).digest)
})

test('W11 不是 git 工作树时明说拿不到,不返回一个看起来像摘要的常量', () => {
	const dir = tempRoot('w11')
	const r = worktreeDigest(dir)
	assert.equal(r.available, false)
	assert.match(r.digest, /^unavailable:not-a-git-worktree:/)
	assert.equal(gitHead(dir), null)
})

test('W13 tracked 口径:改已跟踪文件必变,加未跟踪文件不变(与 porcelain 摘要分叉)', () => {
	const dir = makeRepo('w13')
	const cleanTracked = trackedWorktreeDigest(dir).digest
	const cleanPorcelain = worktreeDigest(dir).digest
	writeFileSync(join(dir, 'src', 'a.txt'), 'alpha tracked-dirty\n')
	assert.notEqual(trackedWorktreeDigest(dir).digest, cleanTracked)
	writeFileSync(join(dir, 'src', 'a.txt'), 'alpha\n')
	assert.equal(trackedWorktreeDigest(dir).digest, cleanTracked)
	writeFileSync(join(dir, 'scratch.txt'), 'untracked noise\n')
	assert.equal(trackedWorktreeDigest(dir).digest, cleanTracked, '未跟踪文件不得进契约口径')
	assert.notEqual(worktreeDigest(dir).digest, cleanPorcelain, 'porcelain 口径必须看见未跟踪文件 —— 两种算法在这里分叉,矩阵要同时认')
})

test('W14 tracked 删除标记在矩阵与 Linux 口径一致', async (t) => {
	const dir = makeRepo('w14')
	const before = trackedWorktreeDigest(dir).digest
	assert.equal((await linuxWorktreeDigest(dir)).digest, before)
	const deleted = join(dir, 'src', 'a.txt')
	const { rmSync: remove } = await import('node:fs')
	remove(deleted)
	const matrix = trackedWorktreeDigest(dir).digest
	const linux = (await linuxWorktreeDigest(dir)).digest
	assert.equal(linux, matrix)
	assert.notEqual(linux, before)
})

test('W15 tracked symlink 存活与悬空时跟随 Linux 目标读取语义', async (t) => {
	const dir = makeRepo('w15')
	symlinkSync('src/b.txt', join(dir, 'live-link.txt'))
	symlinkSync('missing.txt', join(dir, 'dangling-link.txt'))
	git(dir, ['add', 'live-link.txt', 'dangling-link.txt'])
	git(dir, ['commit', '-q', '-m', 'symlink fixtures'])
	assert.equal(trackedWorktreeDigest(dir).digest, (await linuxWorktreeDigest(dir)).digest)
	assert.notEqual(trackedWorktreeDigest(dir).digest, trackedWorktreeDigest(join(dir, '..', 'does-not-exist')).digest)
})

test('W12 本仓上真跑一次:摘要是 64 位十六进制,且与 git rev-parse HEAD 对得上', () => {
	const repo = join(new URL('../../../..', import.meta.url).pathname)
	const r = worktreeDigest(repo)
	assert.equal(r.available, true)
	assert.match(r.digest, /^[0-9a-f]{64}$/)
	assert.equal(r.head, git(repo, ['rev-parse', 'HEAD']).trim())
})
