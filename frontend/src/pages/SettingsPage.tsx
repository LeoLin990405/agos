import React, { useCallback, useEffect, useState } from 'react'
import { AppTopbar } from '@/components/layout/AppTopbar'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { agos } from '@/stores/live'
import {
  deriveSettingRows,
  formatSettingValue,
  loadSettingsSnapshot,
  type SettingRow,
  type SettingsReadSnapshot,
} from './settings-data.ts'

type PageState =
  | { phase: 'loading' }
  | { phase: 'error', message: string }
  | { phase: 'ready', snapshot: SettingsReadSnapshot }

const sourceLabels = {
  user: '用户',
  base: 'base',
  default: '默认',
  protected: '受保护',
} as const

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const SettingValue: React.FC<{ row: SettingRow }> = ({ row }) => {
  if (row.protected) return <span>{row.value === true ? '已配置' : '未配置'}</span>
  const formatted = formatSettingValue(row.value)
  if (row.structured || formatted.length > 100) {
    return (
      <details>
        <summary className="settings-summary">展开解析值</summary>
        <pre className="surface-pre settings-pre">
          {formatted}
        </pre>
      </details>
    )
  }
  return <span className="surface-strong">{formatted}</span>
}

const SettingRows: React.FC<{ rows: SettingRow[] }> = ({ rows }) => {
  if (rows.length === 0) return <p className="surface-quiet">宿主返回了命名空间，但其 schema 无法投影为字段列表。</p>
  return (
    <dl className="settings-list">
      {rows.map((row) => (
        <div
          key={row.path.join('.')}
          className="surface-row surface-row--setting"
        >
          <dt>
            <div className="u-num surface-strong">{row.label}</div>
            {row.description !== undefined && <div className="surface-quiet">{row.description}</div>}
          </dt>
          <dd className="surface-body"><SettingValue row={row} /></dd>
          <dd><Chip>{sourceLabels[row.source]}</Chip></dd>
          <dd><Chip variant={row.applies === 'restart' ? 'amber' : 'default'}>{row.applies === 'restart' ? '重启生效' : '即时生效'}</Chip></dd>
        </div>
      ))}
    </dl>
  )
}

export const SettingsPage: React.FC = () => {
  const [state, setState] = useState<PageState>({ phase: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)
  const [openState, setOpenState] = useState<'idle' | 'opening'>('idle')
  const [openError, setOpenError] = useState<string>()

  useEffect(() => {
    const controller = new AbortController()
    setState({ phase: 'loading' })
    void loadSettingsSnapshot(agos, controller.signal).then(
      (snapshot) => { if (!controller.signal.aborted) setState({ phase: 'ready', snapshot }) },
      (error) => { if (!controller.signal.aborted) setState({ phase: 'error', message: messageOf(error) }) },
    )
    return () => controller.abort()
  }, [reloadKey])

  const openDocument = useCallback(async () => {
    if (openState === 'opening') return
    setOpenState('opening')
    setOpenError(undefined)
    try {
      const response = await agos.call('settings.openDocument', {})
      if (!response.result.ok) throw new Error(response.result.error.message)
    } catch (error) {
      setOpenError(messageOf(error))
    } finally {
      setOpenState('idle')
    }
  }, [openState])

  const snapshot = state.phase === 'ready' ? state.snapshot : undefined
  const nothingExposed = snapshot !== undefined
    && snapshot.namespaces.length === 0
    && snapshot.providers.length === 0
    && snapshot.modelGroups.length === 0

  return (
    <div className="page-workspace">
      <main className="app-stage">
        <AppTopbar
          title="设置"
          badge={<Chip>只读配置视图</Chip>}
          runningState={false}
          rightActions={snapshot?.hasDocument === true ? (
            <Button variant="ghost" size="sm" disabled={openState === 'opening'} onClick={() => { void openDocument() }}>
              {openState === 'opening' ? '正在打开…' : '打开宿主设置文档'}
            </Button>
          ) : undefined}
        />

        <div className="settings-body">
          {state.phase === 'loading' && (
            <p className="surface-quiet">正在读取宿主设置、提供商与模型目录…</p>
          )}

          {state.phase === 'error' && (
            <section className="settings-section" aria-live="polite">
              <h2 className="settings-heading">配置面暂不可用</h2>
              <p className="surface-quiet">settings.describe、llm.providers 或 llm.models 没有完成读取。页面不会用本地默认值替代宿主答案。</p>
              <p className="surface-quiet surface-alert">{state.message}</p>
              <Button size="sm" onClick={() => setReloadKey((key) => key + 1)}>重新读取</Button>
            </section>
          )}

          {snapshot !== undefined && (
            <>
              <section className="settings-section is-first">
                <h2 className="settings-heading">读取边界</h2>
                <p className="surface-quiet">
                  所有字段均来自宿主的脱敏描述。本页不读取或保存凭据值，也不提供模型发现与配置写入。
                  {snapshot.writable ? '宿主配置层可写，但本视图仍保持只读。' : '宿主当前有只读配置层遮蔽，可写操作不可用。'}
                </p>
                {openError !== undefined && <p role="alert" className="surface-quiet surface-alert">打开文档失败：{openError}</p>}
              </section>

              {nothingExposed && (
                <section className="settings-section">
                  <h2 className="settings-heading">没有公开的配置</h2>
                  <p className="surface-quiet">宿主当前没有向配置面公开命名空间、提供商或模型目录。</p>
                </section>
              )}

              {snapshot.namespaces.map((namespace) => (
                <section key={namespace.ns} className="settings-section">
                  <div className="surface-header is-baseline">
                    <div>
                      <h2 className="settings-heading">{namespace.ns}</h2>
                      <p className="surface-quiet">
                        revision {namespace.revision} · {namespace.user === undefined ? '未设置用户层' : '含用户层覆盖'}
                      </p>
                    </div>
                    {!snapshot.writable && <Chip variant="amber">只读层遮蔽</Chip>}
                  </div>
                  <SettingRows rows={deriveSettingRows(namespace)} />
                </section>
              ))}

              <section className="settings-section">
                <h2 className="settings-heading">凭据状态</h2>
                <p className="surface-quiet">这里只显示是否配置、来源与可写性。浏览器没有取得凭据值或打码后的值。</p>
                {Object.keys(snapshot.credentials).length === 0 ? (
                  <p className="surface-quiet">公开配置没有命名任何凭据引用。</p>
                ) : (
                  <dl className="settings-list">
                    {Object.entries(snapshot.credentials).map(([ref, credential]) => (
                      <div key={ref} className="surface-row surface-row--inline">
                        <dt className="u-num surface-strong">{ref}</dt>
                        <dd><Chip active={credential.configured}>{credential.configured ? '已配置' : '未配置'}</Chip></dd>
                        {credential.source !== undefined && <dd className="surface-body">来源 {credential.source}</dd>}
                        <dd className="surface-quiet">{credential.writable ? '宿主层可写' : '只读来源遮蔽'}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>

              <section className="settings-section">
                <h2 className="settings-heading">提供商</h2>
                <p className="surface-quiet">配置目录与当前路由注册状态，只读。</p>
                {snapshot.providers.length === 0 ? <p className="surface-quiet">宿主没有公开可配置的提供商。</p> : (
                  <div className="settings-list">
                    {snapshot.providers.map((provider) => (
                      <div key={provider.provider} className="surface-row surface-row--provider">
                        <div><strong>{provider.displayName}</strong><div className="surface-quiet">{provider.provider}</div></div>
                        <Chip active={provider.active}>{provider.active ? '已注册' : '未注册'}</Chip>
                        <div className="surface-body">
                          {provider.settingsNs === '' ? '未提供设置地址' : `${provider.settingsNs}${provider.settingsPath.length === 0 ? '' : ` · ${provider.settingsPath.join('.')}`}`}
                          <div className="surface-quiet">{provider.declared === undefined ? '声明状态未采集' : provider.declared ? '由配置声明' : '非配置声明'}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="settings-section is-last">
                <h2 className="settings-heading">模型目录</h2>
                <p className="surface-quiet">宿主当前已注册提供商的模型清单，只读；本页不会调用模型发现。</p>
                {snapshot.modelGroups.length === 0 && snapshot.modelFailures.length === 0 && <p className="surface-quiet">宿主返回了空模型目录。</p>}
                {snapshot.modelGroups.map((group) => (
                  <details key={group.id} className="surface-section">
                    <summary className="settings-summary">{group.name} · {group.models.length} 个模型</summary>
                    <div className="settings-models">
                      {group.models.length === 0 ? '该提供商没有返回模型。' : group.models.map((model) => (
                        <div key={model.id}>{model.name} <span className="surface-quiet">({model.id})</span></div>
                      ))}
                    </div>
                  </details>
                ))}
                {snapshot.modelFailures.map((failure) => (
                  <div key={failure.id} className="settings-fail">
                    {failure.name}：{failure.message}
                  </div>
                ))}
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
