import React from 'react'
import './demo.css'

/** Permanent notice: this build is running on bundled sample data. */
export const DemoBanner: React.FC = () => (
  <div className="agos-demo-banner" role="status" data-testid="agos-demo-banner">
    <strong>DEMO · 示例数据</strong>
    <span>未连接 dsh 宿主 (:3091)。会话与发言均为内置样例（标注【示例数据】），无样例的面板显示「演示模式未采集」。</span>
  </div>
)
