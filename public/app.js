// Agent output is untrusted and this page can drive agents, so every value goes through textContent.
import { addressTo } from './compose.js'
import { createTranslator, pickLocale } from './i18n.js'
import { acceptFileDrops, colorMode, droppedPaths, measure, mountTerminal, readScreen, reportTerminalColors, shellEscape, terminalTheme } from './terminal.js'
import { formatResetDuration } from './orca/rate-limit-reset-format.js'
import { formatRateLimitWindowChipLabel, formatWindowLabel } from './orca/rate-limit-window-label.js'
import { barColor, clampUsedPercent } from './orca/usage-bar.js'
import { icon, providerIcon } from './icons.js'
import { mountBrowser } from './browser-view.js'

// In the desktop app the macOS window controls float over the rail, as in Orca.
if (window.whiplashDesktop?.platform === 'darwin') document.documentElement.classList.add('desktop-mac')

const LOW_STAMINA = 25
const DEFAULT_WINDOW = 200_000
const LARGE_WINDOW = 1_000_000
const LIVE_SESSION_MS = 120_000
const MENTION_QUERY = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u
// `@name /clear` runs Claude Code's command on that member; the reply chip stands in for the @name.
const COMMAND_QUERY = /^((?:@[\p{L}\p{N}_-]+\s+)*)\/([a-z]*)$/u
// `/model` then asks for a model and an effort, as the terminal's picker does.
const MODEL_QUERY = /^((?:@[\p{L}\p{N}_-]+\s+)*)\/model\s+(?:(\S+)\s+)?(\S*)$/u
const SESSION_COMMANDS = ['clear', 'compact', 'model']
let modelLists = null
let modelsLoading = null
/** The model lists change only with CLI updates, so they load once and then call back whoever waited. */
function loadModels(onLoad) {
  modelsLoading ??= api('models').then((lists) => (modelLists = lists))
  modelsLoading.then(onLoad, () => (modelsLoading = null))
}
/** What a member runs now: its own choice, or the CLI default from its settings. */
function modelOf(member, lists) {
  const list = lists?.[member.harness]
  const id = member.model ?? list?.model
  return { list, id, label: list?.models.find((model) => model.id === id || model.id.includes(`-${id}-`))?.label ?? id, effort: member.effort ?? list?.effort }
}
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
  view: 'app',
  tabs: {}
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

function readJson(key, fallback) {
  try {
    return JSON.parse(readStored(key)) ?? fallback
  } catch {
    return fallback
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
  settingsDirty = true
  panelKey = ''
  render()
}

const USAGE_REFRESH_MS = 120_000
const USAGE_TICK_MS = 60_000
let usage = null

function usageBar(percent, wide = false) {
  const fill = h('div', { class: barColor(percent) })
  fill.style.width = `${percent}%`
  return h('div', { class: `usage-bar${wide ? ' wide' : ''}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent }, fill)
}

function resetText(window) {
  if (!window.resetsAt) return ''
  const duration = formatResetDuration(window.resetsAt - Date.now())
  return duration === 'now' ? t('usage.resetsNow') : t('usage.resetsIn', { duration })
}

// --- Usage: Orca's status-bar trigger and its usage roster popover (UsageRosterPanel.tsx).
const USAGE_MODE_KEY = 'whiplash.usageMode'
let usageMode = readStored(USAGE_MODE_KEY) === 'compact' ? 'compact' : 'verbose'
const PROVIDERS = [
  ['claude', 'Claude'],
  ['codex', 'Codex']
]

// Fable keeps its model name so two weekly windows never both read "wk".
function usageSections(data) {
  return [
    [data?.session, null],
    [data?.weekly, null],
    [data?.fable, 'Fable']
  ]
    .filter(([window]) => window)
    .map(([window, name]) => ({ window, name }))
}

const sectionLabel = (section, countdown) =>
  section.name ?? (countdown ? formatRateLimitWindowChipLabel(section.window) : formatWindowLabel(section.window.windowMinutes))
const usedOf = (section) => clampUsedPercent(section.window.usedPercent)
const maxUsed = (sections) => Math.max(0, ...sections.map(usedOf))
const tightestOf = (sections) => sections.reduce((a, b) => (usedOf(b) > usedOf(a) ? b : a))
const planLabel = (plan) =>
  plan
    ?.split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
const usageTone = (used) => (used >= 80 ? ' urgent' : used >= 60 ? ' warning' : '')

function usageStatus(data) {
  return data?.error === 'signedOut' ? t('usage.signedOut') : data?.error ? t('usage.unavailable') : t('usage.idle')
}

function usageMetric(section, label, showBar = true) {
  const used = usedOf(section)
  return h(
    'span',
    { class: 'usage-metric' },
    h('span', { class: 'metric-label' }, label),
    showBar && usageBar(used),
    h('span', { class: `metric-value${usageTone(used)}` }, `${used}%`)
  )
}

function openAccounts() {
  document.querySelector('#usage-panel')?.hidePopover()
  settingsSection = 'accounts'
  settingsDirty = true
  if (location.hash === '#/settings') render()
  else location.hash = '#/settings'
}

function usageTrigger() {
  return h(
    'button',
    { class: 'usage-trigger', type: 'button', popovertarget: 'usage-panel', 'aria-label': t('usage.title') },
    ...PROVIDERS.map(([id, name]) => {
      const sections = usageSections(usage[id])
      let detail
      if (sections.length === 0) detail = [h('span', { class: 'muted' }, '—')]
      else if (usageMode === 'compact') detail = [h('span', {}, `${usedOf(tightestOf(sections))}%`)]
      else
        detail = [
          usageBar(maxUsed(sections)),
          h('span', {}, sections.map((section) => t('usage.chip', { percent: usedOf(section), label: sectionLabel(section, true) })).join(' · '))
        ]
      return h('span', { class: 'usage-chip', title: name }, providerIcon(id), ...detail)
    })
  )
}

function usagePanel() {
  const link = (label) =>
    h('button', { class: 'usage-link', type: 'button', onClick: openAccounts }, label, icon('chevron-right', 'icon chevron'))
  const rows = PROVIDERS.map(([id, name]) => ({ id, name, data: usage[id], sections: usageSections(usage[id]) }))
    .sort((a, b) => maxUsed(b.sections) - maxUsed(a.sections))
    .map(({ id, name, data, sections }) => {
      const plan = planLabel(data?.plan)
      const soonest = sections.filter((section) => section.window.resetsAt).sort((a, b) => a.window.resetsAt - b.window.resetsAt)[0]
      const tightest = sections.length ? tightestOf(sections) : null
      return h(
        'button',
        { class: 'usage-row', type: 'button', onClick: openAccounts },
        h(
          'span',
          { class: 'row-head' },
          h('span', { class: 'provider-box' }, providerIcon(id)),
          h('span', { class: 'provider-name' }, name, plan && h('span', { class: 'muted' }, ` · ${plan}`)),
          !tightest
            ? h('span', { class: 'small' }, usageStatus(data))
            : usageMode === 'compact'
              ? h('span', { class: 'push' }, usageMetric(tightest, sectionLabel(tightest, true), false))
              : soonest && h('span', { class: 'small' }, resetText(soonest.window)),
          icon('chevron-right', 'icon chevron')
        ),
        tightest && usageMode === 'verbose' && h('span', { class: 'row-metrics' }, ...sections.map((section) => usageMetric(section, sectionLabel(section, false))))
      )
    })
  return h(
    'div',
    { id: 'usage-panel', popover: 'auto', class: 'usage-panel', 'aria-label': t('usage.title') },
    h(
      'div',
      { class: 'usage-head' },
      h('strong', {}, t('usage.title')),
      h(
        'span',
        { class: 'usage-head-right' },
        t('usage.allAgents'),
        h('button', { class: 'icon-xs', type: 'button', title: t('usage.refresh'), 'aria-label': t('usage.refresh'), onClick: () => void refreshUsage(true) }, icon('refresh'))
      )
    ),
    h(
      'div',
      { class: 'usage-mode' },
      segmented([['verbose', t('usage.detailed')], ['compact', t('usage.compact')]], usageMode, (mode) => {
        usageMode = mode
        writeStored(USAGE_MODE_KEY, mode)
        renderUsage()
      })
    ),
    h('div', { class: 'usage-sep' }),
    ...rows,
    h('div', { class: 'usage-sep' }),
    link(t('usage.detailsHistory')),
    link(t('usage.manageAccounts'))
  )
}

function renderUsage() {
  const box = document.querySelector('#usage')
  const open = Boolean(box.querySelector(':popover-open'))
  box.replaceChildren(...(usage ? [usageTrigger(), usagePanel()] : []))
  // Keep the popover open across the minute tick and refreshes.
  if (open) document.getElementById('usage-panel')?.showPopover()
}

async function refreshUsage(force = false) {
  usage = await api(force ? 'usage?force=1' : 'usage').catch(() => usage)
  renderUsage()
}

// --- Panels, as Orca does them: Mod+B and Mod+L toggle the sides, edges drag to resize, all remembered.
// v2: Orca's default widths (280 left, 350 right) replace the narrower ones saved before.
const PANELS_KEY = 'whiplash.panels.v2'
const LEFT_WIDTH = { min: 220, max: 500 }
const RIGHT_MIN = 220
const appRoot = document.querySelector('#app')
const panels = { left: true, right: true, leftWidth: 280, rightWidth: 350 }
Object.assign(panels, readJson(PANELS_KEY, {}))

const clamp = (value, { min, max }) => Math.min(max, Math.max(min, Math.round(value)))
// Orca keeps the center at least 320px wide.
const rightMax = () => Math.max(RIGHT_MIN, window.innerWidth - 320 - (panels.left ? clamp(panels.leftWidth, LEFT_WIDTH) : 0))

function applyPanels() {
  appRoot.classList.toggle('left-closed', !panels.left)
  appRoot.classList.toggle('right-closed', !panels.right)
  appRoot.style.setProperty('--left-w', `${clamp(panels.leftWidth, LEFT_WIDTH)}px`)
  appRoot.style.setProperty('--right-w', `${clamp(panels.rightWidth, { min: RIGHT_MIN, max: rightMax() })}px`)
  // The collapsed header floats over the tab strip, which keeps exactly its width free.
  const header = document.querySelector('.titlebar-left')
  appRoot.style.setProperty('--collapsed-header-w', panels.left ? '0px' : `${header.offsetWidth}px`)
}

function savePanels() {
  writeStored(PANELS_KEY, JSON.stringify(panels))
}

function togglePanel(side) {
  panels[side] = !panels[side]
  savePanels()
  applyPanels()
  if (side === 'right' && panels.right) render()
}

for (const handle of document.querySelectorAll('.resizer')) {
  handle.addEventListener('pointerdown', (event) => {
    const side = handle.dataset.side
    handle.setPointerCapture(event.pointerId)
    appRoot.classList.add('resizing')
    const move = (moveEvent) => {
      if (side === 'left') panels.leftWidth = clamp(moveEvent.clientX, LEFT_WIDTH)
      else panels.rightWidth = clamp(window.innerWidth - moveEvent.clientX, { min: RIGHT_MIN, max: rightMax() })
      applyPanels()
    }
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      appRoot.classList.remove('resizing')
      savePanels()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop, { once: true })
    handle.addEventListener('pointercancel', stop, { once: true })
  })
}
window.addEventListener('resize', applyPanels)

const isMac = navigator.platform.toUpperCase().includes('MAC')
const MOD = isMac ? '⌘' : 'Ctrl'
const SHORTCUTS = {
  b: () => togglePanel('left'),
  l: () => togglePanel('right'),
  j: () => switchPalette(),
  p: () => filePalette(),
  ',': () => (location.hash = '#/settings')
}
// Capture phase, so the shortcuts still work while the terminal has focus.
window.addEventListener(
  'keydown',
  (event) => {
    const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    const action = mod && !event.shiftKey && !event.altKey && SHORTCUTS[event.key.toLowerCase()]
    if (!action) return
    event.preventDefault()
    action()
  },
  { capture: true }
)
document.querySelector('#toggle-left').addEventListener('click', () => togglePanel('left'))
document.querySelector('#toggle-right').addEventListener('click', () => togglePanel('right'))
document.querySelector('#toggle-right-floating').addEventListener('click', () => togglePanel('right'))

function labelButton(selector, label, iconName) {
  const button = document.querySelector(selector)
  button.replaceChildren(icon(iconName))
  button.title = label
  button.setAttribute('aria-label', label)
}

function applyStaticText() {
  document.documentElement.lang = locale
  document.querySelector('#channels-label').textContent = t('nav.channels')
  document
    .querySelector('#open-palette')
    .replaceChildren(icon('search'), h('span', {}, t('nav.search')), h('kbd', {}, `${MOD}J`))
  labelButton('#new-channel', t('channel.title'), 'plus')
  labelButton('#open-settings', t('nav.settings'), 'settings')
  const light = colorMode() === 'light'
  labelButton('#theme', t(light ? 'nav.darkTheme' : 'nav.lightTheme'), light ? 'moon' : 'sun')
  labelButton('#toggle-left', t('panel.left'), 'panel-left')
  labelButton('#toggle-right', t('panel.right'), 'panel-right')
  labelButton('#toggle-right-floating', t('panel.right'), 'panel-right')
  labelButton('#new-tab', t('nav.addAgent'), 'plus')
  for (const handle of document.querySelectorAll('.resizer')) handle.setAttribute('aria-label', t('panel.resize'))
  renderUsage()
  applyPanels()
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

/** The terminal's own OSC 7501 report wins while it is open: it sees approvals and work typed straight into it. */
function liveState(member) {
  const reported = ui.terminalStatus[member.id]?.state
  if (reported === 'blocked') return 'waiting'
  if (reported === 'working') return 'working'
  return ui.activity[member.id] ?? (ui.terminals.includes(member.id) ? 'attached' : 'idle')
}

const projectFolder = (member) => member.writableRoots?.[0] ?? member.cwd

const PASTE_PREVIEW_CHARS = 600

function inline(text, members, attachments = []) {
  const names = new Set(members.map(({ name }) => name.toLowerCase()).concat('all'))
  const pasted = new Map(attachments.map((attachment) => [attachment.token, attachment]))
  const nodes = []
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(@[\p{L}\p{N}_-]+)|(\[(?:Image #\d+|Pasted text #\d+ \+\d+ lines)\])/gu
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    nodes.push(text.slice(cursor, match.index))
    const [token] = match
    if (match[1]) nodes.push(h('code', {}, token.slice(1, -1)))
    else if (match[2]) nodes.push(h('strong', {}, token.slice(2, -2)))
    else if (match[4] && pasted.has(token)) {
      const item = pasted.get(token)
      const title = item.kind === 'image' ? item.path : item.text.slice(0, PASTE_PREVIEW_CHARS)
      nodes.push(h('span', { class: 'paste-chip', title }, icon(item.kind === 'image' ? 'image' : 'file', 'icon'), token))
    } else if (match[3] && names.has(token.slice(1).toLowerCase())) nodes.push(h('span', { class: 'mention' }, token))
    else nodes.push(token)
    cursor = match.index + token.length
  }
  nodes.push(text.slice(cursor))
  return nodes
}

function markdown(text, members, attachments) {
  const parts = text.split(/```[^\n]*\n?/)
  return h(
    'div',
    { class: 'body' },
    parts.map((part, index) =>
      index % 2 === 1
        ? h('pre', {}, h('code', {}, part.replace(/\n$/, '')))
        : part.trim() && h('p', {}, inline(part.trim(), members, attachments))
    )
  )
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
          h('button', { class: 'ghost', type: 'button', onClick: () => openAgent(member.id) }, 'Studio')
        )
    )
  }
  const member = author.kind === 'agent' && channel.members.find(({ id }) => id === author.memberId)
  const name = author.kind === 'human' ? t('message.conductor') : author.name
  // Slack's avatar column: the master's mark, or the agent's CLI, so turns read apart at a glance.
  const avatar = h(
    'span',
    { class: `avatar ${author.kind}`, 'aria-hidden': 'true' },
    author.kind === 'human' ? icon('circle-user') : member ? providerIcon(member.harness === 'codex' ? 'codex' : 'claude') : author.name.slice(0, 1)
  )
  return h(
    'article',
    {
      class: `message ${author.kind}${member ? ' selectable' : ''}`,
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
    avatar,
    h(
      'header',
      {},
      member
        ? h('button', { class: 'who', type: 'button', onClick: () => openAgent(member.id) }, name)
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
        )
    ),
    markdown(message.text, channel.members, message.attachments)
  )
}

const DRAFTS_KEY = 'whiplash.drafts'
const drafts = readJson(DRAFTS_KEY, {})
let draftTimer = null

// Claude Code's paste handling: an image, or a long paste, sits in the text as a short token.
const PASTE_COLLAPSE_CHARS = 800
const PASTE_COLLAPSE_LINES = 10
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i

// Sent messages per channel, recalled with ↑ and ↓ as in Claude Code's prompt; pastes come back with them.
const HISTORY_KEY = 'whiplash.history'
const HISTORY_LIMIT = 50
const sentHistory = readJson(HISTORY_KEY, {})

function remember(channelId, text, attachments) {
  const entries = (sentHistory[channelId] ?? []).filter((entry) => entry.text !== text)
  sentHistory[channelId] = [...entries, { text, attachments }].slice(-HISTORY_LIMIT)
  writeStored(HISTORY_KEY, JSON.stringify(sentHistory))
}

function saveDraft(channelId, text, attachments = []) {
  const kept = attachments.filter(({ token }) => text.includes(token))
  if (text) drafts[channelId] = kept.length ? { text, attachments: kept } : text
  else delete drafts[channelId]
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => writeStored(DRAFTS_KEY, JSON.stringify(drafts)), 300)
}

function createComposer(channelId) {
  // A half-written command outlives switching tabs, channels or reloading, as Orca keeps its composer drafts.
  const input = h('textarea', { rows: 1 })
  const draft = drafts[channelId]
  input.value = typeof draft === 'string' ? draft : (draft?.text ?? '')
  let attachments = typeof draft === 'object' && draft ? draft.attachments : []
  // -1 is the draft being written; 0 the newest sent message, and so on back.
  let recalled = -1
  let held = null
  const load = (entry) => {
    input.value = entry.text
    attachments = entry.attachments ?? []
    input.setSelectionRange(input.value.length, input.value.length)
    saveDraft(channelId, input.value, attachments)
    refresh()
  }
  /** ↑ on the first line walks back through sent messages, ↓ on the last line forward to the draft again. */
  const recall = (step) => {
    const entries = sentHistory[channelId] ?? []
    const target = recalled + step
    if (target < -1 || target >= entries.length) return false
    if (recalled === -1) held = { text: input.value, attachments }
    recalled = target
    load(target === -1 ? held : entries[entries.length - 1 - target])
    return true
  }
  const list = h('ul', { class: 'suggestions', role: 'listbox', hidden: true })
  let active = 0

  const currentChannel = () => ui.channels.find(({ id }) => id === channelId)
  const targetOf = (names) => {
    const members = currentChannel()?.members ?? []
    const first = /@([\p{L}\p{N}_-]+)/u.exec(names)?.[1]?.toLowerCase()
    return first ? members.find(({ name }) => name.toLowerCase() === first) : members.find(({ id }) => id === ui.replyTo[channelId])
  }
  /** The word being typed and what can complete it: a member, a command, a model, then an effort. */
  const query = () => {
    const before = input.value.slice(0, input.selectionStart)
    const addressed = (names) => names || ui.replyTo[channelId]
    const model = MODEL_QUERY.exec(before)
    if (model && addressed(model[1])) {
      const member = targetOf(model[1])
      if (!member || !modelLists) {
        if (member) loadModels(refresh)
        return { typed: model[3], items: [] }
      }
      const current = modelOf(member, modelLists)
      const fallback = t('composer.model.default')
      if (!model[2]) {
        return {
          typed: model[3],
          items: [{ insert: 'default', label: fallback, hint: current.list?.model }, ...current.list.models.map(({ id, label }) => ({ insert: id, label, hint: id === current.id ? '✓' : '' }))]
        }
      }
      const chosen = current.list.models.find(({ id }) => id === model[2])
      const efforts = chosen?.efforts ?? current.list.models[0]?.efforts ?? []
      return {
        typed: model[3],
        last: true,
        items: [{ insert: 'default', label: fallback, hint: current.list?.effort }, ...efforts.map((effort) => ({ insert: effort, label: effort, hint: effort === current.effort ? '✓' : '' }))]
      }
    }
    const command = COMMAND_QUERY.exec(before)
    if (command && addressed(command[1])) {
      return { typed: command[2], items: SESSION_COMMANDS.map((name) => ({ insert: name, label: `/${name}`, hint: t(`composer.command.${name}`) })) }
    }
    const mention = MENTION_QUERY.exec(before)
    if (!mention) return undefined
    const names = [...(currentChannel()?.members ?? []).map(({ name }) => name), 'all']
    return { typed: mention[1], items: names.map((name) => ({ insert: name, label: `@${name}` })) }
  }
  const matches = () => {
    const found = query()
    if (!found) return []
    const lowered = found.typed.toLowerCase()
    return found.items
      .filter(({ insert, label }) => insert.toLowerCase().startsWith(lowered) || label.toLowerCase().startsWith(lowered))
      .map((item) => ({ ...item, last: found.last }))
  }
  const pick = (item) => {
    const caret = input.selectionStart
    const start = caret - (query()?.typed.length ?? 0)
    input.setRangeText(`${item.insert} `, start, caret, 'end')
    input.focus()
    active = 0
    refresh()
    // The effort is the picker's last step, so choosing it applies the change.
    if (item.last) void submit()
  }
  /** The model chip's click: the same picker, typed for that member. */
  const pickModel = (name) => {
    input.value = `@${name} /model `
    input.setSelectionRange(input.value.length, input.value.length)
    input.focus()
    active = 0
    refresh()
  }
  function refresh() {
    const options = matches()
    active = Math.min(active, Math.max(options.length - 1, 0))
    list.hidden = options.length === 0
    list.replaceChildren(
      ...options.map((item, index) =>
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
                pick(item)
              }
            },
            item.label,
            item.hint ? h('span', { class: 'suggestion-hint' }, item.hint) : null
          )
        )
      )
    )
  }
  const chip = h('span', { class: 'chip', hidden: true })
  const box = h('div', { class: 'composer-box', 'data-drop-hint': t('composer.drop') }, chip, input)
  const insertText = (text) => {
    const before = input.value.slice(0, input.selectionStart)
    input.setRangeText(`${before && !/\s$/.test(before) ? ' ' : ''}${text} `, input.selectionStart, input.selectionEnd, 'end')
    saveDraft(channelId, input.value, attachments)
    input.focus()
  }
  const nextNumber = (kind) => 1 + Math.max(0, ...attachments.filter((item) => item.kind === kind).map(({ token }) => Number(/#(\d+)/.exec(token)[1])))
  const attach = (attachment) => {
    attachments = [...attachments, attachment]
    return attachment.token
  }
  const imageToken = (path) => attach({ token: `[Image #${nextNumber('image')}]`, kind: 'image', path })
  // Other paths go in backticks: a code span is never read as an @mention (node_modules/@scope/...).
  const insertPaths = (paths) => insertText(paths.map((path) => (IMAGE_FILE.test(path) ? imageToken(path) : `\`${path}\``)).join(' '))
  input.addEventListener('paste', async (event) => {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'))
    if (images.length) {
      event.preventDefault()
      const paths = await droppedPaths({ files: images })
      if (paths.length) insertText(paths.map(imageToken).join(' '))
      return
    }
    const text = event.clipboardData.getData('text/plain')
    const lines = text.split('\n').length
    if (text.length <= PASTE_COLLAPSE_CHARS && lines <= PASTE_COLLAPSE_LINES) return
    event.preventDefault()
    insertText(attach({ token: `[Pasted text #${nextNumber('text')} +${lines} lines]`, kind: 'text', text }))
  })
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
    // The chip sits over the first line only, as Slack's: later lines start at the left edge.
    input.style.textIndent = member ? `${chip.offsetWidth + 6}px` : ''
  }
  const submit = async () => {
    const typed = input.value.trim()
    if (!typed) return
    const replyTo = currentChannel()?.members.find(({ id }) => id === ui.replyTo[channelId])
    const text = addressTo(typed, replyTo?.name)
    const sent = attachments.filter(({ token }) => text.includes(token))
    remember(channelId, typed, sent)
    recalled = -1
    input.value = ''
    attachments = []
    saveDraft(channelId, '')
    refresh()
    box.classList.remove('lash')
    void box.offsetWidth
    box.classList.add('lash')
    await api(`channels/${channelId}/messages`, { text, locale, attachments: sent }).catch((error) => {
      input.value = typed
      attachments = sent
      saveDraft(channelId, typed, sent)
      alert(error.message)
    })
  }

  input.addEventListener('input', () => {
    active = 0
    recalled = -1
    saveDraft(channelId, input.value, attachments)
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
    const caret = input.selectionStart
    const collapsed = caret === input.selectionEnd
    if (event.key === 'ArrowUp' && collapsed && !input.value.slice(0, caret).includes('\n') && recall(1)) {
      event.preventDefault()
      return
    }
    if (event.key === 'ArrowDown' && collapsed && recalled >= 0 && !input.value.slice(caret).includes('\n') && recall(-1)) {
      event.preventDefault()
      return
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
  return { element: h('div', { class: 'composer' }, list, box), input, list, showTarget, insertPaths, pickModel }
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
      channel.members.length || channel.everyone
        ? // Members are already here: the empty log only needs to say how to call them.
          h(
            'div',
            { class: 'empty' },
            h('strong', {}, t('stage.readyTitle')),
            channel.members.length ? t('stage.readyBody', { names: channel.members.map(({ name }) => `@${name}`).join(', ') }) : t('stage.everyoneEmpty')
          )
        : h(
            'div',
            { class: 'empty' },
            h('strong', {}, t('stage.emptyTitle')),
            t('stage.emptyBody'),
            h(
              'div',
              { class: 'actions' },
              h('button', { class: 'primary', type: 'button', onClick: () => importDialog(channel) }, t('stage.import')),
              h('button', { class: 'ghost', type: 'button', onClick: () => hireDialog(channel) }, t('stage.hire'))
            )
          )
    )
  }
  shell.messageIds = ids
  shell.membersKey = membersKey
}

let shell = null

function createShell(channelId) {
  const composer = createComposer(channelId)
  const bar = h('div', { class: 'page-toolbar' })
  const list = h('div', { class: 'messages', role: 'log' })
  const typing = h('div', { class: 'typing', 'aria-live': 'polite' })
  const node = h('section', { class: 'stage' }, bar, list, typing, composer.element)
  // Files dropped anywhere on the stage go into the message as paths.
  acceptFileDrops(node, composer.insertPaths)
  return { channelId, messageIds: [], membersKey: '', composer, bar, list, typing, node }
}

const nameButtons = (members) =>
  members.flatMap((member, index) => [
    index > 0 ? ', ' : '',
    h('button', { class: 'typing-name', type: 'button', onClick: () => openAgent(member.id) }, member.name)
  ])

/** Slack's typing line: who is writing (bouncing dots), checking, or stuck waiting for input in a terminal. */
function renderTyping(channel, typing) {
  const by = (state) => channel.members.filter((member) => liveState(member) === state)
  const writing = by('working')
  const checking = by('checking')
  const waiting = by('waiting')
  const rows = []
  // The moving dots take the place of the ellipsis, right after what is happening.
  const dots = () => h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))
  // Slack's form: who, then the moving dots; the words stay for screen readers only.
  if (writing.length) rows.push(h('div', { class: 'typing-row', 'aria-label': `${writing.map(({ name }) => name).join(', ')} ${t('stage.typing')}` }, nameButtons(writing), dots()))
  if (checking.length) rows.push(h('div', { class: 'typing-row' }, nameButtons(checking), ` ${t('stage.checking')}`, dots()))
  for (const member of waiting) rows.push(promptCard(member))
  for (const id of screens.keys()) if (!waiting.some((member) => member.id === id)) screens.delete(id)
  typing.replaceChildren(...rows)
}

// --- What a waiting CLI is asking, mirrored into the chat so it can be answered without opening the terminal.
const SCREEN_REFRESH_MS = 2000
const PROMPT_MAX_LINES = 24
const KEY_GAP_MS = 60
const CURSOR_LINE = /^\s*[❯›]\s/
const screens = new Map()

/** The dialog at the bottom of the screen: from the rule above its menu down, without the talk above it. */
function promptLines(lines) {
  const end = lines.findLastIndex((line) => line.trim())
  if (end < 0) return []
  const cursor = lines.findLastIndex((line) => CURSOR_LINE.test(line))
  const rule = lines.slice(0, cursor < 0 ? end : cursor).findLastIndex((line) => /[─━╌]{8,}|╭/.test(line))
  let start = rule >= 0 ? rule + 1 : 0
  while (start < end && !lines[start].trim()) start += 1
  return lines.slice(Math.max(start, end + 1 - PROMPT_MAX_LINES), end + 1)
}

/**
 * The CLI's selection menu: the item under the ❯ cursor and its siblings at the same indent. Deeper-indented
 * lines between items are their descriptions. Works for numbered and unnumbered menus alike.
 */
function menuOf(lines) {
  const cursor = lines.findLastIndex((line) => CURSOR_LINE.test(line))
  if (cursor < 0) return null
  const indent = lines[cursor].search(/[❯›]/)
  const isItem = (line) => line.slice(0, indent).trim() === '' && /^[❯› ] \S/.test(line.slice(indent, indent + 3))
  const isDetail = (line) => line.trim() && line.slice(0, indent + 3).trim() === ''
  const rows = [cursor]
  for (let row = cursor - 1; row >= 0 && (isItem(lines[row]) || isDetail(lines[row])); row -= 1) if (isItem(lines[row])) rows.unshift(row)
  for (let row = cursor + 1; row < lines.length && (isItem(lines[row]) || isDetail(lines[row])); row += 1) if (isItem(lines[row])) rows.push(row)
  return { items: rows.map((row) => lines[row].slice(indent + 2).trim()), selected: rows.indexOf(cursor) }
}

function watchScreen(member) {
  const entry = screens.get(member.id) ?? { lines: [], timer: null }
  screens.set(member.id, entry)
  if (entry.timer) return entry
  entry.timer = setTimeout(async () => {
    const lines = promptLines(await readScreen(member.id))
    if (screens.get(member.id) !== entry) return
    entry.timer = null
    if (lines.join('\n') !== entry.lines.join('\n')) {
      entry.lines = lines
      const channel = currentChannel()
      if (shell && channel) renderTyping(channel, shell.typing)
    }
    // Keep the mirror current while the CLI waits; renderTyping drops the entry once it stops waiting.
    if (liveState(member) === 'waiting') watchScreen(member)
  }, entry.lines.length ? SCREEN_REFRESH_MS : 300)
  return entry
}

/** One key per write: a TUI can read a burst of arrow keys as a single unknown sequence. */
async function pressKeys(member, keys) {
  for (const [index, data] of keys.entries()) {
    if (index) await new Promise((resolve) => setTimeout(resolve, KEY_GAP_MS))
    await api(`members/${member.id}/terminal/input`, { data })
  }
  const entry = screens.get(member.id)
  if (entry) entry.lines = []
}

function promptCard(member) {
  const { lines } = watchScreen(member)
  const menu = menuOf(lines)
  // Choosing an item walks the cursor there and confirms, as the arrow keys and Enter would.
  const choose = (index) => {
    const delta = index - menu.selected
    void pressKeys(member, [...Array(Math.abs(delta)).fill(delta > 0 ? '\x1b[B' : '\x1b[A'), '\r'])
  }
  return h(
    'div',
    { class: 'prompt-card', role: 'group', 'aria-label': t('stage.waitingInput') },
    h('div', { class: 'typing-row waiting' }, h('span', { class: 'dot waiting', 'aria-hidden': 'true' }), nameButtons([member]), ` ${t('stage.waitingInput')}`),
    lines.length > 0 && h('pre', { class: 'prompt-screen' }, lines.join('\n')),
    menu &&
      h(
        'div',
        { class: 'prompt-menu' },
        ...menu.items.map((item, index) =>
          h('button', { class: index === menu.selected ? 'primary' : 'ghost', type: 'button', title: item, onClick: () => choose(index) }, item)
        )
      ),
    h(
      'div',
      { class: 'prompt-actions' },
      !menu && h('button', { class: 'ghost', type: 'button', onClick: () => void pressKeys(member, ['\r']) }, t('prompt.enter')),
      h('button', { class: 'ghost', type: 'button', onClick: () => void pressKeys(member, ['\x1b']) }, t('prompt.escape')),
      h('button', { class: 'ghost', type: 'button', onClick: () => openAgent(member.id) }, t('prompt.openTerminal'))
    )
  )
}

// Why the shell stays mounted: moving the textarea in the DOM would cancel a Hangul syllable mid-composition.
/** Who runs on what; a click opens the composer's /model picker for that member. */
function modelChip(member, composer) {
  const { label, effort } = modelOf(member, modelLists)
  const text = [label, effort].filter(Boolean).join(' · ')
  return h(
    'button',
    { class: 'model-chip', type: 'button', title: t('composer.command.model'), onClick: () => composer.pickModel(member.name) },
    h('span', { class: 'model-chip-name' }, member.name),
    text || '…'
  )
}

function renderStage(channel) {
  if (shell?.channelId !== channel.id) {
    shell = createShell(channel.id)
  }
  const { composer, bar, list, typing, node } = shell
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX
  if (main.firstChild !== node) main.replaceChildren(node)
  composer.input.setAttribute('aria-label', t('composer.aria', { channel: channel.name }))
  composer.list.setAttribute('aria-label', t('composer.suggestions'))
  bar.replaceChildren(
    h('strong', {}, `# ${channel.name}`),
    channel.everyone
      ? h('span', { class: 'path' }, t('stage.everyone', { count: channel.members.length }))
      : h('span', { class: 'path', title: channel.cwd }, channel.cwd),
    channel.checkCommand && h('span', { class: 'tag', title: t('stage.checkTitle') }, t('stage.check', { command: channel.checkCommand })),
    h('span', { class: 'model-chips' }, ...channel.members.map((member) => modelChip(member, composer)))
  )
  if (!modelLists) loadModels(render)
  list.setAttribute('aria-label', t('stage.log', { channel: channel.name }))
  renderMessages(channel)
  renderTyping(channel, typing)
  showReplyTarget(channel)
  if (stick) list.scrollTop = list.scrollHeight
}

function renderEntry(entry) {
  const kind = entry.kind === 'output' && entry.isError ? 'output error' : entry.kind
  const text = entry.kind === 'status' && entry.text === 'connected' ? t('studio.connected') : entry.text
  return h('p', { class: `entry ${kind}` }, text)
}

let studio = null

function studioButton(label, className, onClick, disabled = false) {
  return h('button', { class: className, type: 'button', disabled, onClick }, label)
}

async function loadLog(member) {
  const { log } = await api(`members/${member.id}/studio`)
  if (studio?.memberId !== member.id) return
  studio.log = log
  if (!studio.term) showLog()
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
  // The CLI asks for colors the moment it starts, before this page attaches.
  await reportTerminalColors()
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

function renderStudio(member) {
  if (studio?.memberId !== member.id) {
    disposeStudio()
    const termSlot = h('div', { class: 'terminal-slot' })
    // The slot shares the terminal theme's background so Orca's colors meet the edge without a seam.
    termSlot.style.background = terminalTheme().background
    // Dropping files on the terminal types their paths, as in Orca.
    acceptFileDrops(termSlot, (paths) => {
      if (ui.terminals.includes(member.id)) void api(`members/${member.id}/terminal/input`, { data: `${paths.map(shellEscape).join(' ')} ` })
    })
    // No toolbar: the tab, the sidebar card and its menu already show and do everything it held.
    const page = h('section', { class: 'studio-page' }, termSlot)
    studio = { memberId: member.id, page, termSlot, term: null, log: [], logView: null, autoOpened: false }
    main.replaceChildren(page)
    showLog()
    void loadLog(member)
  } else if (main.firstChild !== studio.page) {
    main.replaceChildren(studio.page)
  }
  const busy = Boolean(ui.activity[member.id])
  const startButton = studio.termSlot.querySelector('.terminal-closed .primary')
  if (startButton) startButton.disabled = busy
  syncTerminal(member)
}

function statusDot(member) {
  return h('span', { class: `dot ${liveState(member)}`, 'aria-hidden': 'true' })
}

function stateText(member) {
  const state = liveState(member)
  if (state === 'working' || state === 'checking' || state === 'waiting') return t(`activity.${state}`)
  return member.harness
}

// --- Left list: channels as Orca's project headers, agents as its workspace cards.
const COLLAPSED_KEY = 'whiplash.collapsed'
const collapsed = new Set(readJson(COLLAPSED_KEY, []))
const tabsRoot = document.querySelector('#tabs')
const panel = document.querySelector('#panel')
const activityRoot = document.querySelector('#activity')
const settingsRoot = document.querySelector('#settings')
const paletteRoot = document.querySelector('#palette')

const currentChannel = () => ui.channels.find(({ id }) => id === ui.channelId)

function selectChannel(channel) {
  ui.channelId = channel.id
  channelTabs(channel).active = 'stage'
  saveTabs()
  if (ui.view === 'settings') location.hash = '#/'
  else render()
}

function renderChannels() {
  channelNav.setAttribute('aria-label', t('nav.channels'))
  channelNav.replaceChildren(
    ...ui.channels.map((channel) => {
      const tab = channel.id === ui.channelId ? activeTab(channel) : null
      const isCollapsed = collapsed.has(channel.id)
      const toggle = (event) => {
        event.stopPropagation()
        if (isCollapsed) collapsed.delete(channel.id)
        else collapsed.add(channel.id)
        writeStored(COLLAPSED_KEY, JSON.stringify([...collapsed]))
        renderChannels()
      }
      const header = h(
        'div',
        {
          class: `group-header${isCollapsed ? ' collapsed' : ''}`,
          onContextmenu: (event) => {
            event.preventDefault()
            showMenu(event.clientX, event.clientY, channelMenu(channel))
          },
          role: 'button',
          tabindex: 0,
          'aria-current': tab?.type === 'stage' ? 'page' : undefined,
          onClick: () => selectChannel(channel),
          onKeydown: (event) => {
            if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
            event.preventDefault()
            selectChannel(channel)
          }
        },
        h('span', { class: 'chev-hit', onClick: toggle }, icon('chevron-down', 'icon chev')),
        h('span', { class: 'label-text' }, `# ${channel.name}`),
        channel.everyone && h('span', { class: 'group-count' }, String(channel.members.length)),
        !channel.everyone &&
        h(
          'span',
          { class: 'hover-actions' },
          h(
            'button',
            {
              class: 'icon-xs',
              type: 'button',
              title: t('nav.addAgent'),
              'aria-label': t('nav.addAgent'),
              onClick: (event) => {
                event.stopPropagation()
                addAgentMenu(event.currentTarget, channel)
              }
            },
            icon('plus')
          )
        )
      )
      // Pinned agents first, as Orca keeps pinned workspaces on top.
      const ordered = [...channel.members].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
      // #all lists every agent; their cards stay in their home channels so none shows twice.
      const cards = isCollapsed || channel.everyone
        ? []
        : ordered.map((member) =>
            h(
              'button',
              {
                class: 'card',
                type: 'button',
                'aria-current': tab?.type === 'agent' && tab.memberId === member.id ? 'page' : undefined,
                onClick: () => openAgent(member.id),
                onContextmenu: (event) => {
                  event.preventDefault()
                  showMenu(event.clientX, event.clientY, agentMenu(channel, member))
                }
              },
              h('span', { class: 'lane' }, statusDot(member)),
              h(
                'span',
                { class: 'lines' },
                h('span', { class: `title${isUnread(member) ? ' unread' : ''}` }, member.name, member.pinned && icon('pin', 'icon pin-mark')),
                h('span', { class: 'meta' }, h('span', {}, stateText(member)), staminaBar(member), h('span', {}, `${staminaOf(member)}%`))
              )
            )
          )
      return h('div', { class: 'group' }, header, ...cards)
    })
  )
}

// --- Menus: one popover for right-click menus and the "+" menu, styled as Orca's context menu.
// Manual, not light-dismiss: on macOS the right-button release lands outside the menu that the press just opened.
const menu = h('div', { popover: 'manual', class: 'context-menu', role: 'menu' })
document.body.append(menu)
menu.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const items = [...menu.querySelectorAll('button:not(:disabled)')]
  const next = items.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1)
  items[(next + items.length) % items.length]?.focus()
})

function hideMenu() {
  if (!menu.matches(':popover-open')) return
  menu.hidePopover()
  document.removeEventListener('pointerdown', dismissMenu, true)
  document.removeEventListener('keydown', dismissMenu, true)
  window.removeEventListener('blur', hideMenu)
  window.removeEventListener('resize', hideMenu)
  document.removeEventListener('scroll', hideMenu, true)
}

function dismissMenu(event) {
  if (event.type === 'keydown' ? event.key === 'Escape' : !menu.contains(event.target)) hideMenu()
}

function showMenu(x, y, items) {
  hideMenu()
  menu.replaceChildren(
    ...items
      .filter(Boolean)
      .map((item) =>
        item === '-'
          ? h('div', { class: 'menu-sep', role: 'separator' })
          : item.header
            ? h('div', { class: 'menu-label' }, item.header)
            : h(
                'button',
                {
                  class: `menu-item${item.danger ? ' danger' : ''}`,
                  type: 'button',
                  role: 'menuitem',
                  disabled: item.disabled,
                  onClick: () => {
                    hideMenu()
                    item.run()
                  }
                },
                item.icon ? icon(item.icon) : h('span', { class: 'menu-icon-space' }),
                h('span', { class: 'menu-text' }, item.label)
              )
      )
  )
  menu.showPopover()
  const { width, height } = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`
  document.addEventListener('pointerdown', dismissMenu, true)
  document.addEventListener('keydown', dismissMenu, true)
  window.addEventListener('blur', hideMenu)
  window.addEventListener('resize', hideMenu)
  document.addEventListener('scroll', hideMenu, true)
  menu.querySelector('button:not(:disabled)')?.focus()
}

function addAgentMenu(anchor, channel) {
  if (!channel) return
  const rect = anchor.getBoundingClientRect()
  showMenu(rect.left, rect.bottom + 4, [
    { icon: 'download', label: t('stage.import'), run: () => void importDialog(channel) },
    { icon: 'user-plus', label: t('stage.hire'), run: () => hireDialog(channel) }
  ])
}

const copyText = (text) => void navigator.clipboard?.writeText(text).catch(() => {})
const joinPath = (folder, path) => (path ? `${folder.replace(/[\\/]+$/, '')}/${path}` : folder)
const REVEAL_KEY = navigator.platform.startsWith('Win') ? 'menu.revealWindows' : isMac ? 'menu.revealMac' : 'menu.revealLinux'
const reveal = (scope, path = '') => void api(`${scope.kind}/${scope.id}/reveal`, { path }).catch(() => {})

/** Orca's path items: absolute, relative, and the file manager. */
function pathItems(scope, folder, path) {
  return [
    { icon: 'copy', label: t('menu.copyPath'), run: () => copyText(joinPath(folder, path)) },
    path && { icon: 'copy', label: t('menu.copyRelativePath'), run: () => copyText(path) },
    { icon: 'folder', label: t(REVEAL_KEY), run: () => reveal(scope, path) }
  ]
}

function removeMemberDialog(channel, member) {
  showDialog(
    t('menu.remove'),
    [h('p', { class: 'hint' }, t('menu.removeConfirm', { name: member.name, channel: channel.name }))],
    t('menu.removeSubmit'),
    () => api(`members/${member.id}/remove`, {})
  )
}

function renameDialog(title, current, submit) {
  showDialog(title, [field(t('menu.newName'), h('input', { name: 'name', required: true, autofocus: true, value: current }))], t('menu.renameSubmit'), (data) =>
    submit(String(data.get('name')))
  )
}

/** Orca's workspace menu: rename, open and copy, pin and read state, sleep, then the destructive action. */
function agentMenu(channel, member) {
  const scope = { kind: 'members', id: member.id }
  const unread = isUnread(member)
  const terminalOpen = ui.terminals.includes(member.id)
  return [
    { header: t('menu.agentSection') },
    { icon: 'pencil', label: t('menu.rename'), run: () => renameDialog(t('menu.renameAgent'), member.name, (name) => api(`members/${member.id}/update`, { name })) },
    '-',
    { icon: 'terminal', label: t('palette.open'), run: () => openAgent(member.id) },
    ...pathItems(scope, projectFolder(member), ''),
    member.sessionId && { icon: 'copy', label: t('menu.copySessionId'), run: () => copyText(member.sessionId) },
    '-',
    { icon: 'globe', label: t('menu.viewBrowser'), run: () => openBrowser(member.id) },
    { icon: 'x', label: t('menu.closeBrowser'), run: () => api(`members/${member.id}/browser/close`, {}) },
    '-',
    { icon: member.pinned ? 'pin-off' : 'pin', label: t(member.pinned ? 'menu.unpin' : 'menu.pin'), run: () => api(`members/${member.id}/update`, { pinned: !member.pinned }) },
    { icon: unread ? 'bell-off' : 'bell', label: t(unread ? 'menu.markRead' : 'menu.markUnread'), run: () => setUnread(member, !unread) },
    '-',
    { icon: 'moon', label: t('menu.sleep'), disabled: !terminalOpen, run: () => api(`members/${member.id}/terminal/close`, {}) },
    { icon: 'refresh', label: t('menu.resetSession'), disabled: Boolean(ui.activity[member.id]), run: () => resetSessionDialog(member) },
    { icon: 'square', label: t('studio.stop'), disabled: !ui.activity[member.id], run: () => api(`members/${member.id}/stop`, {}) },
    '-',
    { icon: 'trash', label: t('menu.remove'), danger: true, run: () => removeMemberDialog(channel, member) }
  ]
}

function resetSessionDialog(member) {
  showDialog(
    t('menu.resetSession'),
    [h('p', { class: 'hint' }, t('menu.resetConfirm', { name: member.name }))],
    t('menu.resetSubmit'),
    () => api(`members/${member.id}/reset`, {})
  )
}

function removeChannelDialog(channel) {
  showDialog(
    t('menu.deleteChannel'),
    [h('p', { class: 'hint' }, t('menu.deleteChannelConfirm', { channel: channel.name }))],
    t('menu.deleteSubmit'),
    () => api(`channels/${channel.id}/remove`, {})
  )
}

function channelMenu(channel) {
  if (channel.everyone) {
    return [
      { header: t('menu.channelSection') },
      { icon: 'pencil', label: t('menu.rename'), run: () => renameDialog(t('menu.renameChannel'), channel.name, (name) => api(`channels/${channel.id}/update`, { name })) }
    ]
  }
  return [
    { header: t('menu.channelSection') },
    { icon: 'pencil', label: t('menu.rename'), run: () => renameDialog(t('menu.renameChannel'), channel.name, (name) => api(`channels/${channel.id}/update`, { name })) },
    '-',
    { icon: 'download', label: t('stage.import'), run: () => void importDialog(channel) },
    { icon: 'user-plus', label: t('stage.hire'), run: () => hireDialog(channel) },
    '-',
    ...pathItems({ kind: 'channels', id: channel.id }, channel.cwd, ''),
    '-',
    { icon: 'trash', label: t('menu.deleteChannel'), danger: true, run: () => removeChannelDialog(channel) }
  ]
}

// --- Unread, as Orca marks a workspace: a turn that ends while you look elsewhere stays unread until you look.
const READ_KEY = 'whiplash.read'
const readAt = readJson(READ_KEY, {})

function isUnread(member) {
  if (readAt[member.id] === undefined) readAt[member.id] = Date.now()
  return readAt[member.id] === -1 || (member.lastTurnEndedAt ?? 0) > readAt[member.id]
}

function setUnread(member, unread) {
  readAt[member.id] = unread ? -1 : Date.now()
  writeStored(READ_KEY, JSON.stringify(readAt))
  render()
}

function markSeen(members) {
  let changed = false
  for (const member of members) {
    if (readAt[member.id] === -1 || (member.lastTurnEndedAt ?? 0) > (readAt[member.id] ?? 0)) {
      readAt[member.id] = Date.now()
      changed = true
    }
  }
  if (changed) writeStored(READ_KEY, JSON.stringify(readAt))
}

// --- Tabs: the stage, opened agents, and files, diffs and commits, per channel.
const TABS_KEY = 'whiplash.tabs'
ui.tabs = readJson(TABS_KEY, {})
const STAGE_TAB = { key: 'stage', type: 'stage' }
const TAB_ICONS = { stage: 'hash', agent: 'terminal', browser: 'globe', file: 'file', diff: 'file-diff', commit: 'git-commit' }

function channelTabs(channel) {
  const entry = (ui.tabs[channel.id] ??= { open: [], active: 'stage' })
  const memberIds = new Set(channel.members.map(({ id }) => id))
  entry.open = entry.open.filter((tab) => !tab.memberId || memberIds.has(tab.memberId))
  if (!entry.open.some(({ key }) => key === entry.active)) entry.active = 'stage'
  return entry
}

function activeTab(channel) {
  const entry = channelTabs(channel)
  return entry.open.find(({ key }) => key === entry.active) ?? STAGE_TAB
}

function saveTabs() {
  writeStored(TABS_KEY, JSON.stringify(ui.tabs))
}

function openTab(channel, tab) {
  if (!channel) return
  const entry = channelTabs(channel)
  const existing = entry.open.find(({ key }) => key === tab.key)
  if (existing) Object.assign(existing, tab)
  else entry.open.push(tab)
  entry.active = tab.key
  ui.channelId = channel.id
  saveTabs()
  if (ui.view === 'settings') location.hash = '#/'
  else render()
}

function closeTab(channel, key) {
  const entry = channelTabs(channel)
  const index = entry.open.findIndex((tab) => tab.key === key)
  if (index < 0) return
  entry.open.splice(index, 1)
  dropDoc(key)
  if (entry.active === key) entry.active = (entry.open[index] ?? entry.open[index - 1])?.key ?? 'stage'
  saveTabs()
  render()
}

function openAgent(memberId) {
  const channel = ui.channels.find(({ everyone, members }) => !everyone && members.some(({ id }) => id === memberId))
  openTab(channel, { key: `agent:${memberId}`, type: 'agent', memberId })
}

function openBrowser(memberId) {
  const channel = ui.channels.find(({ everyone, members }) => !everyone && members.some(({ id }) => id === memberId))
  // Asking again reconnects, so a browser closed while its tab was open comes back.
  if (browserView?.key === `browser:${memberId}`) disposeBrowser()
  openTab(channel, { key: `browser:${memberId}`, type: 'browser', memberId })
}

function tabTitle(channel, tab) {
  if (tab.type === 'stage') return channel.name
  if (tab.type === 'agent' || tab.type === 'browser') return channel.members.find(({ id }) => id === tab.memberId)?.name ?? '?'
  if (tab.type === 'commit') return tab.short
  return tab.path.split('/').pop()
}

function closeOtherTabs(channel, keep) {
  const entry = channelTabs(channel)
  for (const tab of entry.open) if (tab.key !== keep) dropDoc(tab.key)
  entry.open = entry.open.filter((tab) => tab.key === keep)
  entry.active = keep
  saveTabs()
  render()
}

function tabMenu(channel, tab, member) {
  const others = channelTabs(channel).open.some((other) => other.key !== tab.key)
  return [
    member && { icon: 'pencil', label: t('menu.changeTitle'), run: () => renameDialog(t('menu.renameAgent'), member.name, (name) => api(`members/${member.id}/update`, { name })) },
    member && '-',
    tab.type !== 'stage' && { icon: 'x', label: t('menu.close'), run: () => closeTab(channel, tab.key) },
    { label: t('menu.closeOthers'), disabled: !others, run: () => closeOtherTabs(channel, tab.key) },
    tab.path && '-',
    tab.path && { icon: 'copy', label: t('menu.copyRelativePath'), run: () => copyText(tab.path) },
    tab.path && { icon: 'folder', label: t(REVEAL_KEY), run: () => reveal(tab.scope, tab.path) },
    tab.type === 'commit' && '-',
    tab.type === 'commit' && { icon: 'copy', label: t('menu.copySha'), run: () => copyText(tab.sha) },
    member && '-',
    member && { icon: 'moon', label: t('menu.sleep'), disabled: !ui.terminals.includes(member.id), run: () => api(`members/${member.id}/terminal/close`, {}) }
  ]
}

function renderTabs(channel, active) {
  tabsRoot.replaceChildren(
    ...[STAGE_TAB, ...channelTabs(channel).open].map((tab) => {
      const member = tab.type === 'agent' && channel.members.find(({ id }) => id === tab.memberId)
      const select = () => {
        channelTabs(channel).active = tab.key
        saveTabs()
        render()
      }
      return h(
        'div',
        {
          class: `tab${member && isUnread(member) ? ' unread' : ''}${docs.get(tab.key)?.editor?.dirty ? ' dirty' : ''}`,
          role: 'tab',
          tabindex: 0,
          'aria-selected': String(tab.key === active.key),
          title: tab.path ?? tab.subject ?? tabTitle(channel, tab),
          onClick: select,
          onKeydown: (event) => event.key === 'Enter' && select(),
          // Middle click closes, as in Orca.
          onAuxclick: (event) => event.button === 1 && tab.type !== 'stage' && closeTab(channel, tab.key),
          onContextmenu: (event) => {
            event.preventDefault()
            showMenu(event.clientX, event.clientY, tabMenu(channel, tab, member))
          }
        },
        member ? statusDot(member) : icon(TAB_ICONS[tab.type]),
        h('span', { class: 'tab-label' }, tabTitle(channel, tab)),
        tab.type !== 'stage' &&
          h(
            'button',
            {
              class: 'close',
              type: 'button',
              'aria-label': t('tabs.close'),
              onClick: (event) => {
                event.stopPropagation()
                closeTab(channel, tab.key)
              }
            },
            icon('x')
          )
      )
    })
  )
}

// --- Browser: the agent's Chrome, live, while its tab is shown (public/browser-view.js).
let browserView = null

function disposeBrowser() {
  browserView?.dispose()
  browserView = null
}

function renderBrowser(tab) {
  if (browserView?.key !== tab.key) {
    disposeBrowser()
    browserView = { key: tab.key, ...mountBrowser(tab.memberId, { h, t, api }) }
  }
  if (main.firstChild !== browserView.node) main.replaceChildren(browserView.node)
}

// --- Documents: files open editable; diffs and commits read-only. Kept while their tab stays open.
const docs = new Map()

function apiPath(scope, view, params = {}) {
  const query = new URLSearchParams(params).toString()
  return `${scope.kind}/${scope.id}/${view}${query ? `?${query}` : ''}`
}

const diffClass = (line) =>
  line.startsWith('+') && !line.startsWith('+++')
    ? 'add'
    : line.startsWith('-') && !line.startsWith('---')
      ? 'del'
      : line.startsWith('@@')
        ? 'hunk'
        : ''

function lineRows(text, classify) {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line, index) =>
    h('div', { class: `ln ${classify?.(line) ?? ''}` }, h('span', { class: 'ln-no' }, String(index + 1)), h('span', { class: 'ln-text' }, line))
  )
}

function renderDocument(tab) {
  let doc = docs.get(tab.key)
  if (!doc) {
    const body = h('pre', { class: 'document' }, h('div', { class: 'document-note' }, t('studio.loading')))
    const heading = tab.type === 'commit' ? `${tab.short}  ${tab.subject ?? ''}` : tab.path
    const status = h('span', { class: 'doc-status', role: 'status' })
    const banner = h('div', { class: 'doc-banner', role: 'alert', hidden: true })
    const node = h(
      'section',
      { class: 'studio-page' },
      h('div', { class: 'page-toolbar' }, icon(TAB_ICONS[tab.type]), h('span', { class: 'path', title: heading }, heading), status),
      banner,
      body
    )
    doc = { tab, node, body, status, banner, line: null, loaded: false }
    docs.set(tab.key, doc)
    void loadDocument(tab, doc)
  } else if (main.firstChild !== doc.node) {
    // Back on the tab: an agent may have changed the file meanwhile.
    void checkDisk(doc)
  }
  if (main.firstChild !== doc.node) main.replaceChildren(doc.node)
  if (doc.loaded && tab.line && doc.line !== tab.line) revealLine(doc, tab.line)
}

async function loadDocument(tab, doc) {
  const note = (text) => doc.body.replaceChildren(h('div', { class: 'document-note' }, text))
  try {
    if (tab.type === 'file') {
      const file = await api(apiPath(tab.scope, 'file', { path: tab.path }))
      if (file.binary) return note(t('doc.binary'))
      if (file.tooLarge) return note(t('doc.tooLarge', { size: `${Math.round(file.size / 1024)} KB` }))
      mountEditor(doc, file)
    } else if (tab.type === 'diff') {
      const { diff } = await api(apiPath(tab.scope, 'diff', { path: tab.path }))
      doc.body.replaceChildren(...lineRows(diff, diffClass))
    } else {
      const { text } = await api(apiPath(tab.scope, 'commit', { sha: tab.sha }))
      // The message above the first diff header is prose; a "- item" there is not a removed line.
      let inDiff = false
      doc.body.replaceChildren(...lineRows(text, (line) => ((inDiff ||= line.startsWith('diff --git')) ? diffClass(line) : '')))
    }
    doc.loaded = true
    if (tab.line) revealLine(doc, tab.line)
  } catch (error) {
    note(error.message)
  }
}

function revealLine(doc, line) {
  doc.line = line
  if (doc.editor) {
    const { area } = doc.editor
    const lines = area.value.split('\n')
    const start = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0)
    area.focus()
    area.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0))
    area.scrollTop = (line - 1) * parseFloat(getComputedStyle(area).lineHeight) - area.clientHeight / 2
    return
  }
  doc.body.querySelector('.ln.target')?.classList.remove('target')
  const row = doc.body.children[line - 1]
  row?.classList.add('target')
  row?.scrollIntoView({ block: 'center' })
}

function openDocument(scope, tab) {
  // Opening from a panel always shows the file as it is now; an open editor checks the disk instead of dropping edits.
  const doc = docs.get(tab.key)
  // The check may swap in new text, so the line is found again after it.
  if (doc?.editor) void checkDisk(doc).then(() => tab.line && revealLine(doc, tab.line))
  else docs.delete(tab.key)
  openTab(currentChannel(), { ...tab, scope })
}

/** Closing a tab saves what is left unsaved, then forgets it. */
function dropDoc(key) {
  const doc = docs.get(key)
  if (doc?.editor) void saveDoc(doc)
  docs.delete(key)
}

// --- Editor: a plain textarea over the file, saved on ⌘S and a second after typing stops (as Orca does).
const AUTOSAVE_MS = 1000

function mountEditor(doc, file) {
  const gutter = h('div', { class: 'gutter', 'aria-hidden': 'true' })
  const area = h('textarea', { class: 'code', wrap: 'off', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': doc.tab.path })
  const editor = h('div', { class: 'document editor' }, gutter, area)
  doc.body.replaceWith(editor)
  doc.body = editor
  doc.editor = { area, gutter, lines: 0, saved: '', version: '', eol: '\n', indent: '  ', timer: 0, saving: false, dirty: false, conflict: null }
  setEditorText(doc, file)
  area.addEventListener('input', () => {
    updateGutter(doc.editor)
    markDirty(doc)
    clearTimeout(doc.editor.timer)
    doc.editor.timer = setTimeout(() => saveDoc(doc), AUTOSAVE_MS)
  })
  area.addEventListener('scroll', () => (gutter.scrollTop = area.scrollTop))
  area.addEventListener('keydown', (event) => {
    const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveDoc(doc)
    } else if (event.key === 'Tab' && !mod && !event.shiftKey && !event.altKey) {
      // insertText keeps the browser's undo history.
      event.preventDefault()
      document.execCommand('insertText', false, doc.editor.indent)
    }
  })
}

function setEditorText(doc, file) {
  const editor = doc.editor
  const { area } = editor
  const { selectionStart, selectionEnd, scrollTop, scrollLeft } = area
  // A textarea turns CRLF into LF; remember it so a save writes the file's own line endings back.
  editor.eol = file.text.includes('\r\n') ? '\r\n' : '\n'
  editor.indent = /^\t/m.test(file.text) ? '\t' : '  '
  area.value = file.text
  editor.saved = area.value
  editor.version = file.version
  area.setSelectionRange(selectionStart, selectionEnd)
  area.scrollTop = scrollTop
  area.scrollLeft = scrollLeft
  updateGutter(editor)
  markDirty(doc)
}

function updateGutter(editor) {
  const lines = editor.area.value.split('\n').length
  if (lines === editor.lines) return
  editor.lines = lines
  editor.gutter.textContent = Array.from({ length: lines }, (_, index) => index + 1).join('\n')
  editor.gutter.scrollTop = editor.area.scrollTop
}

/** The tab shows a dot while the editor holds text the disk does not. */
function markDirty(doc) {
  const dirty = doc.editor.area.value !== doc.editor.saved
  if (dirty === doc.editor.dirty) return
  doc.editor.dirty = dirty
  if (docs.get(doc.tab.key) === doc) render()
}

async function saveDoc(doc, keepalive = false) {
  const editor = doc.editor
  clearTimeout(editor.timer)
  if (editor.conflict || editor.area.value === editor.saved) return
  if (editor.saving) {
    editor.timer = setTimeout(() => saveDoc(doc), AUTOSAVE_MS)
    return
  }
  const text = editor.area.value
  editor.saving = true
  try {
    const response = await fetch(`/api/${apiPath(doc.tab.scope, 'file')}`, {
      method: 'POST',
      keepalive,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: doc.tab.path, text: text.replaceAll('\n', editor.eol), version: editor.version })
    })
    const data = await response.json()
    if (response.status === 409) {
      const disk = await api(apiPath(doc.tab.scope, 'file', { path: doc.tab.path }))
      if (disk.version) showConflict(doc, disk)
      return
    }
    if (!response.ok) throw new Error(t(`errors.${data.error}`))
    editor.version = data.version
    editor.saved = text
    doc.status.textContent = ''
  } catch (error) {
    doc.status.textContent = error.message
  } finally {
    editor.saving = false
    markDirty(doc)
  }
}

/** Reloads a clean editor when the file changed on disk; a dirty one asks which side wins. */
async function checkDisk(doc) {
  const editor = doc.editor
  if (!editor || editor.saving || editor.conflict) return
  const disk = await api(apiPath(doc.tab.scope, 'file', { path: doc.tab.path })).catch(() => null)
  if (!disk?.version || disk.version === editor.version || editor.saving || editor.conflict) return
  if (editor.area.value === editor.saved) setEditorText(doc, disk)
  else showConflict(doc, disk)
}

function showConflict(doc, disk) {
  const editor = doc.editor
  clearTimeout(editor.timer)
  editor.conflict = disk
  const resolve = (keepMine) => {
    editor.conflict = null
    doc.banner.hidden = true
    if (keepMine) {
      editor.version = disk.version
      void saveDoc(doc)
    } else {
      setEditorText(doc, disk)
    }
  }
  doc.banner.replaceChildren(
    h('span', {}, t('doc.changed')),
    h('button', { class: 'ghost', type: 'button', onClick: () => resolve(true) }, t('doc.keepMine')),
    h('button', { class: 'ghost', type: 'button', onClick: () => resolve(false) }, t('doc.reload'))
  )
  doc.banner.hidden = false
}

const checkEditors = () => {
  for (const doc of docs.values()) if (doc.editor) void checkDisk(doc)
}
window.addEventListener('focus', checkEditors)
// Leaving the page (⌘R, quit) inside the autosave second still sends the edit; keepalive outlives the page.
window.addEventListener('pagehide', () => {
  for (const doc of docs.values()) if (doc.editor) void saveDoc(doc, true)
})

const scopeKeyOf = (scope) => `${scope.kind}/${scope.id}`
const openFile = (scope, path, line) => openDocument(scope, { key: `file:${scopeKeyOf(scope)}:${path}`, type: 'file', path, line })

// --- Right sidebar: Orca's icon-only activity bar over one panel at a time.
const PANEL_VIEW_KEY = 'whiplash.panelView'
const PANEL_VIEWS = [
  ['explorer', 'files', 'panel.explorer'],
  ['source', 'git-branch', 'panel.source'],
  ['history', 'history', 'panel.history']
]
let panelView = PANEL_VIEWS.some(([view]) => view === readStored(PANEL_VIEW_KEY)) ? readStored(PANEL_VIEW_KEY) : 'explorer'
let panelKey = ''
let panelStale = false
const explorer = { mode: 'names', query: '', expanded: new Map() }

/** The side panels look at the folder of the open tab: an agent's own, or the channel's. */
function scopeOf(channel, tab) {
  return tab.memberId ? { kind: 'members', id: tab.memberId } : (tab.scope ?? { kind: 'channels', id: channel.id })
}

function renderActivity() {
  activityRoot.replaceChildren(
    ...PANEL_VIEWS.map(([view, iconName, label]) =>
      h(
        'button',
        {
          class: 'activity',
          type: 'button',
          role: 'tab',
          'aria-selected': String(view === panelView),
          title: t(label),
          'aria-label': t(label),
          onClick: () => {
            panelView = view
            writeStored(PANEL_VIEW_KEY, view)
            render()
          }
        },
        icon(iconName)
      )
    )
  )
}

function renderRight(channel) {
  renderActivity()
  if (!panels.right) return
  const scope = scopeOf(channel, activeTab(channel))
  const key = `${panelView}|${scopeKeyOf(scope)}`
  if (key === panelKey && !panelStale) return
  panelKey = key
  panelStale = false
  if (scope.kind === 'channels' && channel.everyone) panel.replaceChildren(panelToolbar(''), h('div', { class: 'panel-scroll' }, note(t('panel.noFolder'))))
  else if (panelView === 'explorer') void renderExplorer(scope, key)
  else if (panelView === 'source') void renderSource(scope, key)
  else void renderHistory(scope, key)
}

const note = (text) => h('p', { class: 'panel-note' }, text)
const folderName = (folder) => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder
const splitPath = (path) => {
  const slash = path.lastIndexOf('/')
  return [path.slice(slash + 1), slash > 0 ? path.slice(0, slash) : '']
}
// git's two-letter porcelain codes, shown as Orca's single letter.
const statusLetter = (status) => (status === '??' ? 'U' : status.replace(/\s/g, '')[0] ?? 'M')

function panelToolbar(title) {
  return h(
    'div',
    { class: 'panel-toolbar' },
    h('span', { class: 'title', title }, title),
    h(
      'button',
      {
        class: 'icon-xs',
        type: 'button',
        title: t('panel.refresh'),
        'aria-label': t('panel.refresh'),
        onClick: () => {
          panelStale = true
          render()
        }
      },
      icon('refresh')
    )
  )
}

function buildTree(paths) {
  const root = { dirs: new Map(), files: [] }
  for (const path of paths) {
    let node = root
    for (const part of path.split('/').slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] })
      node = node.dirs.get(part)
    }
    node.files.push(path)
  }
  return root
}

async function renderExplorer(scope, key) {
  const toolbar = panelToolbar('')
  const modes = h('div', { class: 'segmented', role: 'group' })
  const input = h('input', { class: 'input', type: 'search', value: explorer.query })
  const list = h('div', { class: 'panel-scroll' }, note(t('studio.loading')))
  panel.replaceChildren(toolbar, h('div', { class: 'panel-query' }, modes, input), list)
  let result
  try {
    result = await Promise.all([api(apiPath(scope, 'files')), api(apiPath(scope, 'git')).catch(() => ({ git: null }))])
  } catch (error) {
    if (panelKey === key) list.replaceChildren(note(error.message))
    return
  }
  if (panelKey !== key) return
  const [{ folder, paths, truncated }, { git }] = result
  const title = toolbar.querySelector('.title')
  title.textContent = folderName(folder)
  title.title = folder
  const status = new Map((git?.files ?? []).map((file) => [file.path, statusLetter(file.status)]))
  const scopeKey = scopeKeyOf(scope)
  if (!explorer.expanded.has(scopeKey)) explorer.expanded.set(scopeKey, new Set())
  const expanded = explorer.expanded.get(scopeKey)
  const tree = buildTree(paths)
  let searchTimer = null
  let searchSeq = 0

  const indent = (row, depth) => {
    row.style.paddingLeft = `${depth * 16 + 8}px`
    return row
  }
  const fileRow = (path, depth, flat = false) => {
    const [name, dir] = splitPath(path)
    const code = status.get(path)
    return indent(
      h(
        'button',
        {
          class: 'tree-row',
          type: 'button',
          title: path,
          onClick: () => openFile(scope, path),
          onContextmenu: (event) => {
            event.preventDefault()
            showMenu(event.clientX, event.clientY, [{ icon: 'file', label: t('menu.viewFile'), run: () => openFile(scope, path) }, '-', ...pathItems(scope, folder, path)])
          }
        },
        h('span', { class: 'spacer-icon' }),
        icon('file'),
        h('span', { class: `name${code ? ` status-${code}` : ''}` }, name),
        flat && dir && h('span', { class: 'dir' }, dir),
        code && h('span', { class: `status status-${code}` }, code)
      ),
      depth
    )
  }
  const treeRows = (node, depth, prefix) => {
    const rows = []
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const dirPath = prefix ? `${prefix}/${name}` : name
      const open = expanded.has(dirPath)
      const toggleDir = () => {
        if (open) expanded.delete(dirPath)
        else expanded.add(dirPath)
        draw()
      }
      rows.push(
        indent(
          h(
            'button',
            {
              class: 'tree-row',
              type: 'button',
              'aria-expanded': String(open),
              onClick: toggleDir,
              onContextmenu: (event) => {
                event.preventDefault()
                showMenu(event.clientX, event.clientY, [
                  { icon: 'folder', label: t(open ? 'menu.collapse' : 'menu.expand'), run: toggleDir },
                  '-',
                  ...pathItems(scope, folder, dirPath)
                ])
              }
            },
            icon(open ? 'chevron-down' : 'chevron-right'),
            icon('folder'),
            h('span', { class: 'name' }, name)
          ),
          depth
        )
      )
      if (open) rows.push(...treeRows(child, depth + 1, dirPath))
    }
    rows.push(...node.files.map((path) => fileRow(path, depth)))
    return rows
  }
  const search = (query) => {
    clearTimeout(searchTimer)
    const seq = ++searchSeq
    searchTimer = setTimeout(async () => {
      list.replaceChildren(note(t('studio.loading')))
      const found = await api(apiPath(scope, 'search', { q: query })).catch((error) => ({ hits: [], error }))
      if (seq !== searchSeq || panelKey !== key) return
      if (found.error) return list.replaceChildren(note(found.error.message))
      const byPath = Map.groupBy(found.hits, (hit) => hit.path)
      list.replaceChildren(
        ...(byPath.size === 0
          ? [note(t('explorer.noMatches'))]
          : [...byPath].flatMap(([path, hits]) => [
              fileRow(path, 0, true),
              ...hits.map((hit) =>
                h(
                  'button',
                  { class: 'tree-row hit', type: 'button', onClick: () => openFile(scope, path, hit.line) },
                  h('span', { class: 'line-no' }, String(hit.line)),
                  h('span', { class: 'text' }, hit.text.trim())
                )
              )
            ])),
        ...(found.truncated ? [note(t('explorer.moreResults'))] : [])
      )
    }, 250)
  }
  function draw() {
    modes.replaceChildren(
      ...['names', 'contents'].map((mode) =>
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(explorer.mode === mode),
            onClick: () => {
              explorer.mode = mode
              draw()
              input.focus()
            }
          },
          t(`explorer.${mode}`)
        )
      )
    )
    const placeholder = t(explorer.mode === 'names' ? 'explorer.filter' : 'explorer.search')
    input.placeholder = placeholder
    input.setAttribute('aria-label', placeholder)
    const query = explorer.query.trim()
    if (explorer.mode === 'contents') {
      if (query) search(query)
      else list.replaceChildren(note(t('explorer.searchHint')))
      return
    }
    if (query) {
      const lowered = query.toLowerCase()
      const matches = paths.filter((path) => path.toLowerCase().includes(lowered)).slice(0, 300)
      list.replaceChildren(...(matches.length ? matches.map((path) => fileRow(path, 0, true)) : [note(t('explorer.noMatches'))]))
      return
    }
    list.replaceChildren(
      ...treeRows(tree, 0, ''),
      ...(paths.length === 0 ? [note(t('explorer.empty'))] : []),
      ...(truncated ? [note(t('explorer.truncated', { count: paths.length }))] : [])
    )
  }
  input.addEventListener('input', () => {
    explorer.query = input.value
    draw()
  })
  draw()
}

async function renderSource(scope, key) {
  const list = h('div', { class: 'panel-scroll' }, note(t('studio.loading')))
  panel.replaceChildren(panelToolbar(t('panel.source')), list)
  const { git } = await api(apiPath(scope, 'git')).catch(() => ({ git: null }))
  if (panelKey !== key) return
  if (!git) return list.replaceChildren(note(t('studio.notGit')))
  list.replaceChildren(
    h(
      'div',
      { class: 'branch' },
      icon('git-branch'),
      h('strong', {}, git.branch),
      h('span', { class: 'muted' }, t(git.isWorktree ? 'source.worktree' : 'source.mainCheckout'))
    ),
    h('div', { class: 'section-row' }, t('source.changes'), h('span', { class: 'count' }, String(git.files.length))),
    ...(git.files.length
      ? git.files.map((file) => {
          const [name, dir] = splitPath(file.path)
          const code = statusLetter(file.status)
          const viewChanges = () => openDocument(scope, { key: `diff:${scopeKeyOf(scope)}:${file.path}`, type: 'diff', path: file.path })
          const row = h(
            'button',
            {
              class: 'tree-row',
              type: 'button',
              title: file.path,
              onClick: viewChanges,
              onContextmenu: (event) => {
                event.preventDefault()
                showMenu(event.clientX, event.clientY, [
                  { icon: 'file-diff', label: t('menu.viewChanges'), run: viewChanges },
                  { icon: 'file', label: t('menu.viewFile'), disabled: code === 'D', run: () => openFile(scope, file.path) },
                  '-',
                  ...pathItems(scope, git.root, file.path)
                ])
              }
            },
            icon('file', `icon status-${code}`),
            h('span', { class: 'name' }, name),
            dir && h('span', { class: 'dir' }, dir),
            h('span', { class: `status status-${code}` }, code)
          )
          row.style.paddingLeft = '20px'
          return row
        })
      : [note(t('source.clean'))])
  )
}

async function renderHistory(scope, key) {
  const list = h('div', { class: 'panel-scroll' }, note(t('studio.loading')))
  panel.replaceChildren(panelToolbar(t('panel.history')), list)
  const { commits } = await api(apiPath(scope, 'log')).catch(() => ({ commits: [] }))
  if (panelKey !== key) return
  list.replaceChildren(
    ...(commits.length
      ? commits.map((commit) =>
          h(
            'button',
            {
              class: 'commit',
              type: 'button',
              title: commit.subject,
              onContextmenu: (event) => {
                event.preventDefault()
                showMenu(event.clientX, event.clientY, [{ icon: 'copy', label: t('menu.copySha'), run: () => copyText(commit.sha) }])
              },
              onClick: () =>
                openDocument(scope, {
                  key: `commit:${scopeKeyOf(scope)}:${commit.sha}`,
                  type: 'commit',
                  sha: commit.sha,
                  short: commit.short,
                  subject: commit.subject
                })
            },
            h('span', { class: 'subject' }, commit.subject),
            h('span', { class: 'meta' }, h('code', {}, commit.short), ` · ${commit.author} · ${timeAgo(commit.at)}`)
          )
        )
      : [note(t('history.empty'))])
  )
}

// --- Palettes: Orca's ⌘J (go to a channel or agent) and ⌘P (go to file).
function openPalette(placeholder, load) {
  const input = h('input', { class: 'palette-input', placeholder, 'aria-label': placeholder })
  const list = h('ul', { role: 'listbox' }, h('li', { class: 'panel-note' }, t('studio.loading')))
  let items = []
  let shown = []
  let active = 0
  const pick = (item) => {
    paletteRoot.close()
    item.run()
  }
  const select = (index) => {
    active = index
    list.querySelectorAll('li[role="option"]').forEach((row, rowIndex) => row.setAttribute('aria-selected', String(rowIndex === index)))
    list.children[index]?.scrollIntoView({ block: 'nearest' })
  }
  const draw = () => {
    const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean)
    shown = items.filter((item) => terms.every((term) => `${item.label} ${item.detail ?? ''}`.toLowerCase().includes(term))).slice(0, 200)
    list.replaceChildren(
      ...(shown.length
        ? shown.map((item, index) =>
            h(
              'li',
              { role: 'option', 'aria-selected': String(index === 0) },
              h(
                'button',
                { type: 'button', tabindex: -1, onClick: () => pick(item), onMousemove: () => active !== index && select(index) },
                icon(item.icon),
                h('span', {}, item.label),
                item.detail && h('span', { class: 'detail' }, item.detail)
              )
            )
          )
        : [h('li', { class: 'panel-note' }, t('palette.empty'))])
    )
    active = 0
  }
  input.addEventListener('input', draw)
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || shown.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      select((active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(shown[active])
    }
  })
  const hint = (key, label) => h('span', {}, h('kbd', {}, key), ` ${label}`)
  paletteRoot.replaceChildren(
    input,
    list,
    h('footer', {}, hint('↵', t('palette.open')), hint('↑↓', t('palette.navigate')), hint('esc', t('palette.close')))
  )
  if (!paletteRoot.open) paletteRoot.showModal()
  input.focus()
  Promise.resolve(load()).then(
    (loaded) => {
      items = loaded
      draw()
    },
    (error) => list.replaceChildren(h('li', { class: 'panel-note' }, error.message))
  )
}

paletteRoot.addEventListener('click', (event) => {
  if (event.target === paletteRoot) paletteRoot.close()
})

function switchPalette() {
  openPalette(t('palette.switch'), () =>
    ui.channels.flatMap((channel) => [
      { icon: 'hash', label: `# ${channel.name}`, detail: channel.cwd, run: () => selectChannel(channel) },
      ...channel.members.map((member) => ({
        icon: 'terminal',
        label: member.name,
        detail: `#${channel.name} · ${member.harness}`,
        run: () => openAgent(member.id)
      }))
    ])
  )
}

function filePalette() {
  const channel = currentChannel()
  if (!channel || ui.view === 'settings') return
  const scope = scopeOf(channel, activeTab(channel))
  openPalette(t('palette.files'), async () => {
    const { paths } = await api(apiPath(scope, 'files'))
    return paths.map((path) => {
      const [name, dir] = splitPath(path)
      return { icon: 'file', label: name, detail: dir, run: () => openFile(scope, path) }
    })
  })
}

// --- Settings: a full page, as in Orca, with a left nav and section cards.
let settingsDirty = true
let settingsSection = 'general'
const SETTINGS_SECTIONS = [
  ['general', 'sliders'],
  ['accounts', 'circle-user'],
  ['terminal', 'terminal'],
  ['shortcuts', 'keyboard']
]

function settingsBlock(id, ...cards) {
  return h(
    'section',
    { class: 'settings-section', id: `settings-${id}` },
    h('header', {}, h('h2', {}, t(`settings.${id}`)), h('p', {}, t(`settings.${id}Body`))),
    ...cards
  )
}

function settingsRow(label, description, control) {
  return h(
    'div',
    { class: 'settings-row' },
    h('div', { class: 'row-label' }, h('strong', {}, label), description && h('span', {}, description)),
    control
  )
}

function segmented(options, current, onPick) {
  return h(
    'div',
    { class: 'segmented', role: 'group' },
    ...options.map(([value, label]) => h('button', { type: 'button', 'aria-pressed': String(value === current), onClick: () => onPick(value) }, label))
  )
}

function setTheme(value) {
  writeStored(THEME_KEY, value)
  applyTheme(value)
  repaintForTheme()
}

function accountRow(name, account, providerUsage, loginHint) {
  const windows = providerUsage ? [providerUsage.session, providerUsage.weekly].filter(Boolean) : []
  return h(
    'div',
    { class: 'settings-row' },
    h(
      'div',
      { class: 'row-label' },
      h(
        'strong',
        { class: 'account-head' },
        h('span', { class: `dot${account?.signedIn ? ' attached' : ''}`, 'aria-hidden': 'true' }),
        name,
        h('span', { class: 'value' }, account?.email ?? '')
      ),
      h(
        'span',
        {},
        !account
          ? t('studio.loading')
          : account.signedIn
            ? [t('settings.signedIn'), account.plan && ` · ${t('settings.plan', { plan: account.plan })}`].filter(Boolean).join('')
            : `${t('settings.signedOut')} — ${loginHint}`
      )
    ),
    h(
      'div',
      { class: 'account-usage' },
      ...windows.map((window) => {
        const percent = clampUsedPercent(window.usedPercent)
        return h(
          'div',
          { class: 'usage-detail' },
          h('span', { class: 'usage-label' }, window === providerUsage.session ? t('usage.session') : t('usage.weekly'), h('strong', {}, t('usage.used', { percent }))),
          usageBar(percent, true),
          h('span', { class: 'usage-reset' }, resetText(window))
        )
      })
    )
  )
}

function renderSettings() {
  const content = h('div', { class: 'settings-inner' })
  const navItems = SETTINGS_SECTIONS.map(([id, iconName]) =>
    h(
      'button',
      {
        class: 'nav-item',
        type: 'button',
        'aria-current': String(id === settingsSection),
        onClick: () => {
          settingsSection = id
          navItems.forEach((item, index) => item.setAttribute('aria-current', String(SETTINGS_SECTIONS[index][0] === id)))
          content.querySelector(`#settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      },
      icon(iconName),
      t(`settings.${id}`)
    )
  )
  const accounts = h('div', { class: 'settings-card' }, accountRow('Claude Code', null), accountRow('Codex', null))
  const terminal = h('div', { class: 'settings-card' }, note(t('studio.loading')))
  const keys = (...parts) => h('span', { class: 'shortcut-keys' }, ...parts.map((part) => h('kbd', {}, part)))
  content.append(
    settingsBlock(
      'general',
      h(
        'div',
        { class: 'settings-card' },
        settingsRow(t('settings.language'), t('settings.languageBody'), segmented([['ko', '한국어'], ['en', 'English']], locale, setLocale)),
        settingsRow(
          t('settings.theme'),
          t('settings.themeBody'),
          segmented(
            [['system', t('settings.system')], ['light', t('settings.light')], ['dark', t('settings.dark')]],
            readStored(THEME_KEY) ?? 'system',
            setTheme
          )
        ),
        settingsRow(
          t('settings.notify'),
          t('settings.notifyBody'),
          segmented([['sound', t('settings.notifySound')], ['silent', t('settings.notifySilent')], ['off', t('settings.notifyOff')]], notifyMode, setNotifyMode)
        )
      )
    ),
    settingsBlock('accounts', accounts),
    settingsBlock('terminal', terminal),
    settingsBlock(
      'shortcuts',
      h(
        'div',
        { class: 'settings-card' },
        settingsRow(t('shortcut.switch'), null, keys(MOD, 'J')),
        settingsRow(t('shortcut.files'), null, keys(MOD, 'P')),
        settingsRow(t('shortcut.left'), null, keys(MOD, 'B')),
        settingsRow(t('shortcut.right'), null, keys(MOD, 'L')),
        settingsRow(t('shortcut.settings'), null, keys(MOD, ',')),
        settingsRow(t('shortcut.send'), null, keys('Enter')),
        settingsRow(t('shortcut.newline'), null, keys('Shift', 'Enter')),
        settingsRow(t('shortcut.clearReply'), null, keys('Esc'))
      )
    )
  )
  settingsRoot.replaceChildren(
    h('div', { class: 'settings-titlebar' }, h('span', { class: 'traffic-pad' })),
    h(
      'div',
      { class: 'settings-body' },
      h(
        'aside',
        { class: 'settings-nav' },
        h('div', {}, h('button', { class: 'back', type: 'button', onClick: () => (location.hash = '#/') }, icon('arrow-left'), t('settings.back'))),
        h('nav', {}, ...navItems)
      ),
      h('div', { class: 'settings-content' }, content)
    )
  )
  // Opened for a section (e.g. accounts from the usage popover): land on it.
  if (settingsSection !== 'general') requestAnimationFrame(() => content.querySelector(`#settings-${settingsSection}`)?.scrollIntoView({ block: 'start' }))
  void api('accounts').then(({ claude, codex }) =>
    accounts.replaceChildren(
      accountRow('Claude Code', claude, usage?.claude, t('settings.loginClaude')),
      accountRow('Codex', codex, usage?.codex, t('settings.loginCodex'))
    )
  )
  void api('terminal-appearance').then(
    (appearance) =>
      terminal.replaceChildren(
        settingsRow(t('settings.font'), null, h('span', { class: 'value' }, appearance.fontFamily)),
        settingsRow(t('settings.fontSize'), null, h('span', { class: 'value' }, `${appearance.fontSize}px`)),
        settingsRow(t('settings.darkTheme'), null, h('span', { class: 'value' }, appearance.themeDark)),
        settingsRow(t('settings.lightTheme'), null, h('span', { class: 'value' }, appearance.themeLight))
      ),
    () => terminal.replaceChildren(note(t('settings.noOrca')))
  )
}

function render() {
  const inSettings = ui.view === 'settings'
  appRoot.classList.toggle('settings-open', inSettings)
  settingsRoot.hidden = !inSettings
  if (inSettings) {
    if (settingsDirty) {
      settingsDirty = false
      renderSettings()
    }
    return
  }
  const channel = currentChannel() ?? ui.channels[0]
  ui.channelId = channel?.id ?? null
  if (!channel) {
    renderChannels()
    disposeStudio()
    disposeBrowser()
    tabsRoot.replaceChildren()
    main.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'Not quite my tempo.'), t('home.body')))
    renderActivity()
    panel.replaceChildren(note(t('home.body')))
    panelKey = ''
    return
  }
  const tab = activeTab(channel)
  const member = tab.type === 'agent' && channel.members.find(({ id }) => id === tab.memberId)
  // Looking is reading: the stage shows every member's replies, an agent tab its own terminal.
  if (document.visibilityState === 'visible') markSeen(member ? [member] : tab.type === 'stage' ? channel.members : [])
  renderChannels()
  renderTabs(channel, tab)
  if (tab.type !== 'browser') disposeBrowser()
  if (member) {
    renderStudio(member)
  } else {
    disposeStudio()
    if (tab.type === 'stage') renderStage(channel)
    else if (tab.type === 'browser') renderBrowser(tab)
    else renderDocument(tab)
  }
  renderRight(channel)
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
  const view = location.hash === '#/settings' ? 'settings' : 'app'
  if (view === 'settings' && ui.view !== 'settings') settingsDirty = true
  ui.view = view
  render()
}

function reject(member) {
  return api(`members/${member.id}/reject`, { locale })
}

document.querySelector('#new-channel').addEventListener('click', () => void channelDialog())
document.querySelector('#open-palette').addEventListener('click', switchPalette)
document.querySelector('#open-settings').addEventListener('click', () => (location.hash = '#/settings'))
document.querySelector('#new-tab').addEventListener('click', (event) => addAgentMenu(event.currentTarget, currentChannel()))
// The open terminal repaints with the matching Orca theme; runs only after startup, once studio exists.
function repaintForTheme() {
  if (studio) {
    studio.termSlot.style.background = terminalTheme().background
    studio.term?.setTheme(terminalTheme())
  }
  settingsDirty = true
  applyStaticText()
  render()
}

document.querySelector('#theme').addEventListener('click', () => setTheme(colorMode() === 'light' ? 'dark' : 'light'))
matchMedia('(prefers-color-scheme: light)').addEventListener('change', repaintForTheme)
applyStaticText()
void refreshUsage()
setInterval(() => void refreshUsage(), USAGE_REFRESH_MS)
setInterval(renderUsage, USAGE_TICK_MS)
window.addEventListener('hashchange', route)

// --- Notifications, as Orca posts them: an agent answered, failed or needs you while you look elsewhere.
const NOTIFY_KEY = 'whiplash.notify'
const NOTIFY_BODY_CHARS = 180
let notifyMode = readStored(NOTIFY_KEY) ?? 'sound'
let notifySeen = null
let badgeCount = -1

function setNotifyMode(value) {
  notifyMode = value
  writeStored(NOTIFY_KEY, value)
  if (value !== 'off' && window.Notification?.permission === 'default') void Notification.requestPermission()
  settingsDirty = true
  render()
}

function postNotification(title, body, open) {
  if (notifyMode === 'off' || window.Notification?.permission !== 'granted') return
  const notification = new Notification(title, { body: body.slice(0, NOTIFY_BODY_CHARS), silent: notifyMode === 'silent' })
  notification.onclick = () => {
    window.whiplashDesktop?.focus?.()
    window.focus()
    open()
  }
}

/** Compares each state with the last: new replies and alerts, and agents that just started waiting on you. */
function notifyChanges() {
  const seen = { seq: new Map(), waiting: new Set() }
  for (const channel of ui.channels) {
    seen.seq.set(channel.id, channel.nextSeq)
    const looking = document.hasFocus() && ui.view !== 'settings' && channel.id === ui.channelId
    const since = notifySeen?.seq.get(channel.id)
    if (since === undefined || looking) continue
    for (const message of channel.messages.filter(({ seq }) => seq >= since)) {
      const member = channel.members.find(({ id }) => id === (message.author.memberId ?? message.alertMemberId))
      if (!member || !(message.author.kind === 'agent' || message.alertMemberId)) continue
      const body = message.notice ? t(`notices.${message.notice.key}`, message.notice.params) : message.text
      postNotification(`${member.name} · #${channel.name}`, body, () => selectChannel(channel))
    }
  }
  for (const channel of ui.channels.filter(({ everyone }) => !everyone)) {
    for (const member of channel.members.filter((candidate) => liveState(candidate) === 'waiting')) {
      seen.waiting.add(member.id)
      const looking = document.hasFocus() && ui.view !== 'settings' && channel.id === ui.channelId
      if (notifySeen && !notifySeen.waiting.has(member.id) && !looking) {
        postNotification(`${member.name} · #${channel.name}`, t('notify.waiting'), () => openAgent(member.id))
      }
    }
  }
  notifySeen = seen
}

/** The Dock badge, like Orca's: how many agents have replies you have not looked at. */
function updateBadge() {
  const count = ui.channels.filter(({ everyone }) => !everyone).flatMap(({ members }) => members).filter(isUnread).length
  if (count === badgeCount) return
  badgeCount = count
  window.whiplashDesktop?.setBadge?.(count)
  document.title = count ? `(${count}) Whiplash` : 'Whiplash'
}

const events = new EventSource('/api/events')
events.addEventListener('state', (event) => {
  const next = JSON.parse(event.data)
  // A finished turn may have changed files and commits; the side panel reloads on its next render.
  const turnEnded = Object.keys(ui.activity).some((id) => !next.activity[id])
  if (turnEnded) panelStale = true
  ui.channels = next.channels
  ui.activity = next.activity
  ui.queued = next.queued ?? []
  ui.terminals = next.terminals ?? []
  ui.terminalStatus = next.terminalStatus ?? {}
  notifyChanges()
  render()
  updateBadge()
  if (turnEnded) checkEditors()
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
