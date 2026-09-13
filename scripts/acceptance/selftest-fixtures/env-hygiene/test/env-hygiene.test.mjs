// 从**闸子进程内部**钉住 neutralEnv 真的生效了。
// 外部只能看到"计数对不对";这些不变量只有站在子进程里才看得见。
import test from 'node:test'
import assert from 'node:assert/strict'

test('闸子进程:验收器标记在,供应商密钥不在', () => {
	assert.equal(process.env.AGOS_ACCEPTANCE, '1', '验收器必须给子进程打上 AGOS_ACCEPTANCE=1')
	for (const k of ['Z_AI_API_KEY', 'GLM_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_PATH']) {
		assert.equal(process.env[k], undefined, `${k} 必须已从子进程环境里剔除`)
	}
})

test('闸子进程:语料/Fleet 历史指向不存在的路径,而不是被删掉', () => {
	// 删掉变量会让代码走 HOME 探测分支,落到操作者真实数据上;指到不存在的路径才真的关掉。
	assert.match(process.env.SESSION_MEMORY_CORPUS_DIR ?? '', /agos-acceptance-absent-corpus/)
	assert.match(process.env.DSH_FLEET_RUNS_FILE ?? '', /agos-acceptance-absent-fleet-runs/)
})

test('闸子进程:NODE_OPTIONS 没有从祖先进程漏下来', () => {
	// NODE_TEST_CONTEXT 是本层 node --test 自己设的,不能在这里断言"不存在";
	// 它没漏下来的证据是**这三条测试真的跑了**(漏下来时 node --test 一个文件都不跑、
	// 连摘要都不打,验收器会判 no-test-summary → fail)。NODE_OPTIONS 没这个歧义,可以直断。
	assert.equal(process.env.NODE_OPTIONS, undefined, 'NODE_OPTIONS 必须已被剔除')
})
