'use strict'

const recorderSessions = new WeakMap()

function createRecorderSession(recorder) {
  const existingSession = recorderSessions.get(recorder)
  if (existingSession) return existingSession

  let activeOwner = null
  let recordingOwner = null
  let listenersBound = false
  let recorderState = 'idle'
  let idleCallbacks = []

  function notifyIdle() {
    const callbacks = idleCallbacks
    idleCallbacks = []
    callbacks.forEach((callback) => callback())
  }

  function bindListeners() {
    if (listenersBound) return
    listenersBound = true
    recorder.onStart(() => {
      recorderState = 'recording'
      recordingOwner = activeOwner
      if (recordingOwner) recordingOwner.handleRecorderStarted()
    })
    recorder.onStop((result) => {
      const owner = recordingOwner
      recordingOwner = null
      recorderState = 'idle'
      if (owner) owner.handleRecorderStop(result)
      notifyIdle()
    })
    recorder.onError((error) => {
      const owner = recordingOwner || activeOwner
      recordingOwner = null
      recorderState = 'idle'
      if (owner) owner.handleRecorderError(error)
      notifyIdle()
    })
    recorder.onFrameRecorded((result) => {
      const owner = recordingOwner || activeOwner
      if (owner) owner.handleAudioFrame(result.frameBuffer)
    })
  }

  const session = {
    attach(owner) {
      bindListeners()
      activeOwner = owner
      return recorder
    },
    detach(owner) {
      if (activeOwner === owner) activeOwner = null
      if (recordingOwner === owner) recordingOwner = null
    },
    isBusy() {
      return recorderState !== 'idle'
    },
    whenIdle(callback) {
      if (recorderState === 'idle') {
        callback()
        return
      }
      idleCallbacks.push(callback)
    },
    start(owner, options) {
      bindListeners()
      activeOwner = owner
      if (recorderState !== 'idle') return false
      recorderState = 'starting'
      try {
        recorder.start(options)
        return true
      } catch (error) {
        recorderState = 'idle'
        notifyIdle()
        throw error
      }
    },
  }
  recorderSessions.set(recorder, session)
  return session
}

function prepareAudioContext(currentContext, createContext) {
  let context = currentContext
  if (!context || context.state === 'closed') context = createContext()
  if (!context) return Promise.reject(new Error('当前环境不支持 WebAudio'))
  if (!context.resume || context.state === 'running') return Promise.resolve(context)
  return Promise.resolve(context.resume()).then(() => context)
}

function normalizeBpm(value) {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) return 80
  return Math.max(40, Math.min(320, Math.round(numericValue / 10) * 10))
}

function createSequentialProgressTracker(stepCount, holdMs) {
  const totalSteps = Math.max(1, Math.floor(Number(stepCount) || 1))
  const requiredHoldMs = Math.max(0, Number(holdMs) || 0)
  let index = 0
  let stableMs = 0
  let completed = false

  return {
    currentIndex() {
      return index
    },
    observe(inTune, durationMs) {
      if (completed) return { index, advanced: false, completed: true }
      if (!inTune) {
        stableMs = 0
        return { index, advanced: false, completed: false }
      }
      stableMs += Math.max(0, Number(durationMs) || 0)
      if (stableMs < requiredHoldMs) return { index, advanced: false, completed: false }
      stableMs = 0
      if (index < totalSteps - 1) {
        index++
        return { index, advanced: true, completed: false }
      }
      completed = true
      return { index, advanced: false, completed: true }
    },
    reset() {
      index = 0
      stableMs = 0
      completed = false
    },
  }
}

module.exports = { createRecorderSession, createSequentialProgressTracker, normalizeBpm, prepareAudioContext }
