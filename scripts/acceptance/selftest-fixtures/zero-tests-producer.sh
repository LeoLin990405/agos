#!/bin/zsh
# 负控固件(合成):模仿一个"跑了 0 个测试却退出 0"的生产者。
# 说明为什么必须合成:Node v26 的 --test 把一个没注册任何测试的文件本身算成 1 个通过的测试,
# 真的 `ℹ tests 0` 在本机的 node --test 下造不出来。这里直接产出那份摘要,
# 端到端验证验收器的解析+判定路径 —— 判 empty,绝不因为"退出 0"就算通过。
print "ℹ tests 0"
print "ℹ suites 0"
print "ℹ pass 0"
print "ℹ fail 0"
print "ℹ cancelled 0"
print "ℹ skipped 0"
print "ℹ todo 0"
print "ℹ duration_ms 1.0"
exit 0
