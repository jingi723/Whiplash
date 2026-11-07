// Agent output is untrusted and this page can drive agents, so every value goes through textContent.
import { addressTo } from './compose.js'
import { createTranslator, pickLocale } from './i18n.js'
import { colorMode, measure, mountTerminal, terminalTheme } from './terminal.js'

const LOW_STAMINA = 25
const DEFAULT_WINDOW = 200_000
const LARGE_WINDOW = 1_000_000
const LIVE_SESSION_MS = 120_000
const MENTION_QUERY = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u
const NEAR_BOTTOM_PX = 120

const ui = {
  channels: [],
  activity: {},
  queued: [],
  terminals: [],
  terminalStatus: {},
  replyTo: {},
  replyMessage: {},
  channelId: null,
  studioId: null
}
const main = document.querySelector('#main')
const channelNav = document.querySelector('#channels')
const dialog = document.querySelector('#dialog')
const LOCALE_KEY = 'whiplash.locale'
const THEME_KEY = 'whiplash.theme'

function readStored(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private windows can refuse storage; the choice then lasts for this page only.
  }
}

/** An explicit light/dark choice wins; without one the page follows the system setting. */
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
}

applyTheme(readStored(THEME_KEY))

function savedLocale() {
  try {
    return localStorage.getItem(LOCALE_KEY)
  } catch {
    return null
  }
}

let locale = pickLocale(savedLocale(), navigator.languages)
let t = createTranslator(locale)

function setLocale(next) {
  locale = next
  t = createTranslator(locale)
  try {
    localStorage.setItem(LOCALE_KEY, locale)
  } catch {
    // Private windows can refuse storage; the choice then lasts for this page only.
  }
  applyStaticText()
  if (shell) shell.messageIds = []
  render()
}

const USAGE_REFRESH_MS = 120_000
let usage = null

function resetLabel(resetsAt) {
  if (!resetsAt) return ''
  const date = new Date(resetsAt)
  const sameDay = date.toDateString() === new Date().toDateString()
  const when = sameDay
    ? date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  return t('usage.resets', { when })
}

function usageRow(label, window) {
  const percent = Math.round(window.usedPercent)
  const fill = h('div')
  fill.style.width = `${percent}%`
  return h(
    'div',
    { class: 'usage-row' },
    h('span', { class: 'usage-label' }, label, h('strong', {}, `${percent}%`)),
    h(
      'div',
      { class: `stamina${percent >= 100 - LOW_STAMINA ? ' low' : ''}`, role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent },
      fill
    ),
    h('span', { class: 'usage-reset' }, resetLabel(window.resetsAt))
  )
}

function renderUsage() {
  const box = document.querySelector('#usage')
  if (!usage) {
    box.replaceChildren()
    return
  }
  const provider = (name, data) => {
    const rows = [
      data.session && usageRow(`${name} ${t('usage.session')}`, data.session),
      data.weekly && usageRow(`${name} ${t('usage.weekly')}`, data.weekly)
    ].filter(Boolean)
    if (rows.length) return rows
    const note = data.error === 'signedOut' ? t('usage.signedOut') : data.error ? t('usage.unavailable') : t('usage.idle')
    return [h('div', { class: 'usage-row' }, h('span', { class: 'usage-label' }, name, h('span', { class: 'usage-reset' }, note)))]
  }
  box.replaceChildren(h('p', { class: 'label' }, t('usage.title')), ...provider('Claude', usage.claude), ...provider('Codex', usage.codex))
}

async function refreshUsage() {
  usage = await api('usage').catch(() => usage)
  renderUsage()
}

function applyStaticText() {
  document.documentElement.lang = locale
  document.querySelector('#channels-label').textContent = t('nav.channels')
  document.querySelector('#channels').setAttribute('aria-label', t('nav.channels'))
  document.querySelector('#new-channel').textContent = t('nav.newChannel')
  document.querySelector('#language').textContent = t('nav.switchLanguage')
  document.querySelector('#language').lang = locale === 'ko' ? 'en' : 'ko'
  document.querySelector('#theme').textContent = t(colorMode() === 'light' ? 'nav.darkTheme' : 'nav.lightTheme')
  renderUsage()
}

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) {
      element.addEventListener(key.slice(2).toLowerCase(), value)
    } else if (key === 'class') {
      element.className = value
    } else if (value === true) {
      element.setAttribute(key, '')
    } else if (value !== false && value !== undefined && value !== null) {
      element.setAttribute(key, value)
    }
  }
  element.append(...children.flat().filter((child) => child || child === 0))
  return element
}

async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = await response.json()
  if (!response.ok) {
    const params = data.params?.field ? { ...data.params, field: t(`fields.${data.params.field}`) } : data.params
    throw new Error(data.error ? t(`errors.${data.error}`, params) : t('request.failed'))
  }
  return data
}

function staminaOf({ contextTokens = 0, windowTokens }) {
  const window = windowTokens ?? (contextTokens > DEFAULT_WINDOW ? LARGE_WINDOW : DEFAULT_WINDOW)
  return Math.max(0, Math.round(100 - (contextTokens / window) * 100))
}

function staminaBar(member) {
  const percent = staminaOf(member)
  const fill = h('div')
  // Why not a style attribute: the page's CSP refuses those, and it should stay strict.
  fill.style.width = `${percent}%`
  return h(
    'div',
    {
      class: `stamina${percent <= LOW_STAMINA ? ' low' : ''}`,
      role: 'meter',
      'aria-label': t('stamina.aria', { name: member.name }),
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': percent,
      title: t('stamina.title', { percent, tokens: (member.contextTokens ?? 0).toLocaleString(locale) })
    },
    fill
  )
}

function staminaLabel(member) {
  const percent = staminaOf(member)
  if (percent === 0) return t('stamina.out')
  if (percent <= LOW_STAMINA) return t('stamina.low', { percent })
  return t(percent < 60 ? 'stamina.tired' : 'stamina.fresh', { percent })
}

/** The terminal's own OSC 7501 report wins while it is open: it sees approvals and work typed straight into it. */
function liveState(member) {
  const reported = ui.terminalStatus[member.id]?.state
  if (reported === 'blocked') return 'waiting'
  if (reported === 'working') return 'working'
  return ui.activity[member.id] ?? (ui.terminals.includes(member.id) ? 'attached' : 'idle')
}

function activityLabel(member) {
  const state = liveState(member)
  if (state === 'waiting') return h('span', { class: 'tag waiting' }, t('activity.waiting'))
  const activity = state === 'working' ? 'working' : ui.activity[member.id]
  const queued = ui.queued.includes(member.id) ? t('activity.queued') : ''
  if (activity === 'working') return h('span', { class: 'tag live' }, `${t('activity.working')}${queued}`)
  if (activity === 'checking') return h('span', { class: 'tag live' }, `${t('activity.checking')}${queued}`)
  return h('span', { class: 'tag' }, member.harness)
}

const projectFolder = (member) => member.writableRoots?.[0] ?? member.cwd

function inline(text, members) {
  const names = new Set(members.map(({ name }) => name.toLowerCase()).concat('all'))
  const nodes = []
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(@[\p{L}\p{N}_-]+)/gu
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    nodes.push(text.slice(cursor, match.index))
    const [token] = match
    if (match[1]) nodes.push(h('code', {}, token.slice(1, -1)))
    else if (match[2]) nodes.push(h('strong', {}, token.slice(2, -2)))
    else if (names.has(token.slice(1).toLowerCase())) nodes.push(h('span', { class: 'mention' }, token))
    else nodes.push(token)
    cursor = match.index + token.length
  }
  nodes.push(text.slice(cursor))
  return nodes
}

function markdown(text, members) {
  const parts = text.split(/```[^\n]*\n?/)
  return h(
    'div',
    { class: 'body' },
    parts.map((part, index) =>
      index % 2 === 1
        ? h('pre', {}, h('code', {}, part.replace(/\n$/, '')))
        : part.trim() && h('p', {}, inline(part.trim(), members))
    )
  )
}

function openStudio(id) {
  location.hash = `#/studio/${id}`
}

function messageRow(channel, message) {
  const { author } = message
  if (author.kind === 'system') {
    const member = channel.members.find(({ id }) => id === message.alertMemberId)
    const fresh = Date.now() - message.at < 2500
    return h(
      'div',
      {
        class: `system${member ? ' alert' : ''}${member && fresh ? ' fresh' : ''}`,
        role: member ? 'alert' : undefined
      },
      message.notice ? t(`notices.${message.notice.key}`, message.notice.params) : message.text,
      member &&
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            { class: 'danger', type: 'button', onClick: () => reject(member) },
            t('message.chair')
          ),
          h('button', { class: 'ghost', type: 'button', onClick: () => openStudio(member.id) }, 'Studio')
        )
    )
  }
  const member = author.kind === 'agent' && channel.members.find(({ id }) => id === author.memberId)
  const name = author.kind === 'human' ? t('message.conductor') : `@${author.name}`
  return h(
    'article',
    {
      class: `message${member ? ' selectable' : ''}`,
      'data-message': message.id,
      onClick: (event) => {
        // Selecting text or pressing a button inside the message must not retarget the composer.
        if (!member || event.target.closest('button, a')) return
        if (event.detail > 1) {
          // A double click selects a word; undo the retarget its first click already made.
          const previous = channel.members.find(({ id }) => id === targetBeforeClick.memberId)
          setReplyTo(channel, previous ?? null, { messageId: targetBeforeClick.messageId })
          return
        }
        if (getSelection()?.toString()) return
        targetBeforeClick = { memberId: ui.replyTo[channel.id], messageId: ui.replyMessage[channel.id] }
        setReplyTo(channel, member, { messageId: message.id })
      }
    },
    h(
      'header',
      {},
      member
        ? h('button', { class: 'who', type: 'button', onClick: () => openStudio(member.id) }, name)
        : h('span', { class: 'who' }, name),
      h('time', { class: 'time' }, new Date(message.at).toLocaleTimeString()),
      member &&
        h(
          'button',
          {
            class: 'tempo reply',
            type: 'button',
            'aria-pressed': 'false',
            onClick: () => setReplyTo(channel, member, { focus: true, messageId: message.id })
          },
          t('message.reply')
        ),
      member &&
        h(
          'button',
          { class: 'tempo', type: 'button', onClick: () => reject(member) },
          'Not quite my tempo'
        )
    ),
    markdown(message.text, channel.members)
  )
}

function createComposer(channelId) {
  const input = h('textarea', { rows: 2 })
  const list = h('ul', { class: 'suggestions', role: 'listbox', hidden: true })
  let active = 0

  const currentChannel = () => ui.channels.find(({ id }) => id === channelId)
  const query = () => MENTION_QUERY.exec(input.value.slice(0, input.selectionStart))?.[1]
  const matches = () => {
    const typed = query()
    if (typed === undefined) return []
    const lowered = typed.toLowerCase()
    return [...(currentChannel()?.members ?? []).map(({ name }) => name), 'all'].filter((name) =>
      name.toLowerCase().startsWith(lowered)
    )
  }
  const pick = (name) => {
    const caret = input.selectionStart
    const start = caret - (query()?.length ?? 0)
    input.setRangeText(`${name} `, start, caret, 'end')
    input.focus()
    refresh()
  }
  function refresh() {
    const options = matches()
    active = Math.min(active, Math.max(options.length - 1, 0))
    list.hidden = options.length === 0
    list.replaceChildren(
      ...options.map((name, index) =>
        h(
          'li',
          { role: 'option', 'aria-selected': String(index === active) },
          h(
            'button',
            {
              type: 'button',
              tabindex: -1,
              onMousedown: (event) => {
                event.preventDefault()
                pick(name)
              }
            },
            `@${name}`
          )
        )
      )
    )
  }
  const chip = h('span', { class: 'chip', hidden: true })
  const box = h('div', { class: 'composer-box' }, chip, input)
  box.addEventListener('animationend', () => box.classList.remove('lash'))
  const showTarget = (member) => {
    chip.hidden = !member
    chip.replaceChildren(
      ...(member
        ? [
            `@${member.name}`,
            h(
              'button',
              {
                type: 'button',
                'aria-label': t('composer.clearTarget'),
                onClick: () => setReplyTo(currentChannel(), null, { focus: true })
              },
              '×'
            )
          ]
        : [])
    )
  }
  const submit = async () => {
    const typed = input.value.trim()
    if (!typed) return
    const replyTo = currentChannel()?.members.find(({ id }) => id === ui.replyTo[channelId])
    const text = addressTo(typed, replyTo?.name)
    input.value = ''
    refresh()
    box.classList.remove('lash')
    void box.offsetWidth
    box.classList.add('lash')
    await api(`channels/${channelId}/messages`, { text, locale }).catch((error) => {
      input.value = typed
      alert(error.message)
    })
  }

  input.addEventListener('input', () => {
    active = 0
    refresh()
  })
  input.addEventListener('click', refresh)
  input.addEventListener('keydown', (event) => {
    // Enter confirms Hangul composition first; acting on it would send a half-typed syllable.
    if (event.isComposing) return
    const options = matches()
    if (options.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
        refresh()
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        pick(options[active])
        return
      }
    }
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0
    if (ui.replyTo[channelId] && (event.key === 'Escape' || (event.key === 'Backspace' && atStart))) {
      event.preventDefault()
      setReplyTo(currentChannel(), null)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  })
  return { element: h('div', { class: 'composer' }, list, box), input, list, showTarget }
}

let targetBeforeClick = {}

// Why no re-render: rebuilding the messages would drop the text the user is selecting.
function setReplyTo(channel, member, { focus = false, messageId } = {}) {
  if (!channel) return
  if (member) {
    ui.replyTo[channel.id] = member.id
    ui.replyMessage[channel.id] = messageId
  } else {
    delete ui.replyTo[channel.id]
    delete ui.replyMessage[channel.id]
  }
  if (shell?.channelId !== channel.id) return
  showReplyTarget(channel)
  if (focus) shell.composer.input.focus()
}

function showReplyTarget(channel) {
  const { composer, list } = shell
  const replyTo = channel.members.find(({ id }) => id === ui.replyTo[channel.id])
  if (!replyTo) delete ui.replyTo[channel.id]
  composer.showTarget(replyTo)
  composer.input.placeholder = replyTo
    ? t('composer.placeholderReply', { name: replyTo.name })
    : t('composer.placeholder', { channel: channel.name })
  const messageId = replyTo ? ui.replyMessage[channel.id] : undefined
  for (const row of list.querySelectorAll('.message.selectable')) {
    const targeted = row.dataset.message === messageId
    row.classList.toggle('targeted', targeted)
    row.querySelector('.reply')?.setAttribute('aria-pressed', String(targeted))
  }
}

/** Appends only new messages, so a state update does not drop a selection; anything else rebuilds. */
function renderMessages(channel) {
  const { list } = shell
  const ids = channel.messages.map(({ id }) => id)
  const membersKey = channel.members.map(({ id }) => id).join()
  const shown = shell.messageIds
  const appendOnly =
    shown.length > 0 &&
    shell.membersKey === membersKey &&
    shown.length <= ids.length &&
    shown.every((id, index) => ids[index] === id)
  if (!appendOnly) {
    list.replaceChildren()
  }
  const fresh = channel.messages.slice(appendOnly ? shown.length : 0)
  list.append(...fresh.map((message) => messageRow(channel, message)))
  if (ids.length === 0) {
    list.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        h('strong', {}, t('stage.emptyTitle')),
        t('stage.emptyBody')
      )
    )
  }
  shell.messageIds = ids
  shell.membersKey = membersKey
}

let shell = null

function createShell(channelId) {
  const composer = createComposer(channelId)
  const bar = h('div', { class: 'bar' })
  const list = h('div', { class: 'messages', role: 'log' })
  const members = h('div', { class: 'list' })
  const buttons = h('footer')
  return {
    channelId,
    messageIds: [],
    membersKey: '',
    composer,
    bar,
    list,
    members,
    buttons,
    nodes: [
      h('section', { class: 'stage' }, bar, list, composer.element),
      h('aside', { class: 'roster' }, members, buttons)
    ]
  }
}

// Why the shell stays mounted: moving the textarea in the DOM would cancel a Hangul syllable mid-composition.
function renderStage(channel) {
  if (shell?.channelId !== channel.id) {
    shell = createShell(channel.id)
  }
  const { composer, bar, list, members, buttons, nodes } = shell
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX
  if (main.firstChild !== nodes[0]) {
    main.className = 'main'
    main.replaceChildren(...nodes)
  }
  composer.input.setAttribute('aria-label', t('composer.aria', { channel: channel.name }))
  composer.list.setAttribute('aria-label', t('composer.suggestions'))
  nodes[1].setAttribute('aria-label', t('stage.members'))
  bar.replaceChildren(
    h('h1', {}, `# ${channel.name}`),
    h('span', { class: 'path', title: channel.cwd }, channel.cwd),
    ...(channel.checkCommand
      ? [h('span', { class: 'tag', title: t('stage.checkTitle') }, t('stage.check', { command: channel.checkCommand }))]
      : [])
  )
  list.setAttribute('aria-label', t('stage.log', { channel: channel.name }))
  renderMessages(channel)
  showReplyTarget(channel)
  members.replaceChildren(
    h('p', { class: 'label' }, t('stage.members')),
    ...channel.members.map((member) =>
      h(
        'button',
        { class: 'member', type: 'button', title: t('stage.openStudio'), onClick: () => openStudio(member.id) },
        h('span', { class: 'row' }, h('span', { class: 'name' }, `@${member.name}`), activityLabel(member)),
        staminaBar(member)
      )
    )
  )
  buttons.replaceChildren(
    h('button', { class: 'primary', type: 'button', onClick: () => importDialog(channel) }, t('stage.import')),
    h('button', { class: 'ghost', type: 'button', onClick: () => hireDialog(channel) }, t('stage.hire'))
  )
  if (stick) list.scrollTop = list.scrollHeight
}

function renderEntry(entry) {
  const kind = entry.kind === 'output' && entry.isError ? 'output error' : entry.kind
  const text = entry.kind === 'status' && entry.text === 'connected' ? t('studio.connected') : entry.text
  return h('p', { class: `entry ${kind}` }, text)
}

async function loadDiff(member, path, target, button) {
  target.replaceChildren(t('studio.loading'))
  main.querySelectorAll('.file').forEach((file) => file.removeAttribute('aria-current'))
  button.setAttribute('aria-current', 'true')
  const { diff } = await api(`members/${member.id}/diff?path=${encodeURIComponent(path)}`)
  target.replaceChildren(
    ...diff.split('\n').map((line) => {
      const added = line.startsWith('+') && !line.startsWith('+++')
      const removed = line.startsWith('-') && !line.startsWith('---')
      const kind = added ? 'add' : removed ? 'del' : line.startsWith('@@') ? 'hunk' : ''
      return h('div', { class: kind }, line)
    })
  )
}

let studio = null

function studioButton(label, className, onClick, disabled = false) {
  return h('button', { class: className, type: 'button', disabled, onClick }, label)
}

async function refreshReview(member, channel) {
  const { log, git } = await api(`members/${member.id}/studio`)
  if (studio?.memberId !== member.id) return
  studio.log = log
  if (!studio.term) showLog()
  studio.gitBox.replaceChildren(
    ...(git
      ? [h('strong', {}, git.branch), git.isWorktree ? ' · worktree' : t('studio.mainCheckout'), t('studio.changes', { count: git.files.length })]
      : [t('studio.notGit')]),
    h(
      'div',
      { class: 'path', title: member.sessionId ?? '' },
      t('studio.session', { id: member.sessionId ?? t('studio.sessionPending'), channel: channel.name })
    )
  )
  studio.files.replaceChildren(
    ...(git?.files ?? []).map((file) => {
      const button = h(
        'button',
        {
          class: 'file',
          type: 'button',
          onClick: () => loadDiff(member, file.path, studio.diffView, button).catch((error) => studio.diffView.replaceChildren(error.message))
        },
        h('span', {}, file.status),
        h('span', {}, file.path)
      )
      return button
    })
  )
}

function showLog() {
  const view = h('div', { class: 'console log', role: 'log', 'aria-label': t('studio.log') })
  view.append(...(studio.log.length ? studio.log.map(renderEntry) : [h('p', { class: 'entry output' }, t('studio.noTurns'))]))
  const open = studioButton(t('studio.openTerminal'), 'primary', () => openTerminal(studio.memberId), Boolean(ui.activity[studio.memberId]))
  studio.termSlot.replaceChildren(h('div', { class: 'terminal-closed' }, h('p', { class: 'hint' }, t('studio.terminalHint')), open), view)
  studio.logView = view
  view.scrollTop = view.scrollHeight
}

async function openTerminal(memberId) {
  if (!studio || studio.memberId !== memberId) return
  const size = measure(studio.termSlot)
  await api(`members/${memberId}/terminal/open`, size).catch((error) => {
    const hint = studio?.memberId === memberId && studio.termSlot.querySelector('.terminal-closed .hint')
    if (hint) hint.textContent = error.message
  })
}

/** Keeps the xterm view in step with the server: one PTY per member, shown while it lives. */
function syncTerminal(member) {
  const open = ui.terminals.includes(member.id)
  if (open && !studio.term) {
    studio.termSlot.replaceChildren()
    studio.logView = null
    studio.term = mountTerminal(studio.termSlot, member.id, () => {
      studio?.term?.dispose()
      if (studio) studio.term = null
    })
  } else if (!open && studio.term) {
    studio.term.dispose()
    studio.term = null
    showLog()
  } else if (!open && !studio.autoOpened && !ui.activity[member.id]) {
    // Opening the agent shows its live terminal, as in Orca; a running headless turn must finish first.
    studio.autoOpened = true
    void openTerminal(member.id)
  }
}

function disposeStudio() {
  studio?.term?.dispose()
  studio = null
}

function renderStudio(member, channel) {
  if (studio?.memberId !== member.id) {
    disposeStudio()
    const bar = h('div', { class: 'bar' })
    const termSlot = h('div', { class: 'terminal-slot' })
    // The slot shares the terminal theme's background so Orca's colors meet the edge without a seam.
    termSlot.style.background = terminalTheme().background
    const gitBox = h('div', { class: 'git' })
    const files = h('div', { class: 'files', 'aria-label': t('studio.changedFiles') })
    const diffView = h('div', { class: 'diff', 'aria-label': t('studio.diff') }, t('studio.pickFile'))
    const page = h(
      'section',
      { class: 'studio-page' },
      bar,
      h('div', { class: 'panes' }, termSlot, h('div', { class: 'review' }, gitBox, files, diffView))
    )
    studio = { memberId: member.id, page, bar, termSlot, gitBox, files, diffView, term: null, log: [], logView: null, autoOpened: false, wasBusy: false }
    main.className = 'main studio'
    main.replaceChildren(page)
    showLog()
    void refreshReview(member, channel)
  } else if (main.firstChild !== studio.page) {
    main.className = 'main studio'
    main.replaceChildren(studio.page)
  }
  const busy = Boolean(ui.activity[member.id])
  if (studio.wasBusy && !busy) void refreshReview(member, channel)
  studio.wasBusy = busy
  const open = ui.terminals.includes(member.id)
  studio.bar.replaceChildren(
    h('button', { class: 'ghost', type: 'button', onClick: () => (location.hash = '#/') }, t('studio.back')),
    h('h2', {}, `@${member.name}`),
    activityLabel(member),
    h('span', { class: 'path', title: t('studio.sessionFolder', { path: member.cwd }) }, projectFolder(member)),
    h('span', { class: 'spacer' }),
    h('div', { class: 'studio-stamina' }, staminaLabel(member), staminaBar(member)),
    open
      ? studioButton(t('studio.closeTerminal'), 'ghost', () => api(`members/${member.id}/terminal/close`, {}))
      : studioButton(t('studio.stop'), 'ghost', () => api(`members/${member.id}/stop`, {}), !busy),
    studioButton('Not quite my tempo', 'danger', () => reject(member))
  )
  const startButton = studio.termSlot.querySelector('.terminal-closed .primary')
  if (startButton) startButton.disabled = busy
  syncTerminal(member)
}

function statusDot(member) {
  return h('span', { class: `dot ${liveState(member)}`, 'aria-hidden': 'true' })
}

function renderChannels() {
  channelNav.replaceChildren(
    ...ui.channels.flatMap((channel) => [
      h(
        'button',
        {
          class: 'channel',
          type: 'button',
          'aria-current': channel.id === ui.channelId && !ui.studioId ? 'page' : undefined,
          onClick: () => {
            ui.channelId = channel.id
            location.hash = '#/'
            render()
          }
        },
        `# ${channel.name}`
      ),
      ...channel.members.map((member) =>
        h(
          'button',
          {
            class: 'agent',
            type: 'button',
            'aria-current': member.id === ui.studioId ? 'page' : undefined,
            onClick: () => openStudio(member.id)
          },
          statusDot(member),
          h('span', { class: 'name' }, member.name),
          h('span', { class: 'kind' }, member.harness)
        )
      )
    ])
  )
}

function render() {
  const studioMember = ui.channels.flatMap(({ members }) => members).find(({ id }) => id === ui.studioId)
  if (studioMember) {
    const channel = ui.channels.find(({ members }) => members.includes(studioMember))
    ui.channelId = channel.id
    renderChannels()
    renderStudio(studioMember, channel)
    return
  }
  disposeStudio()
  const channel = ui.channels.find(({ id }) => id === ui.channelId) ?? ui.channels[0]
  ui.channelId = channel?.id ?? null
  renderChannels()
  if (channel) {
    renderStage(channel)
  } else {
    main.className = 'main studio'
    main.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        h('strong', {}, 'Not quite my tempo.'),
        t('home.body')
      )
    )
  }
}

function showDialog(title, fields, submitLabel, onSubmit) {
  const error = h('p', { class: 'error', role: 'alert', hidden: true })
  const form = h(
    'form',
    {
      method: 'dialog',
      onSubmit: async (event) => {
        event.preventDefault()
        error.hidden = true
        try {
          await onSubmit(new FormData(form))
          dialog.close()
        } catch (failure) {
          error.textContent = failure.message
          error.hidden = false
        }
      }
    },
    h('h2', {}, title),
    fields,
    error,
    h(
      'div',
      { class: 'buttons' },
      h('button', { class: 'ghost', type: 'button', onClick: () => dialog.close() }, t('dialog.cancel')),
      h('button', { class: 'primary', type: 'submit' }, submitLabel)
    )
  )
  dialog.replaceChildren(form)
  dialog.showModal()
}

function field(label, control) {
  return h('label', { class: 'field' }, label, control)
}

async function channelDialog() {
  const { sessions } = await api('sessions')
  const folders = h('datalist', { id: 'folders' }, [...new Set(sessions.map(({ cwd }) => cwd))].map((cwd) => h('option', { value: cwd })))
  showDialog(
    t('channel.title'),
    [
      field(t('channel.name'), h('input', { name: 'name', required: true, autofocus: true, placeholder: 'general' })),
      field(t('channel.folder'), h('input', { name: 'cwd', required: true, list: 'folders', placeholder: '/Users/you/projects/app' })),
      folders,
      field(t('channel.check'), h('input', { name: 'checkCommand', placeholder: 'pnpm build' })),
      h('p', { class: 'hint' }, t('channel.checkHint'))
    ],
    t('channel.submit'),
    async (data) => {
      const { channel } = await api('channels', Object.fromEntries(data))
      // The response can beat the event stream, and the room's buttons must not keep pointing at the old channel.
      if (!ui.channels.some(({ id }) => id === channel.id)) ui.channels.push(channel)
      ui.channelId = channel.id
      location.hash = '#/'
      render()
    }
  )
}

function hireDialog(channel) {
  showDialog(
    t('hire.title', { channel: channel.name }),
    [
      field(t('hire.name'), h('input', { name: 'name', required: true, autofocus: true, placeholder: 'Coder-Agent' })),
      field(t('hire.kind'), h('select', { name: 'harness' }, h('option', { value: 'claude' }, 'Claude Code'), h('option', { value: 'codex' }, 'Codex'))),
      field(t('hire.instructions'), h('textarea', { name: 'instructions', rows: 3 })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'worktree', checked: true }), t('hire.worktree'))
    ],
    t('hire.submit'),
    async (data) => {
      await api(`channels/${channel.id}/members`, {
        name: data.get('name'),
        harness: data.get('harness'),
        instructions: data.get('instructions'),
        worktree: data.has('worktree')
      })
    }
  )
}

function timeAgo(at) {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return t('time.now')
  if (minutes < 60) return t('time.minutes', { count: minutes })
  const hours = Math.round(minutes / 60)
  return hours < 24 ? t('time.hours', { count: hours }) : t('time.days', { count: Math.round(hours / 24) })
}

async function importDialog(channel) {
  const { sessions } = await api('sessions')
  let selected = null
  const name = h('input', { name: 'name', required: true, placeholder: 'Coder-Agent' })
  const rows = sessions.map((session) => {
    const row = h(
      'button',
      {
        class: 'session',
        type: 'button',
        'aria-pressed': 'false',
        onClick: () => {
          selected = session
          rows.forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === row)))
          name.value ||= `${session.harness}-${session.id.slice(0, 4)}`
        }
      },
      h('span', { class: 'title' }, session.title || t('import.untitled')),
      h('span', { class: 'path' }, session.cwd),
      h(
        'span',
        { class: 'time' },
        `${session.harness} · ${timeAgo(session.updatedAt)}${Date.now() - session.updatedAt < LIVE_SESSION_MS ? t('import.live') : ''}`
      )
    )
    return row
  })
  showDialog(
    t('import.title'),
    [
      h('p', { class: 'hint' }, t('import.hint')),
      h('div', { class: 'sessions' }, rows.length ? rows : h('p', { class: 'hint' }, t('import.none'))),
      field(t('import.name'), name)
    ],
    t('import.submit'),
    async (data) => {
      if (!selected) throw new Error(t('import.pick'))
      await api(`channels/${channel.id}/members`, {
        name: data.get('name'),
        harness: selected.harness,
        sessionId: selected.id
      })
    }
  )
}

function route() {
  ui.studioId = /^#\/studio\/(.+)$/.exec(location.hash)?.[1] ?? null
  render()
}

function reject(member) {
  return api(`members/${member.id}/reject`, { locale })
}

document.querySelector('#new-channel').addEventListener('click', () => void channelDialog())
document.querySelector('#language').addEventListener('click', () => setLocale(locale === 'ko' ? 'en' : 'ko'))
// The open terminal repaints with the matching Orca theme; runs only after startup, once studio exists.
function repaintForTheme() {
  if (studio) {
    studio.termSlot.style.background = terminalTheme().background
    studio.term?.setTheme(terminalTheme())
  }
  applyStaticText()
}

document.querySelector('#theme').addEventListener('click', () => {
  const next = colorMode() === 'light' ? 'dark' : 'light'
  writeStored(THEME_KEY, next)
  applyTheme(next)
  repaintForTheme()
})
matchMedia('(prefers-color-scheme: light)').addEventListener('change', repaintForTheme)
applyStaticText()
void refreshUsage()
setInterval(() => void refreshUsage(), USAGE_REFRESH_MS)
window.addEventListener('hashchange', route)

const events = new EventSource('/api/events')
events.addEventListener('state', (event) => {
  const next = JSON.parse(event.data)
  ui.channels = next.channels
  ui.activity = next.activity
  ui.queued = next.queued ?? []
  ui.terminals = next.terminals ?? []
  ui.terminalStatus = next.terminalStatus ?? {}
  render()
})
events.addEventListener('log', (event) => {
  const { memberId, entry } = JSON.parse(event.data)
  if (studio?.memberId === memberId) studio.log.push(entry)
  const view = studio?.memberId === memberId ? studio.logView : null
  if (view) {
    view.append(renderEntry(entry))
    view.scrollTop = view.scrollHeight
  }
})
route()
