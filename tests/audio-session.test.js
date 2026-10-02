'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createRecorderSession, createSequentialProgressTracker, normalizeBpm, prepareAudioContext } = require('../miniprogram/utils/audio-session')

function createRecorderMock() {
  const handlers = {}
  return {
    handlers,
    onStart(callback) { handlers.start = callback },
    onStop(callback) { handlers.stop = callback },
    onError(callback) { handlers.error = callback },
    onFrameRecorded(callback) { handlers.frame = callback },
    start(options) { handlers.startOptions = options },
    stop() {},
  }
}

test('录音管理器只注册一次监听，并把第二次录音交给最新页面', () => {
  const recorder = createRecorderMock()
  const session = createRecorderSession(recorder)
  const firstEvents = []
  const secondEvents = []
  const owner = (events) => ({
    handleRecorderStarted() { events.push('start') },
    handleRecorderStop() { events.push('stop') },
    handleRecorderError() { events.push('error') },
    handleAudioFrame(buffer) { events.push(buffer) },
  })
  const first = owner(firstEvents)
  const second = owner(secondEvents)

  session.attach(first)
  recorder.handlers.start()
  recorder.handlers.frame({ frameBuffer: 'first-track' })
  session.detach(first)
  session.attach(second)
  recorder.handlers.start()
  recorder.handlers.frame({ frameBuffer: 'second-track' })

  assert.deepEqual(firstEvents, ['start', 'first-track'])
  assert.deepEqual(secondEvents, ['start', 'second-track'])
  assert.deepEqual(Object.keys(recorder.handlers).sort(), ['error', 'frame', 'start', 'stop'])
})

test('已离开的录音页面不会再收到全局录音事件', () => {
  const recorder = createRecorderMock()
  const session = createRecorderSession(recorder)
  let starts = 0
  const owner = {
    handleRecorderStarted() { starts++ },
    handleRecorderStop() {},
    handleRecorderError() {},
    handleAudioFrame() {},
  }
  session.attach(owner)
  recorder.handlers.start()
  session.detach(owner)
  recorder.handlers.frame({ frameBuffer: 'stale-track' })
  recorder.handlers.stop()
  assert.equal(starts, 1)
})

test('同一个录音管理器在不同页面复用同一会话，避免重复注册监听', () => {
  const recorder = createRecorderMock()
  const firstSession = createRecorderSession(recorder)
  const secondSession = createRecorderSession(recorder)
  assert.equal(firstSession, secondSession)
  firstSession.attach({ handleRecorderStarted() {}, handleRecorderStop() {}, handleRecorderError() {}, handleAudioFrame() {} })
  assert.deepEqual(Object.keys(recorder.handlers).sort(), ['error', 'frame', 'start', 'stop'])
})

test('全局录音器停止前不允许新的页面并发启动，并在空闲后通知重试', () => {
  const recorder = createRecorderMock()
  const session = createRecorderSession(recorder)
  const first = { handleRecorderStarted() {}, handleRecorderStop() {}, handleRecorderError() {}, handleAudioFrame() {} }
  const second = { handleRecorderStarted() {}, handleRecorderStop() {}, handleRecorderError() {}, handleAudioFrame() {} }
  assert.equal(session.start(first, { format: 'mp3' }), true)
  assert.equal(session.isBusy(), true)
  assert.equal(session.start(second, { format: 'mp3' }), false)
  let becameIdle = false
  session.whenIdle(() => { becameIdle = true })
  recorder.handlers.stop({ tempFilePath: 'recording.mp3' })
  assert.equal(session.isBusy(), false)
  assert.equal(becameIdle, true)
  assert.equal(session.start(second, { format: 'mp3' }), true)
})

test('节拍器等待音频上下文恢复后才返回可播放状态', async () => {
  const events = []
  const context = {
    state: 'suspended',
    resume() {
      events.push('resume-start')
      return Promise.resolve().then(() => {
        context.state = 'running'
        events.push('resume-finished')
      })
    },
  }
  const ready = await prepareAudioContext(context, () => { throw new Error('不应重建上下文') })
  events.push('play')
  assert.equal(ready, context)
  assert.deepEqual(events, ['resume-start', 'resume-finished', 'play'])
})

test('关闭后的音频上下文会在下一次启动时重建', async () => {
  const closed = { state: 'closed' }
  const replacement = { state: 'running' }
  const ready = await prepareAudioContext(closed, () => replacement)
  assert.equal(ready, replacement)
})

test('连续启停时复用仍在运行的节拍器音频上下文', async () => {
  const context = { state: 'running' }
  let createCount = 0
  const first = await prepareAudioContext(context, () => { createCount++; return { state: 'running' } })
  const second = await prepareAudioContext(first, () => { createCount++; return { state: 'running' } })
  assert.equal(first, context)
  assert.equal(second, context)
  assert.equal(createCount, 0)
})

test('BPM 按 10 为单位并限制在 40 到 320', () => {
  assert.equal(normalizeBpm(39), 40)
  assert.equal(normalizeBpm(84), 80)
  assert.equal(normalizeBpm(86), 90)
  assert.equal(normalizeBpm(316), 320)
  assert.equal(normalizeBpm(500), 320)
})

test('音阶目标检测到有效音高后连续一段时间按顺序推进，不要求唱准', () => {
  const tracker = createSequentialProgressTracker(8, 500)
  assert.deepEqual(tracker.observe(true, 240), { index: 0, advanced: false, completed: false })
  assert.deepEqual(tracker.observe(false, 100), { index: 0, advanced: false, completed: false })
  assert.deepEqual(tracker.observe(true, 300), { index: 0, advanced: false, completed: false })
  assert.deepEqual(tracker.observe(true, 200), { index: 1, advanced: true, completed: false })
})

test('音阶目标完成最后一个音后不会越过末尾', () => {
  const tracker = createSequentialProgressTracker(2, 100)
  assert.deepEqual(tracker.observe(true, 100), { index: 1, advanced: true, completed: false })
  assert.deepEqual(tracker.observe(true, 100), { index: 1, advanced: false, completed: true })
  assert.deepEqual(tracker.observe(true, 100), { index: 1, advanced: false, completed: true })
})

test('音阶目标即使音准偏离也会顺序推进', () => {
  const tracker = createSequentialProgressTracker(2, 100)
  // true 表示检测到有效音高；这里不区分偏高、偏低或唱准。
  assert.deepEqual(tracker.observe(true, 100), { index: 1, advanced: true, completed: false })
})
