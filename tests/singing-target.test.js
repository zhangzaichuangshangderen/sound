'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/singing/index.ts'), 'utf8')

test('音阶使用顺序目标，单音仍固定为起始音', () => {
  assert.match(source, /if \(this\.data\.mode !== 'scale'\) return rootMidi/)
  assert.match(source, /MAJOR_SCALE_OFFSETS\[this\.scaleProgress\.currentIndex\(\)\]/)
  assert.doesNotMatch(source, /closestTargetMidi/)
})

test('录音帧保存录制当时的目标供回放使用', () => {
  assert.match(source, /recordedPitchFrames\.push\(\{ at: recordedAt, frequency: detected, level: inputLevel, targetMidi \}\)/)
  assert.match(source, /const targetMidi = detectedFrame\.targetMidi/)
})
