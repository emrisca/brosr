#!/usr/bin/env node
// File-based message bus between the Windows and Mac machines.
// Syncthing copies the files. This script writes, claims and answers them.
//
// Layout under the Syncthing root (the folder that holds .stfolder):
//   inbox/<side>/       messages waiting for that side
//   processing/<side>/  messages that side has claimed
//   done/<side>/        messages that side has answered
//   locks/              reserved for a side that needs an exclusive hold
//
// Usage:
//   node handoff.mjs send --from=win --to=mac --type=setup --payload='{"a":1}'
//   node handoff.mjs list --side=win
//   node handoff.mjs check --side=win   exits 3 when a message waits
//   node handoff.mjs status             waiting and claimed work, with its age
//   node handoff.mjs tidy --dry-run     removes stale Syncthing temp files
//   node handoff.mjs claim --side=win
//   node handoff.mjs reply --side=win --id=<id> --type=result --payload='{"ok":true}'
//   node handoff.mjs watch --side=win
//
// JSON events go to stdout, one per line. Notes and errors go to stderr.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SIDES = ['win', 'mac']
const TYPES = ['request', 'review', 'result', 'status', 'setup', 'cancel']
const DEFAULT_ROOT = path.dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const cmd = argv[0]

const args = new Map()
for (const raw of argv.slice(1)) {
  const m = /^--([^=]+)=([\s\S]*)$/.exec(raw)
  if (m) args.set(m[1], m[2])
}

function fail(message, code = 1) {
  process.stderr.write(`handoff: ${message}\n`)
  process.exit(code)
}

function need(name) {
  const value = args.get(name)
  if (!value) fail(`missing --${name}=`)
  return value
}

function sideArg() {
  const side = need('side')
  if (!SIDES.includes(side)) fail(`unknown side ${side}, use win or mac`)
  return side
}

function other(side) {
  return side === 'win' ? 'mac' : 'win'
}

const root = path.resolve(args.get('root') || DEFAULT_ROOT)
const dir = {
  inbox: (s) => path.join(root, 'inbox', s),
  processing: (s) => path.join(root, 'processing', s),
  done: (s) => path.join(root, 'done', s),
}

function ensureTree() {
  for (const s of SIDES) {
    for (const make of [dir.inbox, dir.processing, dir.done]) {
      fs.mkdirSync(make(s), { recursive: true })
    }
  }
  fs.mkdirSync(path.join(root, 'locks'), { recursive: true })
}

function readDirSafe(target) {
  try {
    return fs.readdirSync(target)
  } catch {
    return []
  }
}

function messagesIn(target) {
  return readDirSafe(target)
    .filter((name) => name.endsWith('.json'))
    .sort()
}

function stamp(date = new Date()) {
  const two = (n) => String(n).padStart(2, '0')
  return [
    date.getUTCFullYear(),
    two(date.getUTCMonth() + 1),
    two(date.getUTCDate()),
  ].join('') + '-' + [two(date.getUTCHours()), two(date.getUTCMinutes()), two(date.getUTCSeconds())].join('')
}

function nextSeq(from) {
  let max = 0
  const pattern = new RegExp(`-${from}-(\\d{4})\\.json$`)
  for (const s of SIDES) {
    for (const target of [dir.inbox(s), dir.processing(s), dir.done(s)]) {
      for (const name of messagesIn(target)) {
        const m = pattern.exec(name)
        if (m) max = Math.max(max, Number(m[1]))
      }
    }
  }
  return String(max + 1).padStart(4, '0')
}

// The file gets its final name only when its bytes are complete.
function writeAtomic(target, text) {
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, target)
}

function parsePayload() {
  if (args.has('payload-file')) {
    const file = args.get('payload-file')
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      fail(`cannot read --payload-file ${file}: ${error.message}`)
    }
  }
  const raw = args.get('payload')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { message: raw }
  }
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n')
}

// Move one message out of an inbox, so only one reader can hold it.
function claimOne(side) {
  const inbox = dir.inbox(side)
  const claimed = dir.processing(side)
  fs.mkdirSync(claimed, { recursive: true })
  for (const name of messagesIn(inbox)) {
    const from = path.join(inbox, name)
    const to = path.join(claimed, name)
    try {
      fs.renameSync(from, to)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    let body
    try {
      body = JSON.parse(fs.readFileSync(to, 'utf8'))
    } catch (error) {
      fail(`message ${name} is not valid JSON: ${error.message}`)
    }
    return { ...body, path: to }
  }
  return null
}

function findClaimed(side, id) {
  const name = `${id}.json`
  for (const target of [dir.processing(side), dir.inbox(side)]) {
    const full = path.join(target, name)
    if (fs.existsSync(full)) return full
  }
  return null
}

function send() {
  const from = args.get('from')
  if (!SIDES.includes(from)) fail(`unknown --from=${from}, use win or mac`)
  const to = need('to')
  if (!SIDES.includes(to)) fail(`unknown --to=${to}, use win or mac`)
  if (to === from) fail('a message needs a different side')
  const type = args.get('type') || 'request'
  if (!TYPES.includes(type)) fail(`unknown --type=${type}`)
  ensureTree()

  const seq = nextSeq(from)
  const id = `${stamp()}-${from}-${seq}`
  const message = {
    id,
    from,
    to,
    type,
    created: new Date().toISOString(),
    status: 'pending',
    payload: parsePayload(),
  }
  const target = path.join(dir.inbox(to), `${id}.json`)
  writeAtomic(target, JSON.stringify(message, null, 2) + '\n')
  emit({ event: 'sent', id, from, to, type, path: target })
}

function list() {
  const side = sideArg()
  const rows = messagesIn(dir.inbox(side)).map((name) => {
    const full = path.join(dir.inbox(side), name)
    let body = null
    try {
      body = JSON.parse(fs.readFileSync(full, 'utf8'))
    } catch {
      body = { unreadable: true }
    }
    return { name, path: full, message: body }
  })
  emit({ event: 'list', side, count: rows.length, messages: rows })
}

// A turn starts here. The exit code says whether work waits, and nothing is claimed.
function check() {
  const side = sideArg()
  ensureTree()
  const pending = messagesIn(dir.inbox(side))
  emit({ event: 'check', side, count: pending.length, pending, root })
  process.exit(pending.length ? 3 : 0)
}

// Open work at a glance: what waits in each inbox and what sits claimed.
function status() {
  ensureTree()
  const now = Date.now()
  const rows = []
  const collect = (side, target, state) => {
    for (const name of messagesIn(target)) {
      const full = path.join(target, name)
      let body
      try {
        body = JSON.parse(fs.readFileSync(full, 'utf8'))
      } catch {
        rows.push({ side, state, name, unreadable: true })
        continue
      }
      const created = Date.parse(body.created)
      rows.push({
        side,
        state,
        id: body.id,
        from: body.from,
        type: body.type,
        created: body.created,
        ageMinutes: Number.isFinite(created) ? Math.round((now - created) / 60000) : null,
        inReplyTo: body.in_reply_to || null,
      })
    }
  }
  for (const side of SIDES) {
    collect(side, dir.inbox(side), 'waiting')
    collect(side, dir.processing(side), 'claimed')
  }
  const waiting = rows.filter((row) => row.state === 'waiting').length
  const claimed = rows.filter((row) => row.state === 'claimed').length
  emit({ event: 'status', waiting, claimed, rows })
}

// Syncthing writes a temp beside a file while it copies it. A stopped transfer leaves
// that half-written file behind, and it once hid a deleted tracked file.
function tidy() {
  ensureTree()
  const dryRun = argv.includes('--dry-run')
  const keepSeconds = Number(args.get('younger-than') || 900)
  if (!Number.isFinite(keepSeconds) || keepSeconds < 0) fail('--younger-than must be 0 or more')
  const cutoff = Date.now() - keepSeconds * 1000
  const removed = []
  const kept = []

  const walk = (target) => {
    let entries
    try {
      entries = fs.readdirSync(target, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(target, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        walk(full)
        continue
      }
      const name = entry.name
      const isTemp =
        (name.startsWith('.syncthing.') && name.endsWith('.tmp')) || name.startsWith('~syncthing~')
      if (!isTemp) continue
      let stat
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      const shown = path.relative(root, full)
      if (stat.mtimeMs > cutoff) {
        kept.push(shown)
        continue
      }
      if (!dryRun) fs.rmSync(full, { force: true })
      removed.push(shown)
    }
  }

  walk(root)
  emit({ event: 'tidy', root, dryRun, youngerThanSeconds: keepSeconds, removed, kept })
}

function claim() {
  const side = sideArg()
  const message = claimOne(side)
  if (!message) {
    emit({ event: 'empty', side })
    process.exit(2)
  }
  emit({ event: 'claimed', side, ...message })
}

// Answer a claimed message: the reply goes to the other inbox, the original to done.
function reply() {
  const side = sideArg()
  const id = need('id')
  const type = args.get('type') || 'result'
  if (!TYPES.includes(type)) fail(`unknown --type=${type}`)
  const source = findClaimed(side, id)
  if (!source) fail(`no message ${id} in the inbox or processing folder for ${side}`)
  ensureTree()

  const seq = nextSeq(side)
  const replyId = `${stamp()}-${side}-${seq}`
  const out = {
    id: replyId,
    from: side,
    to: other(side),
    type,
    created: new Date().toISOString(),
    status: 'pending',
    in_reply_to: id,
    payload: parsePayload(),
  }
  const target = path.join(dir.inbox(other(side)), `${replyId}.json`)
  writeAtomic(target, JSON.stringify(out, null, 2) + '\n')

  const parked = path.join(dir.done(side), `${id}.json`)
  fs.mkdirSync(dir.done(side), { recursive: true })
  fs.renameSync(source, parked)
  emit({ event: 'replied', id, reply: replyId, to: other(side), path: target, archived: parked })
}

function watch() {
  const side = sideArg()
  const interval = Number(args.get('interval') || 1000)
  if (!Number.isFinite(interval) || interval < 200) fail('--interval must be 200 or more')
  ensureTree()
  emit({ event: 'ready', side, root, interval })
  const timer = setInterval(() => {
    let message = null
    try {
      message = claimOne(side)
    } catch (error) {
      emit({ event: 'error', side, message: error.message })
      return
    }
    if (message) emit({ event: 'message', side, ...message })
  }, interval)
  process.on('SIGINT', () => {
    clearInterval(timer)
    emit({ event: 'stopped', side })
    process.exit(0)
  })
}

switch (cmd) {
  case 'send':
    send()
    break
  case 'list':
    list()
    break
  case 'check':
    check()
    break
  case 'status':
    status()
    break
  case 'tidy':
    tidy()
    break
  case 'claim':
    claim()
    break
  case 'reply':
    reply()
    break
  case 'watch':
    watch()
    break
  default:
    fail('use send, list, check, status, tidy, claim, reply or watch')
}
