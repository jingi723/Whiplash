// Agent output is untrusted and this page can drive agents, so every value goes through textContent.
const LOW_STAMINA = 25
const DEFAULT_WINDOW = 200_000
const LARGE_WINDOW = 1_000_000
const LIVE_SESSION_MS = 120_000
const MENTION_QUERY = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u
const NEAR_BOTTOM_PX = 120

const ui = { channels: [], activity: {}, channelId: null, studioId: null, log: [] }
const main = document.querySelector('#main')
const channelNav = document.querySelector('#channels')
const dialog = document.querySelector('#dialog')

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
    throw new Error(data.error ?? '요청이 실패했습니다.')
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
      'aria-label': `${member.name} 스태미나`,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': percent,
      title: `스태미나 ${percent}% · 컨텍스트 ${(member.contextTokens ?? 0).toLocaleString()} 토큰`
    },
    fill
  )
}

function staminaLabel(member) {
  const percent = staminaOf(member)
  if (percent === 0) return '실신'
  if (percent <= LOW_STAMINA) return `탈진 직전 ${percent}%`
  return percent < 60 ? `지침 ${percent}%` : `쌩쌩 ${percent}%`
}

function activityLabel(member) {
  const activity = ui.activity[member.id]
  if (activity === 'working') return h('span', { class: 'tag live' }, '연주 중')
  if (activity === 'queued') return h('span', { class: 'tag live' }, '대기열')
  return h('span', { class: 'tag' }, member.harness)
}

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
      message.text,
      member &&
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            { class: 'danger', type: 'button', onClick: () => api(`members/${member.id}/reject`, {}) },
            '의자 던지기'
          ),
          h('button', { class: 'ghost', type: 'button', onClick: () => openStudio(member.id) }, 'Studio')
        )
    )
  }
  const member = author.kind === 'agent' && channel.members.find(({ id }) => id === author.memberId)
  const name = author.kind === 'human' ? '지휘자' : `@${author.name}`
  return h(
    'article',
    { class: 'message' },
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
          { class: 'tempo', type: 'button', onClick: () => api(`members/${member.id}/reject`, {}) },
          'Not quite my tempo'
        )
    ),
    markdown(message.text, channel.members)
  )
}

function createComposer(channelId) {
  const input = h('textarea', { rows: 2 })
  const list = h('ul', { class: 'suggestions', role: 'listbox', 'aria-label': '멘션할 멤버', hidden: true })
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
  const submit = async () => {
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    refresh()
    await api(`channels/${channelId}/messages`, { text }).catch((error) => {
      input.value = text
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
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  })
  return { element: h('div', { class: 'composer' }, list, input), input }
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
    composer,
    bar,
    list,
    members,
    buttons,
    nodes: [
      h('section', { class: 'stage' }, bar, list, composer.element),
      h('aside', { class: 'roster', 'aria-label': '멤버' }, members, buttons)
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
  composer.input.setAttribute('aria-label', `#${channel.name}에 메시지 보내기`)
  composer.input.placeholder = `#${channel.name}에 지휘하기 · @이름으로 호출, /tempo @이름 사유로 반려`
  bar.replaceChildren(
    h('h1', {}, `# ${channel.name}`),
    h('span', { class: 'path', title: channel.cwd }, channel.cwd),
    ...(channel.checkCommand
      ? [h('span', { class: 'tag', title: '턴이 끝날 때마다 실행합니다' }, `검사: ${channel.checkCommand}`)]
      : [])
  )
  list.setAttribute('aria-label', `#${channel.name} 대화`)
  list.replaceChildren(
    ...(channel.messages.length
      ? channel.messages.map((message) => messageRow(channel, message))
      : [
          h(
            'div',
            { class: 'empty' },
            h('strong', {}, '무대가 비었습니다'),
            '세션을 가져오거나 에이전트를 영입한 뒤 @이름으로 호출하세요.'
          )
        ])
  )
  members.replaceChildren(
    h('p', { class: 'label' }, '멤버'),
    ...channel.members.map((member) =>
      h(
        'button',
        { class: 'member', type: 'button', title: 'Studio 열기', onClick: () => openStudio(member.id) },
        h('span', { class: 'row' }, h('span', { class: 'name' }, `@${member.name}`), activityLabel(member)),
        staminaBar(member)
      )
    )
  )
  buttons.replaceChildren(
    h('button', { class: 'primary', type: 'button', onClick: () => importDialog(channel) }, '세션 가져오기'),
    h('button', { class: 'ghost', type: 'button', onClick: () => hireDialog(channel) }, '새 에이전트 영입')
  )
  if (stick) list.scrollTop = list.scrollHeight
}

function renderEntry(entry) {
  const kind = entry.kind === 'output' && entry.isError ? 'output error' : entry.kind
  return h('p', { class: `entry ${kind}` }, entry.text)
}

async function loadDiff(member, path, target, button) {
  target.replaceChildren('불러오는 중')
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
  const consoleView = h('div', { class: 'console', role: 'log', 'aria-label': '실시간 로그' })
  consoleView.append(...(log.length ? log.map(renderEntry) : [h('p', { class: 'entry output' }, '이 Whiplash 실행에서 아직 연주한 턴이 없습니다.')]))
  const diffView = h('div', { class: 'diff', 'aria-label': '변경 내용' }, '파일을 고르면 변경 내용이 보입니다.')
  const page = h(
    'section',
    { class: 'studio-page' },
    h(
      'div',
      { class: 'bar' },
      h('button', { class: 'ghost', type: 'button', onClick: () => (location.hash = '#/') }, '← Stage'),
      h('h2', {}, `@${member.name}`),
      activityLabel(member),
      h('span', { class: 'path', title: member.cwd }, member.cwd),
      h('span', { class: 'spacer' }),
      h('div', { class: 'studio-stamina' }, staminaLabel(member), staminaBar(member)),
      h('button', { class: 'ghost', type: 'button', disabled: !running, onClick: () => api(`members/${member.id}/stop`, {}) }, '멈추기'),
      h('button', { class: 'danger', type: 'button', onClick: () => api(`members/${member.id}/reject`, {}) }, 'Not quite my tempo')
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
            ? [h('strong', {}, git.branch), git.isWorktree ? ' · worktree' : ' · 기본 체크아웃', ` · 변경 ${git.files.length}개`]
            : 'git 저장소가 아닙니다.',
          h('div', { class: 'path', title: member.sessionId ?? '' }, `세션 ${member.sessionId ?? '첫 호출 때 생성'} · #${channel.name}`)
        ),
        h(
          'div',
          { class: 'files', 'aria-label': '변경된 파일' },
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
        '채널을 만들면 무대가 열립니다.'
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
      h('button', { class: 'ghost', type: 'button', onClick: () => dialog.close() }, '취소'),
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
    '채널 만들기',
    [
      field('이름', h('input', { name: 'name', required: true, autofocus: true, placeholder: 'general' })),
      field('프로젝트 폴더', h('input', { name: 'cwd', required: true, list: 'folders', placeholder: '/Users/you/projects/app' })),
      folders,
      field('턴 후 검사 명령 (선택)', h('input', { name: 'checkCommand', placeholder: 'pnpm build' })),
      h('p', { class: 'hint' }, '검사가 실패하면 빌드 에러로 보고 채널에 경고를 올립니다.')
    ],
    '만들기',
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
    `#${channel.name}에 새 에이전트 영입`,
    [
      field('이름', h('input', { name: 'name', required: true, autofocus: true, placeholder: 'Coder-Agent' })),
      field('종류', h('select', { name: 'harness' }, h('option', { value: 'claude' }, 'Claude Code'), h('option', { value: 'codex' }, 'Codex'))),
      field('지시문 (선택)', h('textarea', { name: 'instructions', rows: 3 })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'worktree', checked: true }), '전용 git worktree에서 작업')
    ],
    '영입',
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
  if (minutes < 1) return '방금'
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}시간 전` : `${Math.round(hours / 24)}일 전`
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
      h('span', { class: 'title' }, session.title || '(제목 없음)'),
      h('span', { class: 'path' }, session.cwd),
      h(
        'span',
        { class: 'time' },
        `${session.harness} · ${timeAgo(session.updatedAt)}${Date.now() - session.updatedAt < LIVE_SESSION_MS ? ' · 지금 다른 콘솔에서 쓰는 중일 수 있음' : ''}`
      )
    )
    return row
  })
  showDialog(
    '세션 가져오기',
    [
      h('p', { class: 'hint' }, 'Claude Code, Codex, Orca 어디서 시작했든 가져와 이어갑니다. 터미널에 열려 있는 세션은 닫고 가져오는 게 안전합니다.'),
      h('div', { class: 'sessions' }, rows.length ? rows : h('p', { class: 'hint' }, '가져올 세션이 없습니다.')),
      field('Stage에서 쓸 이름', name)
    ],
    '가져오기',
    async (data) => {
      if (!selected) throw new Error('세션을 고르세요.')
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

document.querySelector('#new-channel').addEventListener('click', () => void channelDialog())
window.addEventListener('hashchange', route)

const events = new EventSource('/api/events')
events.addEventListener('state', (event) => {
  const next = JSON.parse(event.data)
  ui.channels = next.channels
  ui.activity = next.activity
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
