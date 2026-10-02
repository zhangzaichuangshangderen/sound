'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/index/index.ts'), 'utf8')
const wxml = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/index/index.wxml'), 'utf8')

test('节拍器录音使用单声道 MP3，并限制为三分钟', () => {
  assert.match(source, /METRONOME_RECORD_MAX_DURATION_MS = 180000/)
  assert.match(source, /sampleRate: 44100, encodeBitRate: 96000, numberOfChannels: 1, format: 'mp3'/)
})

test('节拍器录音提供开始停止与回放操作，并在回放前停止节拍器', () => {
  assert.match(source, /toggleMetronomeRecording\(\)/)
  assert.match(source, /toggleMetronomeRecordingPlayback\(\)/)
  assert.match(source, /this\.stopMetronome\(\)\n\s*this\.destroyMetronomeRecordingPlayer\(\)/)
  assert.match(wxml, /bindtap="toggleMetronomeRecording"/)
  assert.match(wxml, /bindtap="toggleMetronomeRecordingPlayback"/)
})

test('录音仅在录音管理器确认启动后再启动节拍器，避免音频失败取消录音', () => {
  const recordingStart = source.slice(source.indexOf('beginMetronomeRecording()'), source.indexOf('handleRecorderStarted()'))
  const recorderStarted = source.slice(source.indexOf('handleRecorderStarted()'), source.indexOf('handleRecorderStop()'))
  assert.doesNotMatch(recordingStart, /this\.startMetronome\(\)/)
  assert.match(recorderStarted, /this\.startMetronome\(\)/)
})

test('节拍器优先使用本地 WAV 循环音轨，WebAudio 仅作降级', () => {
  assert.match(source, /prepareMetronomeLoopFile\(/)
  assert.match(source, /createInnerAudioContext\(\)/)
  assert.match(source, /startMetronomeLoopPlayer\(/)
  assert.match(source, /player\.onCanplay\(\(\) =>/)
  assert.match(source, /player\.loop = true/)
  assert.match(source, /obeyMuteSwitch: false/)
  assert.match(source, /metronomeSoundMode = 'webaudio'/)
})
