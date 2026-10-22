/**
 * Minimal Chrome DevTools Protocol driver (no puppeteer needed).
 * Node 22 ships a global WebSocket, so this stays dependency-free.
 *
 * Why it talks to the *browser* endpoint instead of a page's
 * `webSocketDebuggerUrl`:
 *
 *  - a tab created through `/json/new` on Chrome 155 (headless, macOS) accepts
 *    the WebSocket but never answers a single command;
 *  - `/json/list` can be empty for the first second while Chrome opens its
 *    first tab, and picking the wrong target then hangs the whole run;
 *  - `Page.enable` is never answered on that build, and because commands are
 *    processed in order it blocks every later Page command behind it. Nothing
 *    here needs the domain: DOM state comes from `Runtime.evaluate`, and
 *    navigation is waited on by polling `document.readyState`.
 *
 * So: connect once to the browser, `Target.createTarget`, attach with
 * `flatten: true`, and run every page command in that session.
 */
import { spawn, execSync } from 'child_process'
import { rmSync, readFileSync, existsSync, writeFileSync } from 'fs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** DevTools port of the browser this module launched (`--remote-debugging-port=0`). */
let port = 0

/** Last words from Chrome's stderr, for a useful failure message. */
let launchLog = () => ''

export async function launch() {
  /*
   * A crashed run leaves its headless Chrome behind. Each run gets its own
   * profile and its own port so a stray browser cannot get in the way, but it
   * still holds memory — clear the leftovers. The pattern deliberately does not
   * mention the port: a `-f` pattern that appears in this process's own command
   * line makes pkill shoot the shell that is running it.
   */
  try {
    execSync('pkill -f "wr-profile"', { stdio: 'ignore' })
  } catch {
    /* nothing to kill — the normal case */
  }

  const profile = `/tmp/wr-profile-${process.pid}-${Date.now()}`
  rmSync(profile, { recursive: true, force: true })

  const proc = spawn(CHROME, [
    '--headless=new',
    /*
     * Chrome's own sandbox cannot initialise inside this machine's sandboxed
     * shell ("Failed to initialize sandbox: Operation not permitted"), which
     * kills its network and GPU services and leaves the DevTools endpoint
     * unreachable — intermittently, which is why the suite used to pass and
     * then stop. The browser renders only trusted local pages here, so running
     * it without its sandbox is fine.
     */
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Port 0: let Chrome pick a free one and write it to DevToolsActivePort. A
    // fixed port races with the previous browser, which makes the new one fail
    // to bind and exit while the dying one still answers the probe.
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // A system HTTP proxy (ClashX & co.) otherwise intercepts 127.0.0.1 and
    // stalls the navigation to the dev server.
    '--no-proxy-server',
    '--disable-gpu',
    '--window-size=420,900',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  // Keep the tail of Chrome's own stderr: when it refuses to start, its message
  // is far more useful than "no page target".
  let chromeLog = ''
  proc.stderr?.on('data', (b) => { chromeLog = (chromeLog + String(b)).slice(-1200) })
  launchLog = () => chromeLog

  const portFile = `${profile}/DevToolsActivePort`
  for (let i = 0; i < 80; i++) {
    if (existsSync(portFile)) {
      const n = Number(readFileSync(portFile, 'utf8').split('\n')[0].trim())
      if (Number.isFinite(n) && n > 0) {
        port = n
        await new Promise(r => setTimeout(r, 200))
        return proc
      }
    }
    await new Promise(r => setTimeout(r, 250))
  }
  proc.kill()
  throw new Error('Chrome did not start')
}

function devtoolsUrl(path) {
  return `http://127.0.0.1:${port}${path}`
}

export async function newPage(url) {
  const client = await openBrowserSession()
  if (url) await client.goto(url, 400)
  return client
}

async function openBrowserSession() {
  // The port file appears before the HTTP endpoint accepts connections, so the
  // first probe can be reset. Retry until it answers.
  let info = null
  for (let i = 0; i < 150 && !info; i++) {
    try {
      const res = await fetch(devtoolsUrl('/json/version'))
      if (res.ok) info = await res.json()
    } catch {
      /* endpoint not listening yet */
    }
    if (!info) await new Promise(r => setTimeout(r, 200))
  }
  if (!info) throw new Error(`DevTools endpoint never answered on port ${port}\n${launchLog()}`)

  const ws = new WebSocket(info.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  let nextId = 0
  let sessionId = null
  const pending = new Map()
  const listeners = []

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`))
      else p.resolve(msg.result)
    } else {
      for (const fn of listeners) fn(msg)
    }
  })

  function send(method, params = {}, timeoutMs = 30000) {
    const id = ++nextId
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify(payload))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, timeoutMs)
    })
  }

  function once(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`event timeout: ${method}`)), timeoutMs)
      const fn = (msg) => {
        if (msg.method === method) {
          clearTimeout(timer)
          listeners.splice(listeners.indexOf(fn), 1)
          resolve(msg.params)
        }
      }
      listeners.push(fn)
    })
  }

  /** Open a fresh tab and run every subsequent command inside its session. */
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const attached = await send('Target.attachToTarget', { targetId, flatten: true })
  sessionId = attached.sessionId

  /** Evaluate an expression in the page, awaiting promises, returning JSON. */
  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(d.exception?.description || d.text || 'evaluate failed')
    }
    return r.result.value
  }

  async function goto(url, waitMs = 800) {
    await send('Page.navigate', { url })
    // Let the new document commit first: an evaluate aimed at the outgoing
    // context while it is torn down never comes back.
    await new Promise(r => setTimeout(r, 350))
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      try {
        const r = await send(
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
          2500
        )
        if (r?.result?.value === 'complete') break
      } catch {
        /* execution context is being replaced mid-navigation */
      }
      await new Promise(r => setTimeout(r, 150))
    }
    await new Promise(r => setTimeout(r, waitMs))
  }

  async function screenshot(path) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path, Buffer.from(data, 'base64'))
  }

  function close() {
    try { ws.close() } catch {}
  }

  return { send, once, evaluate, goto, screenshot, close, ws }
}
