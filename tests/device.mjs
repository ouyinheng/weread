/**
 * 真机（Android WebView）驱动：连接 adb 转发出来的 WebView 调试端口。
 *
 * 与 tests/cdp.mjs 的区别是不会现起 Chrome —— 它只 attach 到已存在的页面，
 * 用来在模拟器上点按钮、填表单、读布局。截图走 adb screencap（带系统栏，
 * 更接近用户看到的样子）。
 *
 * 用法：先 adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
 *   const d = await connect(9333)
 *   await d.eval('document.title')
 *   await d.screenshot('/tmp/x.png')
 */
import { execSync } from 'child_process'

const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`

export async function connect(port = 9333) {
  const list = JSON.parse(execSync(`curl -s http://127.0.0.1:${port}/json/list`, { encoding: 'utf8' }))
  const target = list.find(t => t.type === 'page' && t.url.startsWith('https://localhost'))
  if (!target) throw new Error('没有找到应用页面: ' + JSON.stringify(list.map(t => t.url)))
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = e => rej(new Error('ws error'))
  })

  let id = 0
  const pending = new Map()
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  }

  function send(method, params = {}, timeoutMs = 20000) {
    const mid = ++id
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
      setTimeout(() => {
        if (pending.has(mid)) { pending.delete(mid); reject(new Error('CDP timeout: ' + method)) }
      }, timeoutMs)
    })
  }

  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    }
    return r.result.value
  }

  return {
    evaluate,
    send,
    ws,
    close: () => ws.close(),
    /** 真机截图（含系统栏），返回本地路径。 */
    async screenshot(path) {
      execSync(`"${ADB}" exec-out screencap -p > "${path}"`)
      return path
    },
    /** 真实触摸（走系统输入，能触发触摸事件与手势识别）。 */
    tap(x, y) {
      execSync(`"${ADB}" shell input tap ${Math.round(x)} ${Math.round(y)}`)
    },
    swipe(x1, y1, x2, y2, ms = 300) {
      execSync(`"${ADB}" shell input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${ms}`)
    },
    /** 等待某个选择器出现。 */
    async waitFor(sel, timeoutMs = 8000) {
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        const ok = await evaluate(`!!document.querySelector(${JSON.stringify(sel)})`)
        if (ok) return true
        await new Promise(r => setTimeout(r, 200))
      }
      throw new Error('等不到元素: ' + sel)
    },
    /**
     * 回到底栏所在的一级页。
     *
     * 二级页（设置 / 目录 / 书源 / 影视子页）不渲染底栏，直接找 tab 会找不到，
     * 所以先按路由历史退回去。用 history.back() 而不是点各自的返回按钮：
     * 每个二级页的返回类名都不一样，历史栈反而更可靠。
     */
    async backToTabs(max = 4) {
      for (let i = 0; i < max; i++) {
        if (await evaluate(`!!document.querySelector('.tabbar')`)) return true
        await evaluate(`history.back(); true`)
        await new Promise(r => setTimeout(r, 700))
      }
      throw new Error('退不回一级页: ' + (await evaluate('location.pathname')))
    },
    /** 点底栏的某个 tab。 */
    async goTab(label) {
      await this.backToTabs()
      const ok = await evaluate(`(() => {
        const t = [...document.querySelectorAll('.tabbar__item')].find(x => x.textContent.trim() === ${JSON.stringify(label)})
        if (!t) return false
        t.click(); return true
      })()`)
      await new Promise(r => setTimeout(r, 800))
      return ok
    },
  }
}
