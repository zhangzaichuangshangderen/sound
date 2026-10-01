'use strict'

function createRecorderSession(recorder) {
  let activeOwner = null
  let recordingOwner = null
  let listenersBound = false

  function bindListeners() {
    if (listenersBound) return
    listenersBound = true
    recorder.onStart(() => {
      recordingOwner = activeOwner
      if (recordingOwner) recordingOwner.handleRecorderStarted()
    })
    recorder.onStop((result) => {
      const owner = recordingOwner
      recordingOwner = null
      if (owner) owner.handleRecorderStop(result)
    })
    recorder.onError((error) => {
      const owner = recordingOwner || activeOwner
      recordingOwner = null
      if (owner) owner.handleRecorderError(error)
    })
    recorder.onFrameRecorded((result) => {
      const owner = recordingOwner || activeOwner
      if (owner) owner.handleAudioFrame(result.frameBuffer)
    })
  }

  return {
    attach(owner) {
      bindListeners()
      activeOwner = owner
      return recorder
    },
    detach(owner) {
      if (activeOwner === owner) activeOwner = null
      if (recordingOwner === owner) recordingOwner = null
    },
  }
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

module.exports = { createRecorderSession, normalizeBpm, prepareAudioContext }
