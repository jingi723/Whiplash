// Agent output is untrusted and this page can drive agents, so every value goes through textContent.
import { addressTo } from './compose.js'
import { createTranslator, pickLocale } from './i18n.js'

const LOW_STAMINA = 25
const DEFAULT_WINDOW = 200_000
const LARGE_WINDOW = 1_000_000
const LIVE_SESSION_MS = 120_000
const MENTION_QUERY = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u
const NEAR_BOTTOM_PX = 120

const ui = { channels: [], activity: {}, queued: [], replyTo: {}, channelId: null, studioId: null, log: [] }
const main = document.querySelector('#main')
const channelNav = document.querySelector('#channels')
const dialog = document.querySelector('#dialog')
const LOCALE_KEY = 'whiplash.locale'

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

function applyStaticText() {
  document.documentElement.lang = locale
  document.querySelector('#channels-label').textContent = t('nav.channels')
  document.querySelector('#channels').setAttribute('aria-label', t('nav.channels'))
  document.querySelector('#new-channel').textContent = t('nav.newChannel')
  document.querySelector('#language').textContent = t('nav.switchLanguage')
  document.querySelector('#language').lang = locale === 'ko' ? 'en' : 'ko'
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

function activityLabel(member) {
  const activity = ui.activity[member.id]
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
      'data-member': member ? member.id : undefined,
      onClick: (event) => {
        // Selecting text or pressing a button inside the message must not retarget the composer.
        if (!member || event.target.closest('button, a')) return
        if (event.detail > 1) {
          // A double click selects a word; undo the retarget its first click already made.
          const previous = channel.members.find(({ id }) => id === targetBeforeClick)
          setReplyTo(channel, previous ?? null)
          return
        }
        if (getSelection()?.toString()) return
        targetBeforeClick = ui.replyTo[channel.id]
        setReplyTo(channel, member)
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
            onClick: () => setReplyTo(channel, member, { focus: true })
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
  const target = h('div', { class: 'target', hidden: true })
  const showTarget = (member) => {
    target.hidden = !member
    target.replaceChildren(
      ...(member
        ? [
            t('composer.replyingTo', { name: member.name }),
            h(
              'button',
              {
                type: 'button',
                'aria-label': t('composer.clearTarget'),
                onClick: () => setReplyTo(currentChannel(), null)
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
    if (event.key === 'Escape' && ui.replyTo[channelId]) {
      setReplyTo(currentChannel(), null)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  })
  return { element: h('div', { class: 'composer' }, list, target, input), input, list, showTarget }
}

let targetBeforeClick

// Why no re-render: rebuilding the messages would drop the text the user is selecting.
function setReplyTo(channel, member, { focus = false } = {}) {
  if (!channel) return
  if (member) {
    ui.replyTo[channel.id] = member.id
  } else {
    delete ui.replyTo[channel.id]
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
  for (const row of list.querySelectorAll('.message[data-member]')) {
    const targeted = row.dataset.member === replyTo?.id
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

async function renderStudio(member, channel) {
  const running = Boolean(ui.activity[member.id])
  const { log, git } = await api(`members/${member.id}/studio`)
  if (ui.studioId !== member.id) return
  ui.log = log
  const consoleView = h('div', { class: 'console', role: 'log', 'aria-label': t('studio.log') })
  consoleView.append(...(log.length ? log.map(renderEntry) : [h('p', { class: 'entry output' }, t('studio.noTurns'))]))
  const diffView = h('div', { class: 'diff', 'aria-label': t('studio.diff') }, t('studio.pickFile'))
  const page = h(
    'section',
    { class: 'studio-page' },
    h(
      'div',
      { class: 'bar' },
      h('button', { class: 'ghost', type: 'button', onClick: () => (location.hash = '#/') }, t('studio.back')),
      h('h2', {}, `@${member.name}`),
      activityLabel(member),
      h('span', { class: 'path', title: t('studio.sessionFolder', { path: member.cwd }) }, projectFolder(member)),
      h('span', { class: 'spacer' }),
      h('div', { class: 'studio-stamina' }, staminaLabel(member), staminaBar(member)),
      h('button', { class: 'ghost', type: 'button', disabled: !running, onClick: () => api(`members/${member.id}/stop`, {}) }, t('studio.stop')),
      h('button', { class: 'danger', type: 'button', onClick: () => reject(member) }, 'Not quite my tempo')
    ),
    h(
      'div',
      { class: 'panes' },
      consoleView,
      h(
        'div',
        { class: 'review' },
        h(
          'div',
          { class: 'git' },
          git
            ? [h('strong', {}, git.branch), git.isWorktree ? ' · worktree' : t('studio.mainCheckout'), t('studio.changes', { count: git.files.length })]
            : t('studio.notGit'),
          h(
            'div',
            { class: 'path', title: member.sessionId ?? '' },
            t('studio.session', { id: member.sessionId ?? t('studio.sessionPending'), channel: channel.name })
          )
        ),
        h(
          'div',
          { class: 'files', 'aria-label': t('studio.changedFiles') },
          (git?.files ?? []).map((file) => {
            const button = h(
              'button',
              { class: 'file', type: 'button', onClick: () => loadDiff(member, file.path, diffView, button).catch((error) => diffView.replaceChildren(error.message)) },
              h('span', {}, file.status),
              h('span', {}, file.path)
            )
            return button
          })
        ),
        diffView
      )
    )
  )
  main.className = 'main studio'
  main.replaceChildren(page)
  consoleView.scrollTop = consoleView.scrollHeight
}

function renderChannels() {
  channelNav.replaceChildren(
    ...ui.channels.map((channel) =>
      h(
        'button',
        {
          class: 'channel',
          type: 'button',
          'aria-current': channel.id === ui.channelId ? 'page' : undefined,
          onClick: () => {
            ui.channelId = channel.id
            location.hash = '#/'
            render()
          }
        },
        `# ${channel.name}`
      )
    )
  )
}

function render() {
  const studioMember = ui.channels.flatMap(({ members }) => members).find(({ id }) => id === ui.studioId)
  if (studioMember) {
    const channel = ui.channels.find(({ members }) => members.includes(studioMember))
    ui.channelId = channel.id
    renderChannels()
    void renderStudio(studioMember, channel)
    return
  }
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
applyStaticText()
window.addEventListener('hashchange', route)

const events = new EventSource('/api/events')
events.addEventListener('state', (event) => {
  const next = JSON.parse(event.data)
  ui.channels = next.channels
  ui.activity = next.activity
  ui.queued = next.queued ?? []
  render()
})
events.addEventListener('log', (event) => {
  const { memberId, entry } = JSON.parse(event.data)
  const view = memberId === ui.studioId ? main.querySelector('.console') : null
  if (view) {
    view.append(renderEntry(entry))
    view.scrollTop = view.scrollHeight
  }
})
route()
