/**
 * dsh-message-navigator，Node（Host）半边。
 *
 * 浏览器半边需要「加载更早」的历史消息：那些消息还在会话日志里，
 * 尚未被聊天流渲染进 DOM。本半边通过 `webServer` 注册一个同源 HTTP 路由，
 * 用 `sessionQuery.readSession()` 读取当前会话的完整日志，
 * 把「边界之前」的用户输入与每轮 AI 最终回复（去重、去 thinking、去工具）打包成 JSON 返回。
 *
 * 一个没有 webServer 的 surface（TUI / ACP / headless）自然就没有这条路由，
 * 面板只展示 DOM 里已有的最近消息，功能正常降级。
 */

/** 浏览器半边请求历史消息的同源路由。 */
export const HISTORY_ROUTE = '/dsh-message-navigator/fetch-history'

export const name = 'dsh-message-navigator'

export const inject = ['webServer']

/** 每页最多返回的条目数（客户端传的值会被夹在 1..50）。 */
const DEFAULT_LIMIT = 30

/** 摘要长度，与浏览器半边面板显示一致。 */
const SUMMARY_LENGTH = 44

/** 从内容块数组里拼接纯文本（只取 text 块，自动排除 thinking / 工具参数）。 */
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object'
      && block.kind === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** 截断摘要。 */
function summarize(text, len) {
  return text.length > len ? text.slice(0, len) + '…' : text
}

/** 读取请求体（JSON 字符串），限制 1MB。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) {
        reject(new Error('payload too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

/** 写 JSON 响应。 */
function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: HISTORY_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      let args = {}
      try {
        args = JSON.parse((await readBody(req)) || '{}')
      } catch {
        json(res, 400, { ok: false, error: 'bad-json' })
        return
      }
      const sessionId = args !== null && typeof args === 'object' && typeof args.sessionId === 'string'
        ? args.sessionId
        : ''
      const before = args !== null && typeof args === 'object' && Array.isArray(args.before)
        ? args.before
        : []
      const limit = args !== null && typeof args === 'object' && typeof args.limit === 'number'
        ? Math.min(50, Math.max(1, Math.floor(args.limit)))
        : DEFAULT_LIMIT
      if (sessionId === '') {
        json(res, 400, { ok: false, error: 'no-session' })
        return
      }
      const sessionQuery = ctx.get('sessionQuery')
      if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') {
        json(res, 503, { ok: false, error: 'sessionQuery unavailable' })
        return
      }
      let events
      try {
        const snapshot = await sessionQuery.readSession(sessionId)
        events = Array.isArray(snapshot.events) ? snapshot.events : []
      } catch (error) {
        json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
        return
      }

      // 边界：客户端把面板里全部条目的身份发来，这里取「所有能匹配到的事件的最小 seq」。
      // 比只依赖最早一条更稳健：窗口顶部若是进行中轮次 / 中断输出等没有
      // assistant/message 的条目，其他更早的条目仍能定位边界。
      let boundarySeq = Infinity
      for (const event of events) {
        if (event === null || typeof event !== 'object') continue
        if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
        const data = event.data
        if (data === null || typeof data !== 'object') continue
        for (const ref of before) {
          if (ref === null || typeof ref !== 'object') continue
          if (event.type === 'user/message' && ref.group === 'user'
            && String(data.id) === String(ref.id)) {
            if (event.seq < boundarySeq) boundarySeq = event.seq
          }
          if (event.type === 'assistant/message' && ref.group === 'assistant'
            && String(data.turn) + ':' + String(data.step) === String(ref.id)) {
            if (event.seq < boundarySeq) boundarySeq = event.seq
          }
        }
      }
      if (boundarySeq === Infinity) {
        json(res, 200, { ok: true, items: [], noMore: true, note: 'boundary-not-found' })
        return
      }

      // 收集边界之前的消息：用户输入 + 每轮最终 AI 回复（同一轮多步只保留最后一步）。
      const byId = new Map()
      const lastAssistantByTurn = new Map()
      for (const event of events) {
        if (event === null || typeof event !== 'object') continue
        if (!(event.seq < boundarySeq)) continue
        const op = event.surfaceOp
        if (op !== undefined && op !== 'append') continue
        if (event.type === 'user/message') {
          const data = event.data
          if (data === null || typeof data !== 'object') continue
          const source = data.source
          if (source === null || typeof source !== 'object' || source.kind !== 'user') continue
          const text = blocksToText(data.content)
          if (text === '') continue
          byId.set('user\u0000' + String(data.id), {
            group: 'user',
            id: String(data.id),
            seq: event.seq,
            key: '4:user' + String(data.id),
            kind: 'user',
            summary: summarize(text, SUMMARY_LENGTH),
          })
        } else if (event.type === 'assistant/message') {
          const data = event.data
          if (data === null || typeof data !== 'object') continue
          if (typeof data.turn !== 'number' || typeof data.step !== 'number') continue
          const message = data.message
          const text = message !== null && typeof message === 'object' ? blocksToText(message.content) : ''
          lastAssistantByTurn.set(data.turn, {
            group: 'assistant',
            id: String(data.turn) + ':' + String(data.step),
            seq: event.seq,
            key: '14:assistant-step' + String(data.turn) + ':' + String(data.step),
            kind: 'assistant-step',
            text,
          })
        }
      }
      for (const entry of lastAssistantByTurn.values()) {
        if (entry.text === '') continue
        byId.set('assistant\u0000' + entry.id, {
          group: entry.group,
          id: entry.id,
          seq: entry.seq,
          key: entry.key,
          kind: entry.kind,
          summary: summarize(entry.text, SUMMARY_LENGTH),
        })
      }
      const entries = Array.from(byId.values())
      entries.sort((left, right) => left.seq - right.seq)
      const page = entries.length > limit ? entries.slice(entries.length - limit) : entries
      json(res, 200, { ok: true, items: page, noMore: entries.length <= limit })
    },
  }))
}
