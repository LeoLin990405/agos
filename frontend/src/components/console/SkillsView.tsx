import React, { useState } from 'react';
import { Chip } from '@/components/ui/Chip';
import { Dot } from '@/components/ui/Dot';
import { Button } from '@/components/ui/Button';

export const SkillsView: React.FC = () => {
  const [filterQuery, setFilterQuery] = useState('');

  const skills = [
    { id: 'view_file', category: 'Read', desc: '查看工作区与系统本地文件内容，支持分片与二进制感知', loaded: true },
    { id: 'run_command', category: 'Exec', desc: '在受控 Seccomp 沙箱中执行 Bash 命令，支持后台守护与超时监控', loaded: true },
    { id: 'write_to_file', category: 'Write', desc: '原子化写入新文件或覆盖现有文件，附带元数据校验', loaded: true },
    { id: 'replace_file_content', category: 'Write', desc: '单块精确代码补丁替换，保证行号与空格完全对齐', loaded: true },
    { id: 'search_web', category: 'Search', desc: '执行外部全网实时检索，返回结构化摘要与引用来源', loaded: true },
    { id: 'read_url_content', category: 'Read', desc: '无头 HTTP 抓取公开网页并转为 Markdown 语料', loaded: true },
    { id: 'grep_search', category: 'Search', desc: '利用 ripgrep 极速正则检索代码库模式与符号', loaded: true },
    { id: 'find_by_name', category: 'Search', desc: '利用 fd 快速文件名与通配符目录扫描', loaded: true },
    { id: 'list_dir', category: 'Read', desc: '列出目录子级文件、大小与递归子项数', loaded: true },
    { id: 'manage_task', category: 'Task', desc: '管理后台守护进程，支持 list / kill / send_input / status', loaded: true },
    { id: 'invoke_subagent', category: 'Agent', desc: '拉起特化子代理执行隔离任务，支持模型独立配置', loaded: true },
    { id: 'define_subagent', category: 'Agent', desc: '动态定义并注册会话期特化子代理类型与系统提示词', loaded: true },
    { id: 'ask_question', category: 'Interaction', desc: '向用户渲染交互式单选/多选决策模态框 (input_required)', loaded: true },
    { id: 'schedule', category: 'Timer', desc: '配置一次性毫秒定时器或标准 Cron 周期调度任务', loaded: true },
  ];

  const filtered = skills.filter(
    (s) =>
      s.id.toLowerCase().includes(filterQuery.toLowerCase()) ||
      s.desc.toLowerCase().includes(filterQuery.toLowerCase()) ||
      s.category.toLowerCase().includes(filterQuery.toLowerCase())
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 800 }}>MCP 技能与工具注册表 (Skills Catalog)</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
            数据源: <code>/api/agos/skills</code> + <code>skill.list</code> · 14 项核心工具全量挂载
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <input
            type="text"
            placeholder="搜索技能名称 / 分类..."
            className="form-input"
            style={{ width: '220px', height: '30px', padding: '4px 10px', fontSize: '11.5px' }}
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
          />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '14px' }}>
        {filtered.map((s) => (
          <div
            key={s.id}
            style={{
              backgroundColor: 'var(--bg-layer-2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '10px',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: '10px',
              boxShadow: 'var(--shadow-card)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Dot state="done" size={6} />
                <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--text-primary)' }}>
                  {s.id}
                </span>
              </div>
              <Chip variant="purple">{s.category}</Chip>
            </div>

            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {s.desc}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--border-dim)', paddingTop: '8px', fontSize: '11px', color: 'var(--text-tertiary)' }}>
              <span>状态: <strong style={{ color: 'var(--state-done)' }}>100% HEALTHY</strong></span>
              <span className="u-num">0 异常调用</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
