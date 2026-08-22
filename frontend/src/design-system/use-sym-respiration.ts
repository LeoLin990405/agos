import { useEffect } from 'react';
import { MOTION_CONSTANTS } from './tokens';

/**
 * 共息同频锁相 Hook (Sym-Respiration)
 * 将组件/页面的所有运行态动画对齐至统一的虚拟时间线相位
 */
export function useSymRespiration() {
  useEffect(() => {
    const sync = () => {
      const now = performance.now();
      const phaseMs = -(now % MOTION_CONSTANTS.PULSE_DURATION_MS);
      const phaseStr = `${phaseMs.toFixed(1)}ms`;

      document.documentElement.style.setProperty('--u-phase', phaseStr);

      const runningNodes = document.querySelectorAll(
        '.u-dot--running, .u-dot.is-running, .u-swarm-card.is-running, .rail-badge--running, .host-power-badge.is-waking'
      );
      runningNodes.forEach((el) => {
        (el as HTMLElement).style.setProperty('--u-phase', phaseStr);
      });
    };

    sync();
    const timer = setInterval(sync, MOTION_CONSTANTS.PULSE_DURATION_MS);
    return () => clearInterval(timer);
  }, []);
}
