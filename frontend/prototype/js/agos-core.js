/**
 * AgOS Core Prototype Interactive Engine
 * 包含: 主题管理、共息同频锁相 (Sym-Respiration Engine)、级联展开、密度切换与模拟响应
 */

(function () {
  'use strict';

  // 1. 全局共息心跳常量 (2400ms = 25 BPM)
  const U_PULSE_MS = 2400;

  /**
   * 同频锁相核心函数:
   * 计算当前虚拟时间线相位，强制所有「处理中」元素进入同一呼吸周期
   */
  function syncPulseAll() {
    const now = performance.now();
    const phaseMs = -(now % U_PULSE_MS);
    const phaseStr = `${phaseMs.toFixed(1)}ms`;

    document.documentElement.style.setProperty('--u-phase', phaseStr);

    // 给所有运行中的独立动画元素施加同一相位
    const runningNodes = document.querySelectorAll('.u-dot--running, .u-dot.is-running, .u-swarm-card.is-running, .rail-badge--running');
    runningNodes.forEach(el => {
      el.style.setProperty('--u-phase', phaseStr);
    });
  }

  // 2. 主题切换管理 (深色/浅色)
  function initTheme() {
    const savedTheme = localStorage.getItem('agos_theme') ||
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

    setTheme(savedTheme);

    document.addEventListener('click', (e) => {
      const toggleBtn = e.target.closest('[data-action="toggle-theme"]');
      if (toggleBtn) {
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
        const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
        setTheme(nextTheme);
      }
    });
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('agos_theme', theme);

    // 更新界面上所有的主题图标或文字指示
    document.querySelectorAll('[data-theme-indicator]').forEach(el => {
      el.textContent = theme === 'dark' ? '🌙 深色模式' : '☀️ 浅色模式';
    });
    document.querySelectorAll('[data-theme-icon]').forEach(el => {
      el.textContent = theme === 'dark' ? '🌙' : '☀️';
    });
  }

  // 3. 级联折叠/展开组件绑定
  function initCollapsibles() {
    // 思考链展开收起
    document.addEventListener('click', (e) => {
      const cotHeader = e.target.closest('.cot-header');
      if (cotHeader) {
        const cotBlock = cotHeader.closest('.cot-block');
        const cotContent = cotBlock ? cotBlock.querySelector('.cot-content') : null;
        if (cotContent) {
          const isHidden = cotContent.style.display === 'none';
          cotContent.style.display = isHidden ? 'block' : 'none';
          const icon = cotHeader.querySelector('.cot-toggle-icon');
          if (icon) icon.textContent = isHidden ? '▾' : '▸';
        }
      }
    });

    // 谱系 Job 卡片三段级联展开
    document.addEventListener('click', (e) => {
      const jobCard = e.target.closest('.lineage-job-card');
      if (jobCard && !e.target.closest('button, a, input')) {
        const detail = jobCard.querySelector('.job-cascade-detail');
        if (detail) {
          const isOpen = detail.classList.contains('is-open');
          detail.classList.toggle('is-open', !isOpen);
          const icon = jobCard.querySelector('.job-expand-icon');
          if (icon) icon.textContent = isOpen ? '▸' : '▾';
        }
      }
    });
  }

  // 4. 审批卡片交互模拟
  function initApprovalActions() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-approval-action]');
      if (!btn) return;

      const panel = btn.closest('.approval-panel');
      if (!panel) return;

      const action = btn.getAttribute('data-approval-action');
      if (action === 'allow' || action === 'always-allow') {
        panel.style.borderColor = 'var(--state-done)';
        panel.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;color:var(--state-done);font-weight:600;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="u-dot u-dot--done"></span>
              <span>已授权特权执行: 写入配置变更已生效 (操作人: Leo · ${action === 'always-allow' ? '本会话永久信任' : '单次授权'})</span>
            </div>
            <span class="u-num" style="font-size:11px;color:var(--text-tertiary);">刚刚</span>
          </div>
        `;
      } else if (action === 'reject') {
        panel.style.borderColor = 'var(--state-failed)';
        panel.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;color:var(--state-failed);font-weight:600;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="u-dot u-dot--failed"></span>
              <span>特权执行已被人工否决: 命令已中止 (拦截已记入 CivStrip 审计日志)</span>
            </div>
            <span class="u-num" style="font-size:11px;color:var(--text-tertiary);">刚刚</span>
          </div>
        `;
      }
    });
  }

  // 5. 控制台模式切换 (满载 Dense vs 冷启 Sparse)
  function initDensitySwitch() {
    const switchBtns = document.querySelectorAll('[data-density-switch]');
    switchBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-density-switch');
        switchBtns.forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');

        const denseView = document.getElementById('view-dense-mode');
        const sparseView = document.getElementById('view-sparse-mode');

        if (denseView && sparseView) {
          if (mode === 'sparse') {
            denseView.style.display = 'none';
            sparseView.style.display = 'flex';
          } else {
            denseView.style.display = 'flex';
            sparseView.style.display = 'none';
          }
        }
      });
    });
  }

  // 初始化所有模块
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initCollapsibles();
    initApprovalActions();
    initDensitySwitch();
    syncPulseAll();

    // 定期对齐相位，消除微小时钟漂移
    setInterval(syncPulseAll, U_PULSE_MS);
  });

  // 挂载到全局供调试
  window.AgOS = {
    syncPulse: syncPulseAll,
    setTheme: setTheme
  };
})();
