/**
 * dsh-message-display，浏览器半边。
 *
 * 以 `window.__ModuleLoader__.load({ id, factory })` 的懒加载 CJS 形式提供：
 * 脚本执行只注册工厂，`require('react')` 在物化时解析到 shell 共享的 React。
 * 工厂顶层注入的 <style> 会被模块系统认领（data-plugin 戳记），插件卸载时自动移除。
 *
 * UI 挂在 `shell.overlay` 插槽：页面右侧半透明胶囊按钮，悬停展开消息队列面板，
 * 移出自动收起；列表只显示用户输入与每轮 AI 最终回复，支持「我 / AI」过滤、
 * 浏览位置自动跟踪、点击定位并高亮闪烁；打开面板自动加载更早历史
 * （Host 半边的 /dsh-message-display/fetch-history 路由），滚动到列表顶部继续加载。
 */

window.__ModuleLoader__.load({
  id: 'dsh-message-display',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    // ── 常量 ──────────────────────────────────────────────────────────────

    /** Host 半边读取更早历史消息的同源路由。 */
    const HISTORY_ROUTE = '/dsh-message-display/fetch-history'

    /** DOM 扫描窗口最多保留的消息条数（面板内当前窗口部分）。 */
    const MAX_ITEMS = 60

    /** 摘要长度（前 N 个字 + 省略号）。 */
    const SUMMARY_LENGTH = 44

    /** 只收录这两类消息：用户输入（含 steering）与 AI 回复；thinking / 工具调用行全部排除。 */
    const INCLUDED_KINDS = { 'user': true, 'steering': true, 'assistant-step': true }

    const KIND_LABELS = {
      'user': '我',
      'steering': '我',
      'assistant-step': 'AI',
    }

    // ── 工具函数 ──────────────────────────────────────────────────────────

    /** 从聊天行 key（`${kind.length}:${kind}${id}`）解析 assistant 的轮次。 */
    function parseTurn(key, kind) {
      if (kind !== 'assistant-step') return null
      const colon = key.indexOf(':')
      if (colon === -1) return null
      const len = Number(key.slice(0, colon))
      if (!Number.isFinite(len) || len < 1) return null
      const id = key.slice(colon + 1 + len)
      const sep = id.indexOf(':')
      if (sep === -1) return null
      const turn = Number(id.slice(0, sep))
      return Number.isFinite(turn) ? turn : null
    }

    /** 从聊天行 key 解析业务 id（user 为 messageId，assistant 为 `turn:step`）。 */
    function parseNodeId(key) {
      const colon = key.indexOf(':')
      if (colon === -1) return key
      const len = Number(key.slice(0, colon))
      if (!Number.isFinite(len) || len < 1) return key
      return key.slice(colon + 1 + len)
    }

    /** 提取一行的可见文本：跳过 thinking（`data-variant="think"`）与 aria-hidden 子树。 */
    function rowText(row) {
      const parts = []
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const el = node.parentElement
          if (el === null) return NodeFilter.FILTER_ACCEPT
          if (el.closest('[data-variant="think"]') !== null) return NodeFilter.FILTER_REJECT
          if (el.closest('[aria-hidden="true"]') !== null) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })
      while (walker.nextNode()) {
        const value = walker.currentNode.nodeValue
        if (value !== null) parts.push(value)
      }
      return parts.join(' ').replace(/\s+/g, ' ').trim()
    }

    /** 扫描聊天流 DOM，产出「当前窗口」消息列表（每轮 AI 只保留最后一步）。 */
    function collect() {
      const rows = Array.prototype.slice.call(document.querySelectorAll('[data-chat-anchor-key]'))
      const candidates = []
      for (const row of rows) {
        const kind = row.getAttribute('data-chat-flow-kind') || 'unknown'
        if (INCLUDED_KINDS[kind] !== true) continue
        const key = row.getAttribute('data-chat-anchor-key')
        if (key === null || key === '') continue
        const text = rowText(row)
        if (text === '') continue
        candidates.push({
          key,
          kind,
          el: row,
          text,
          group: kind === 'assistant-step' ? 'assistant' : 'user',
          turn: parseTurn(key, kind),
        })
      }
      const lastOfTurn = new Map()
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]
        if (c.kind !== 'assistant-step') continue
        const groupKey = c.turn !== null ? 't' + c.turn : 'k' + i
        lastOfTurn.set(groupKey, i)
      }
      const kept = candidates.filter((c, i) => {
        if (c.kind !== 'assistant-step') return true
        const groupKey = c.turn !== null ? 't' + c.turn : 'k' + i
        return lastOfTurn.get(groupKey) === i
      })
      const recent = kept.length > MAX_ITEMS ? kept.slice(kept.length - MAX_ITEMS) : kept
      const items = recent.map(c => ({
        key: c.key,
        kind: c.kind,
        group: c.group,
        id: parseNodeId(c.key),
        role: KIND_LABELS[c.kind] || c.kind,
        summary: c.text.length > SUMMARY_LENGTH ? c.text.slice(0, SUMMARY_LENGTH) + '…' : c.text,
      }))
      return { items, candidates: recent }
    }

    /** 合并更早历史与当前窗口：按身份去重，历史在前、窗口在后（时间正序）。 */
    function mergeItems(history, dom) {
      const domKeys = new Set()
      const domIds = new Set()
      for (const d of dom) {
        domKeys.add(d.key)
        domIds.add(d.group + '\u0000' + d.id)
      }
      const older = []
      const seen = new Set()
      for (const h of history) {
        const idk = h.group + '\u0000' + h.id
        if (domKeys.has(h.key) || domIds.has(idk) || seen.has(idk)) continue
        seen.add(idk)
        older.push(h)
      }
      return older.concat(dom)
    }

    /** 按节点 key 查找已渲染的聊天行。 */
    function findRow(key) {
      const rows = document.querySelectorAll('[data-chat-anchor-key]')
      for (const row of rows) {
        if (row.getAttribute('data-chat-anchor-key') === key) return row
      }
      return null
    }

    /** 平滑滚动定位到聊天行并闪烁高亮。 */
    function flashAt(row) {
      const flashing = document.querySelectorAll('.dsh-nav-flash')
      for (const el of flashing) el.classList.remove('dsh-nav-flash')
      try {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } catch {
        row.scrollIntoView()
      }
      void row.offsetWidth
      row.classList.add('dsh-nav-flash')
    }

    /** 找到聊天流自带的「加载更早」按钮（用于点击历史条目时自动翻页）。 */
    function olderButton() {
      const column = document.querySelector('[data-conversation-scroll] [data-chat-flow]')
      if (column === null) return null
      for (const child of column.children) {
        if (child.hasAttribute('data-chat-anchor-key')) continue
        const btn = child.querySelector('button')
        if (btn !== null) return btn
      }
      return null
    }

    /** 请求 Host 半边：返回边界之前的历史消息页。 */
    async function fetchHistory(args) {
      const res = await fetch(HISTORY_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
      })
      const text = await res.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        data = { ok: false, error: 'HTTP ' + res.status + ': ' + text.slice(0, 160) }
      }
      if (!res.ok && data.ok !== true) {
        data = { ok: false, error: 'HTTP ' + res.status + ': ' + String(data.error || text.slice(0, 160)) }
      }
      return data
    }

    // ── 样式（模块系统认领，卸载时自动移除）──────────────────────────────

    const NAV_CSS = `
.dsh-nav-root {
  position: fixed;
  right: 2px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 30;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-height: 152px;
  pointer-events: auto;
}
.dsh-nav-bar {
  width: 44px;
  height: 152px;
  flex: 0 0 auto;
  border-radius: 14px;
  background: rgba(128, 138, 160, 0.3);
  border: 1px solid rgba(128, 138, 160, 0.35);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  outline: none;
  opacity: 0.92;
  transition: background-color 0.18s ease, border-color 0.18s ease, opacity 0.18s ease;
}
.dsh-nav-bar:hover,
.dsh-nav-bar:focus-visible {
  background: rgba(104, 116, 146, 0.55);
  border-color: var(--dsw-alias-brand-primary);
  opacity: 1;
}
.dsh-nav-icon {
  color: var(--dsw-alias-label-secondary);
  flex: 0 0 auto;
}
.dsh-nav-bar:hover .dsh-nav-icon {
  color: var(--dsw-alias-label-primary);
}
.dsh-nav-panel {
  width: 288px;
  height: clamp(220px, 58vh, 460px);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  overflow: hidden;
  animation: dsh-nav-panel-in 0.16s ease-out;
}
@keyframes dsh-nav-panel-in {
  from { opacity: 0; transform: translateX(10px); }
  to { opacity: 1; transform: translateX(0); }
}
.dsh-nav-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 9px;
  flex: 0 0 auto;
}
.dsh-nav-panel-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--dsw-alias-label-primary);
}
.dsh-nav-panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh-nav-panel-count {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-nav-refresh {
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 6px;
}
.dsh-nav-refresh:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-nav-filters {
  display: flex;
  align-items: center;
  padding: 0 12px 9px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: 0 0 auto;
}
.dsh-nav-segment {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  gap: 2px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-base);
}
.dsh-nav-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-weight: 500;
  line-height: 20px;
  padding: 0 11px;
  border-radius: 999px;
  cursor: pointer;
  font-family: inherit;
  transition: color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;
}
.dsh-nav-chip:hover {
  color: var(--dsw-alias-label-primary);
}
.dsh-nav-chip[aria-pressed='true'] {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
}
.dsh-nav-chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-label-secondary);
  flex: 0 0 auto;
}
.dsh-nav-chip-dot[data-group='user'] { background: var(--dsw-alias-brand-primary); }
.dsh-nav-chip-dot[data-group='assistant'] { background: var(--dsw-alias-state-success-primary); }
.dsh-nav-chip:not([aria-pressed='true']) .dsh-nav-chip-dot { opacity: 0.45; }
.dsh-nav-panel-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  scrollbar-width: thin;
}
.dsh-nav-panel-list::-webkit-scrollbar { width: 6px; }
.dsh-nav-panel-list::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-border-l2);
  border-radius: 3px;
}
.dsh-nav-older {
  flex: 0 0 auto;
  margin: 2px 4px 6px;
  padding: 6px 10px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
  transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
}
.dsh-nav-older:hover:not(:disabled) {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-nav-older:disabled {
  cursor: default;
  opacity: 0.6;
}
.dsh-nav-older-error {
  flex: 0 0 auto;
  margin: 0 4px 6px;
  font-size: 10px;
  line-height: 14px;
  color: var(--dsw-alias-state-error-primary);
  word-break: break-all;
}
.dsh-nav-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 7px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
  flex: 0 0 auto;
}
.dsh-nav-item:hover,
.dsh-nav-item:focus-visible {
  background: var(--dsw-alias-bg-layer-1);
  outline: none;
}
.dsh-nav-item-active {
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: inset 2px 0 0 0 var(--dsw-alias-brand-primary);
}
.dsh-nav-item-history .dsh-nav-summary {
  color: var(--dsw-alias-label-secondary);
}
.dsh-nav-role {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 600;
  line-height: 17px;
  padding: 0 6px;
  border-radius: 6px;
  margin-top: 1px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.dsh-nav-role[data-kind='user'],
.dsh-nav-role[data-kind='steering'] { color: var(--dsw-alias-brand-primary); }
.dsh-nav-role[data-kind='assistant-step'] { color: var(--dsw-alias-state-success-primary); }
.dsh-nav-summary {
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-primary);
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-all;
}
.dsh-nav-empty {
  margin: auto;
  padding: 20px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-nav-flash {
  animation: dsh-nav-flash-anim 1.5s ease-out 1 both;
  border-radius: 12px;
}
@keyframes dsh-nav-flash-anim {
  0% { background-color: rgba(255, 176, 32, 0); box-shadow: inset 0 0 0 2px rgba(255, 176, 32, 0); }
  10% { background-color: rgba(255, 176, 32, 0.3); box-shadow: inset 0 0 0 2px rgba(255, 176, 32, 0.9); }
  60% { background-color: rgba(255, 176, 32, 0.12); box-shadow: inset 0 0 0 2px rgba(255, 176, 32, 0.4); }
  100% { background-color: rgba(255, 176, 32, 0); box-shadow: inset 0 0 0 2px rgba(255, 176, 32, 0); }
}
`

    const styleTag = document.createElement('style')
    styleTag.textContent = NAV_CSS
    document.head.appendChild(styleTag)

    // ── 插件导出 ──────────────────────────────────────────────────────────

    exports.name = 'dsh-message-display'

    exports.inject = ['slots']

    exports.apply = function apply(ctx) {
      function MessageNavigator(props) {
        const [open, setOpen] = React.useState(false)
        const [domItems, setDomItems] = React.useState([])
        const [history, setHistory] = React.useState([])
        const [activeKey, setActiveKey] = React.useState(null)
        const [showUser, setShowUser] = React.useState(true)
        const [showAI, setShowAI] = React.useState(true)
        const [loadingOlder, setLoadingOlder] = React.useState(false)
        const [noMore, setNoMore] = React.useState(false)
        const [olderStatus, setOlderStatus] = React.useState({ kind: 'idle', message: '' })
        const candidatesRef = React.useRef([])
        const lastSpyRef = React.useRef(0)
        const listRef = React.useRef(null)
        const historyRef = React.useRef([])
        const itemsRef = React.useRef([])
        const currentIdRef = React.useRef(undefined)
        const busyRef = React.useRef(false)
        const noMoreRef = React.useRef(false)
        const pendingAnchorRef = React.useRef(null)
        const currentId = props.useSessions(s => s.current)
        currentIdRef.current = currentId
        noMoreRef.current = noMore

        const items = mergeItems(history, domItems)
        itemsRef.current = items
        historyRef.current = history
        const visible = items.filter(item => item.group === 'assistant' ? showAI : showUser)

        const refresh = () => {
          const next = collect()
          candidatesRef.current = next.candidates
          setDomItems(next.items)
          itemsRef.current = mergeItems(historyRef.current, next.items)
        }

        const loadOlder = async () => {
          if (busyRef.current || noMoreRef.current) return
          const sid = currentIdRef.current
          if (sid === undefined) {
            setOlderStatus({ kind: 'error', message: '无法确定当前会话' })
            return
          }
          const current = itemsRef.current
          if (current.length === 0) return
          busyRef.current = true
          setLoadingOlder(true)
          setOlderStatus({ kind: 'loading', message: '' })
          try {
            const before = current.slice(0, 120).map(it => ({ group: it.group, id: it.id }))
            const result = await fetchHistory({ sessionId: sid, before, limit: 30 })
            if (result !== null && typeof result === 'object' && result.ok === true && Array.isArray(result.items)) {
              // 记录视口锚点，插入更早条目后保持浏览位置稳定
              const list = listRef.current
              if (list !== null && result.items.length > 0) {
                const lr = list.getBoundingClientRect()
                let anchorEl = null
                for (const child of list.children) {
                  if (!child.hasAttribute('data-nav-key')) continue
                  const r = child.getBoundingClientRect()
                  if (r.bottom > lr.top + 4) {
                    anchorEl = child
                    break
                  }
                }
                if (anchorEl !== null) {
                  const r = anchorEl.getBoundingClientRect()
                  pendingAnchorRef.current = {
                    key: anchorEl.getAttribute('data-nav-key'),
                    top: r.top - lr.top,
                  }
                }
              }
              let addedCount = 0
              setHistory(prev => {
                const seen = new Set(prev.map(h => h.group + '\u0000' + h.id))
                const added = []
                for (const it of result.items) {
                  if (it === null || typeof it !== 'object') continue
                  const idk = it.group + '\u0000' + it.id
                  if (seen.has(idk)) continue
                  seen.add(idk)
                  added.push({ ...it, role: KIND_LABELS[it.kind] || it.kind, fromHistory: true })
                }
                addedCount = added.length
                return added.concat(prev)
              })
              if (addedCount === 0 || result.noMore === true || result.items.length === 0) {
                setNoMore(true)
                setOlderStatus({ kind: 'done', message: '' })
              } else {
                setOlderStatus({ kind: 'idle', message: '' })
              }
            } else {
              const message = result !== null && typeof result === 'object' && typeof result.error === 'string'
                ? result.error
                : '未知错误'
              setOlderStatus({ kind: 'error', message })
              console.error('[dsh-message-display] fetch-history failed:', message)
            }
          } catch (error) {
            const message = String(error && error.message ? error.message : error)
            setOlderStatus({ kind: 'error', message })
            console.error('[dsh-message-display] fetch-history threw:', error)
          } finally {
            busyRef.current = false
            setLoadingOlder(false)
          }
        }

        React.useEffect(() => {
          setHistory([])
          setNoMore(false)
          setOlderStatus({ kind: 'idle', message: '' })
          pendingAnchorRef.current = null
          refresh()
        }, [currentId])

        const spy = () => {
          const now = Date.now()
          if (now - lastSpyRef.current < 100) return
          lastSpyRef.current = now
          const scrollport = document.querySelector('[data-conversation-scroll]')
          if (scrollport === null) {
            setActiveKey(null)
            return
          }
          let candidates = candidatesRef.current
          if (candidates.some(c => !c.el.isConnected)) {
            const next = collect()
            candidatesRef.current = next.candidates
            candidates = next.candidates
            setDomItems(next.items)
            itemsRef.current = mergeItems(historyRef.current, next.items)
          }
          if (candidates.length === 0) {
            setActiveKey(null)
            return
          }
          const top = scrollport.getBoundingClientRect().top + 10
          let active = candidates[candidates.length - 1].key
          for (const c of candidates) {
            if (c.el.getBoundingClientRect().bottom > top) {
              active = c.key
              break
            }
          }
          setActiveKey(active)
        }

        React.useEffect(() => {
          if (!open) return
          const onScroll = () => { spy() }
          document.addEventListener('scroll', onScroll, true)
          spy()
          return () => document.removeEventListener('scroll', onScroll, true)
        }, [open])

        React.useEffect(() => {
          if (!open) return
          const id = window.setInterval(() => { refresh() }, 1500)
          return () => window.clearInterval(id)
        }, [open])

        React.useEffect(() => {
          if (!open) return
          const onKey = (event) => {
            if (event.key === 'Escape') setOpen(false)
          }
          document.addEventListener('keydown', onKey)
          return () => document.removeEventListener('keydown', onKey)
        }, [open])

        React.useEffect(() => {
          if (!open) return
          const list = listRef.current
          if (list === null) return
          const onListScroll = () => {
            if (list.scrollTop <= 10) void loadOlder()
          }
          list.addEventListener('scroll', onListScroll, { passive: true })
          return () => list.removeEventListener('scroll', onListScroll)
        }, [open])

        React.useLayoutEffect(() => {
          const anchor = pendingAnchorRef.current
          pendingAnchorRef.current = null
          if (anchor === null) return
          const list = listRef.current
          if (list === null) return
          for (const child of list.children) {
            if (child.getAttribute('data-nav-key') === anchor.key) {
              const lr = list.getBoundingClientRect()
              const r = child.getBoundingClientRect()
              list.scrollTop += (r.top - lr.top) - anchor.top
              break
            }
          }
        }, [history])

        React.useEffect(() => {
          if (!open || activeKey === null) return
          const list = listRef.current
          if (list === null) return
          let itemEl = null
          for (const child of list.children) {
            if (child.getAttribute('data-nav-key') === activeKey) {
              itemEl = child
              break
            }
          }
          if (itemEl === null) return
          const lr = list.getBoundingClientRect()
          const ir = itemEl.getBoundingClientRect()
          if (ir.top < lr.top) list.scrollTop -= lr.top - ir.top + 4
          else if (ir.bottom > lr.bottom) list.scrollTop += ir.bottom - lr.bottom + 4
        }, [open, activeKey, showUser, showAI])

        const jumpToHistory = (key, userAlt) => {
          let row = findRow(key)
          if (row === null && userAlt !== null) row = findRow(userAlt)
          if (row !== null) {
            flashAt(row)
            return
          }
          // 目标行还没渲染：自动触发聊天流的「加载更早」翻页，直到目标出现
          const maxAttempts = 15
          let attempts = 0
          const tick = () => {
            const target = findRow(key) ?? (userAlt !== null ? findRow(userAlt) : null)
            if (target !== null) {
              flashAt(target)
              return
            }
            attempts += 1
            if (attempts >= maxAttempts) return
            const btn = olderButton()
            if (btn !== null && !btn.disabled) btn.click()
            window.setTimeout(tick, 450)
          }
          tick()
        }

        const openPanel = () => {
          refresh()
          setOpen(true)
          window.setTimeout(() => { void loadOlder() }, 80)
        }

        const bar = React.createElement('div', {
          className: 'dsh-nav-bar',
          role: 'button',
          tabIndex: 0,
          title: open ? '收起消息导航' : '展开消息导航',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => { open ? setOpen(false) : openPanel() },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              open ? setOpen(false) : openPanel()
            }
          },
        },
          React.createElement('svg', {
            className: 'dsh-nav-icon',
            viewBox: '0 0 16 16',
            width: 16,
            height: 16,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            'aria-hidden': true,
          },
            React.createElement('path', { d: 'M2.5 4h11M2.5 8h11M2.5 12h11', strokeLinecap: 'round' }),
          ),
        )

        const olderLabel = loadingOlder
          ? '正在加载更早…'
          : olderStatus.kind === 'error'
            ? '加载失败，点击重试'
            : noMore
              ? '没有更早的消息了'
              : '↑ 加载更早'

        const panel = open ? React.createElement('div', {
          className: 'dsh-nav-panel',
          role: 'region',
          'aria-label': '消息导航',
        },
          React.createElement('div', { className: 'dsh-nav-panel-head' },
            React.createElement('span', { className: 'dsh-nav-panel-title' }, '消息导航'),
            React.createElement('span', { className: 'dsh-nav-panel-actions' },
              React.createElement('span', { className: 'dsh-nav-panel-count' }, String(visible.length)),
              React.createElement('button', {
                type: 'button',
                className: 'dsh-nav-refresh',
                title: '刷新列表',
                onClick: () => refresh(),
              }, '⟳'),
            ),
          ),
          React.createElement('div', { className: 'dsh-nav-filters' },
            React.createElement('div', { className: 'dsh-nav-segment', role: 'group', 'aria-label': '消息过滤' },
              React.createElement('button', {
                type: 'button',
                className: 'dsh-nav-chip',
                'aria-pressed': showUser ? 'true' : 'false',
                title: '显示 / 隐藏我的消息',
                onClick: () => setShowUser(v => !v),
              },
                React.createElement('span', { className: 'dsh-nav-chip-dot', 'data-group': 'user' }),
                '我',
              ),
              React.createElement('button', {
                type: 'button',
                className: 'dsh-nav-chip',
                'aria-pressed': showAI ? 'true' : 'false',
                title: '显示 / 隐藏 AI 回复',
                onClick: () => setShowAI(v => !v),
              },
                React.createElement('span', { className: 'dsh-nav-chip-dot', 'data-group': 'assistant' }),
                'AI',
              ),
            ),
          ),
          React.createElement('div', { className: 'dsh-nav-panel-list', ref: listRef },
            items.length > 0 ? React.createElement('button', {
              type: 'button',
              className: 'dsh-nav-older',
              disabled: loadingOlder || noMore,
              onClick: () => { void loadOlder() },
            }, olderLabel) : null,
            olderStatus.kind === 'error' && olderStatus.message !== ''
              ? React.createElement('div', { className: 'dsh-nav-older-error' }, olderStatus.message)
              : null,
            items.length === 0
              ? React.createElement('div', { className: 'dsh-nav-empty' }, '暂无消息')
              : visible.length === 0
                ? React.createElement('div', { className: 'dsh-nav-empty' }, '无匹配消息，请打开过滤器')
                : visible.map(item => React.createElement('button', {
                    type: 'button',
                    key: item.key,
                    'data-nav-key': item.key,
                    className: item.key === activeKey
                      ? 'dsh-nav-item dsh-nav-item-active' + (item.fromHistory === true ? ' dsh-nav-item-history' : '')
                      : 'dsh-nav-item' + (item.fromHistory === true ? ' dsh-nav-item-history' : ''),
                    title: item.summary,
                    onClick: () => {
                      const alt = item.kind === 'user' && item.key.indexOf('4:user') === 0
                        ? '8:steering' + item.key.slice(6)
                        : null
                      jumpToHistory(item.key, alt)
                      setActiveKey(item.key)
                    },
                  },
                    React.createElement('span', { className: 'dsh-nav-role', 'data-kind': item.kind }, item.role),
                    React.createElement('span', { className: 'dsh-nav-summary' }, item.summary),
                  )),
          ),
        ) : null

        return React.createElement('div', {
          className: 'dsh-nav-root',
          onMouseEnter: openPanel,
          onMouseLeave: () => setOpen(false),
        },
          panel,
          bar,
        )
      }

      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'dsh-message-display', order: 50, label: '消息导航' },
        props => React.createElement(MessageNavigator, props),
      ))
    }

    return module.exports
  },
})
