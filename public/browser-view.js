// The browser tab: the agent's Chrome live, and, while "Take control" is on, the owner's mouse and keys on it.
import { addressUrl, cdpKeyEvents, modifiersOf, pagePoint } from './browser-input.js'
import { icon } from './icons.js'

const BUTTONS = ['left', 'middle', 'right']

/** Builds the view for one member; `dispose` ends its stream and listeners. */
export function mountBrowser(memberId, { h, t, api }) {
  const stopped = new AbortController()
  const on = (target, type, listener, options = {}) => target.addEventListener(type, listener, { signal: stopped.signal, ...options })
  let viewer = ''
  let metadata = null
  let controlling = false
  let held = false
  // One at a time, so a key's down and up, or a drag's moves, reach the page in order.
  // ponytail: every mouse move is a request; coalesce them per frame if a drag ever feels slow.
  let queue = Promise.resolve()
  const send = (body) => {
    if (!viewer) return
    const payload = { viewer, ...body }
    queue = queue.then(() => api(`members/${memberId}/browser/input`, payload)).catch(() => {})
  }
  const cdp = (method, params) => send({ method, params })
  const button = (name, label, run) => h('button', { class: 'icon-xs', type: 'button', title: label, 'aria-label': label, onClick: run }, icon(name))

  const address = h('input', { class: 'browser-address', spellcheck: 'false', 'aria-label': t('browser.address') })
  const tabs = h('select', { class: 'browser-tabs', 'aria-label': t('browser.tabs'), onChange: () => send({ select: tabs.value }) })
  const control = h('button', { class: 'ghost', type: 'button', 'aria-pressed': 'false', onClick: () => setControl(!controlling) }, t('browser.control'))
  const badge = h('span', { class: 'browser-badge', hidden: true }, t('browser.controlling'))
  const note = h('p', { class: 'hint browser-note' }, t('browser.starting'))
  const frame = h('img', { class: 'browser-frame', alt: '', hidden: true, draggable: 'false' })
  // Keys land in this hidden box first, so the IME composes Hangul before anything reaches the page.
  const keys = h('textarea', { class: 'browser-keys', 'aria-label': t('browser.keys'), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' })
  const composing = h('span', { class: 'browser-ime', hidden: true })
  const view = h('div', { class: 'browser-view' }, note, frame, keys, composing)
  const node = h(
    'section',
    { class: 'studio-page' },
    h(
      'div',
      { class: 'page-toolbar' },
      button('arrow-left', t('browser.back'), () => send({ history: -1 })),
      button('arrow-right', t('browser.forward'), () => send({ history: 1 })),
      button('refresh', t('browser.reload'), () => cdp('Page.reload')),
      address,
      tabs,
      badge,
      control
    ),
    view
  )

  function setControl(value) {
    controlling = value
    held = false
    control.setAttribute('aria-pressed', String(value))
    badge.hidden = !value
    view.classList.toggle('controlling', value)
    if (value) keys.focus()
  }
  const show = (text) => {
    note.textContent = text
    note.hidden = false
    frame.hidden = true
  }

  on(address, 'keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || !address.value.trim()) return
    cdp('Page.navigate', { url: addressUrl(address.value) })
    address.blur()
  })

  // --- Mouse: presses, releases and drags on the frame, mapped onto the page.
  const mouse = (type, event, extra) => {
    if (!metadata) return
    cdp('Input.dispatchMouseEvent', { type, ...pagePoint(event.clientX, event.clientY, frame.getBoundingClientRect(), metadata), modifiers: modifiersOf(event), ...extra })
  }
  on(frame, 'mousedown', (event) => {
    if (!controlling) return
    event.preventDefault()
    keys.focus()
    held = true
    mouse('mousePressed', event, { button: BUTTONS[event.button] ?? 'left', buttons: event.buttons, clickCount: event.detail || 1 })
  })
  on(document, 'mousemove', (event) => held && mouse('mouseMoved', event, { button: 'left', buttons: event.buttons }))
  on(document, 'mouseup', (event) => {
    if (!held) return
    held = false
    mouse('mouseReleased', event, { button: BUTTONS[event.button] ?? 'left', buttons: event.buttons, clickCount: event.detail || 1 })
  })
  on(frame, 'wheel', (event) => {
    if (!controlling) return
    event.preventDefault()
    mouse('mouseWheel', event, { deltaX: event.deltaX, deltaY: event.deltaY })
  }, { passive: false })
  on(frame, 'contextmenu', (event) => controlling && event.preventDefault())

  // --- Keys: named keys and shortcuts as key events; text, composed or pasted, inserted whole.
  const flush = () => {
    composing.hidden = true
    if (!keys.value) return
    cdp('Input.insertText', { text: keys.value })
    keys.value = ''
  }
  on(keys, 'keydown', (event) => {
    if (!controlling || event.isComposing || event.keyCode === 229) return
    const events = cdpKeyEvents(event)
    if (!events.length) return
    event.preventDefault()
    for (const params of events) cdp('Input.dispatchKeyEvent', params)
  })
  on(keys, 'input', (event) => controlling && !event.isComposing && flush())
  on(keys, 'compositionupdate', (event) => {
    composing.textContent = event.data
    composing.hidden = !event.data
  })
  on(keys, 'compositionend', () => controlling && flush())
  on(keys, 'paste', (event) => {
    if (!controlling) return
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain')
    if (text) cdp('Input.insertText', { text })
  })

  // --- The stream: who this view is, the tabs, and frames.
  const source = new EventSource(`/api/members/${memberId}/browser/stream`)
  source.addEventListener('viewer', (event) => {
    viewer = JSON.parse(event.data).viewer
  })
  source.addEventListener('pages', (event) => {
    const { current, pages } = JSON.parse(event.data)
    tabs.replaceChildren(...pages.map((page) => h('option', { value: page.id, selected: page.id === current }, page.title || page.url || t('browser.untitled'))))
    const page = pages.find(({ id }) => id === current)
    tabs.title = page?.url ?? ''
    if (page && document.activeElement !== address) address.value = page.url
  })
  source.addEventListener('frame', (event) => {
    const data = JSON.parse(event.data)
    metadata = data.metadata
    frame.src = `data:image/jpeg;base64,${data.data}`
    frame.hidden = false
    note.hidden = true
  })
  source.addEventListener('closed', () => {
    source.close()
    setControl(false)
    show(t('browser.closed'))
  })
  // A failed stream carries no body; asking again turns the reason (say, no Chrome) into words.
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) void api(`members/${memberId}/browser/ensure`, {}).then(() => show(t('browser.closed')), (error) => show(error.message))
  }

  return {
    node,
    dispose() {
      source.close()
      stopped.abort()
    }
  }
}
